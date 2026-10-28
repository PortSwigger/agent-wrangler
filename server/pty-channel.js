import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ptyPkg from 'node-pty';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { attachEnv } from './session-manager.js';
import { gentleKill } from './tmux-gentle-kill.js';
import { tmuxSocketArgs } from './tmux-socket.js';
import { logError } from './log.js';
import { sendGuarded } from './ws-backpressure.js';

const exec = promisify(execFile);

const { spawn: ptySpawn } = ptyPkg;

// tmux DROPS OSC 8 hyperlinks from a client's output stream unless that client's
// terminal advertises the `hyperlinks` feature — and xterm-256color (what we attach
// as, below) does NOT by default. So an agent's OSC 8 links (friendly display text
// wrapping a hidden URL — e.g. Claude's "agent-wrangler#82: …" PR link) reach the
// browser as inert text with the URL stripped, and xterm's linkHandler never fires
// (a bare `https://…` printed as plain text is unaffected — it's not an escape, so it
// survives and WebLinksAddon linkifies it client-side; that's why "direct" links work
// but these don't). Advertise `hyperlinks` on the socket before attaching so the
// sequence survives to xterm. `terminal-features` is a persistent server-global, so
// guard the append (each `set -ag` of the same entry grows the array unboundedly).
//
// Asked asynchronously, and once per tmux server rather than per attach: a
// synchronous ask froze the event loop, and with it the board and every open
// terminal, for as long as a busy tmux took to answer. The setting lives as long as
// the server, so a socket's first attach, and its first after the server restarts,
// is the one that asks. Checking each attach's own socket still self-heals every
// socket (generated, legacy, default) and both agent + shell terminals without a
// restart. A tmux hiccup here only costs un-clickable links, never the attach, and
// the next attach asks again.
const hyperlinkAsks = new Map(); // socket name -> { id, asked } for the server last asked

// Which server is listening on `socket`, by its socket file: tmux(1) keeps it in
// $TMUX_TMPDIR (or /tmp)/tmux-<uid>/, and each new server binds a fresh one, so the
// inode and mtime change exactly when the server does. Null when unreadable; such a
// server is asked on every attach instead.
async function tmuxServerId(socket, env) {
  try {
    const st = await fs.promises.stat(path.join(env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, socket || 'default'));
    return `${st.ino}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

async function askForHyperlinks(tmuxBin, socket, env) {
  const args = tmuxSocketArgs(socket);
  const opts = { timeout: 2000, env };
  const { stdout } = await exec(tmuxBin, [...args, 'show', '-s', 'terminal-features'], opts);
  if (/hyperlinks/.test(stdout)) return;
  await exec(tmuxBin, [...args, 'set', '-ag', 'terminal-features', 'xterm*:hyperlinks'], opts);
}

// Resolves once that server has been asked; never rejects. Attaches that arrive
// while the ask is in flight share it.
async function ensureHyperlinksFeature(tmuxBin, socket, env) {
  const id = await tmuxServerId(socket, env);
  const known = hyperlinkAsks.get(socket);
  if (known && known.id === id) return known.asked;
  // Settles to whether later attaches may skip asking: only once a server we can
  // recognise again has answered.
  const asked = askForHyperlinks(tmuxBin, socket, env).then(() => id !== null, () => false);
  hyperlinkAsks.set(socket, { id, asked });
  asked.then((keep) => {
    if (!keep && hyperlinkAsks.get(socket)?.asked === asked) hyperlinkAsks.delete(socket);
  });
  return asked;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// npm sometimes drops the execute bit when extracting node-pty's prebuilt
// `spawn-helper`, which makes every PTY spawn fail with "posix_spawnp failed".
// Restore it at startup AND before each attach: a reinstall against a long-lived
// server strips the bit out from under us, and re-running this idempotent guard
// per `/pty` connection lets attach self-heal without a restart. Only an actually
// missing bit is chmodded: an install dir that is read-only (a Homebrew keg, a
// locked-down copy) would otherwise log a failure on every attach.
export function ensurePtyHelperExecutable() {
  try {
    const require = createRequire(import.meta.url);
    const pkgRoot = path.resolve(path.dirname(require.resolve('node-pty')), '..');
    // node-pty resolves `spawn-helper` from build/Release (source build) or
    // prebuilds/<platform>-<arch> (prebuilt download); chmod whichever exists.
    const candidates = [
      path.join(pkgRoot, 'build', 'Release', 'spawn-helper'),
      path.join(pkgRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    ];
    for (const helper of candidates) {
      if (fs.existsSync(helper) && !isExecutable(helper)) fs.chmodSync(helper, 0o755);
    }
  } catch (err) {
    logError('[pty helper]', err.message);
  }
}

// Stream a tmux attach to an xterm.js client over one /pty socket. Closing the
// socket detaches THIS client only (kills `tmux attach`, not the tmux session),
// so switching/re-attaching is cheap and browser+iTerm2 can co-attach.
// When `?terminalId=<id>` is present the connection is for a plain-shell terminal
// (from the terminal registry) rather than an agent session. On disconnect the
// shell tmux session is killed and removed from the registry.
export async function attachPtyChannel(ws, req, { sessionManager, tmuxFor, socketFor, sessionFromGraph, terminalRegistry }) {
  let term;
  let closed = false;
  let shellTermEntry = null; // set when this is a shell-terminal connection
  // Force a full repaint of THIS tmux client (its pts/tty is the tmux client
  // name). tmux repaints on attach/resize on its own, but a same-size re-assert
  // (the client's onopen sync) is a node-pty no-op that skips the repaint, and a
  // client desyncs if the size it last reported drifts from what xterm renders.
  // Refreshing after attach and after each resize makes that a recoverable blip.
  let refreshTimer = null;
  let refreshClient = () => {};
  const scheduleRefresh = (delay) => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refreshClient(), delay);
  };
  const onMessage = (raw) => {
    const s = raw.toString();
    if (s.startsWith('{')) {
      try {
        const m = JSON.parse(s);
        if (m.type === 'resize') {
          // Always swallow a resize frame (never echo it as input); act only on
          // real positive dims, and force a repaint after the reflow settles so
          // the screen resyncs even when the size was unchanged.
          if (m.cols > 0 && m.rows > 0) {
            term.resize(m.cols, m.rows);
            scheduleRefresh(50);
          }
          return;
        }
      } catch {
        /* not a control frame — treat as input */
      }
    }
    term.write(s);
  };
  // Listen before tmux is asked about hyperlinks below, which can take a while: a
  // close in that window calls the attach off, and what the client sends in it (its
  // open-time resize, early keystrokes) waits in `early` for the pty.
  const early = [];
  ws.on('message', (raw) => (term ? onMessage(raw) : early.push(raw)));
  // Detach this client when the socket closes. For shell terminals, kill the
  // backing tmux session and remove it from the registry so it doesn't linger.
  ws.on('close', () => {
    closed = true;
    clearTimeout(refreshTimer);
    try { term?.kill(); } catch { /* already gone */ }
    if (shellTermEntry) {
      const { terminalId, tmuxName, socket } = shellTermEntry;
      terminalRegistry?.remove(terminalId);
      gentleKill((a) => exec(sessionManager.tmuxBin, [...tmuxSocketArgs(socket), ...a]), { session: tmuxName }).catch(() => {});
    }
  });
  try {
    const { searchParams } = new URL(req.url, 'http://localhost');
    const terminalId = searchParams.get('terminalId');
    let tmuxTarget, tmuxSocket, cwd;

    if (terminalId) {
      const reg = terminalRegistry?.get(terminalId);
      if (!reg) {
        ws.send('\r\n\x1b[33m[no shell terminal found for this id]\x1b[0m\r\n');
        ws.close();
        return;
      }
      shellTermEntry = { terminalId, tmuxName: reg.tmuxName, socket: reg.socket };
      tmuxTarget = reg.tmuxName;
      tmuxSocket = reg.socket;
      cwd = [reg.cwd].find((d) => d && fs.existsSync(d)) || process.cwd();
    } else {
      const sessionId = searchParams.get('sessionId');
      tmuxTarget = tmuxFor(sessionId);
      if (!tmuxTarget) {
        ws.send('\r\n\x1b[33m[no attachable terminal — no live tmux session found]\x1b[0m\r\n');
        ws.close();
        return;
      }
      tmuxSocket = socketFor(sessionId);
      const graphCwd = sessionFromGraph(sessionId)?.cwd;
      const entry = sessionManager.entryFor(sessionId);
      cwd = [graphCwd, entry?.cwd].find((d) => d && fs.existsSync(d)) || process.cwd();
    }

    const tmuxDir = path.dirname(sessionManager.tmuxBin);
    const env = attachEnv(process.env, tmuxDir);
    ensurePtyHelperExecutable();
    await ensureHyperlinksFeature(sessionManager.tmuxBin, tmuxSocket, env);
    // The client left while tmux answered: an attach now would have no one to read it.
    if (closed) return;
    // `|| 120/32` would promote a transient 0 (fit ran before layout settled) to a
    // bogus default; take a query size only when it's a real positive count.
    const qCols = Number(searchParams.get('cols'));
    const qRows = Number(searchParams.get('rows'));
    term = ptySpawn(sessionManager.tmuxBin, [...tmuxSocketArgs(tmuxSocket), 'attach', '-t', tmuxTarget], {
      name: 'xterm-256color',
      cols: qCols > 0 ? qCols : 120,
      rows: qRows > 0 ? qRows : 32,
      cwd,
      env,
    });
    const tmuxBin = sessionManager.tmuxBin;
    refreshClient = () => {
      const client = term?.ptsName;
      if (!client) return;
      try {
        execFile(tmuxBin, [...tmuxSocketArgs(tmuxSocket), 'refresh-client', '-t', client], () => {});
      } catch {
        /* tmux gone — the socket close tears this down */
      }
    };
  } catch (err) {
    try {
      ws.send(`\r\n\x1b[31m[failed to attach terminal: ${String(err.message || err)}]\x1b[0m\r\n`);
      ws.close();
    } catch {
      /* socket already gone */
    }
    return;
  }
  // Same unbounded-queue hazard as the control broadcast (ws-backpressure.js): a
  // browser that stops reading stays OPEN, and a chatty pane can outrun it by
  // megabytes a second with no backstop but our own heap. Drop such a viewer —
  // closing a /pty socket detaches that one client and never touches the tmux
  // session, so reattaching costs nothing and loses nothing.
  term.onData((d) => { sendGuarded(ws, d); });
  term.onExit(() => ws.readyState === 1 && ws.close());
  // A fresh attach paints on its own, but force one repaint shortly after so a
  // same-size onopen re-assert (a node-pty no-op) still lands a clean screen.
  scheduleRefresh(200);
  for (const raw of early.splice(0)) onMessage(raw);
}
