import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ptyPkg from 'node-pty';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { attachEnv } from './session-manager.js';
import { tmuxSocketArgs } from './tmux-socket.js';

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
// guard the append (each `set -ag` of the same entry grows the array unboundedly);
// running it per-attach — like ensurePtyHelperExecutable below — self-heals every
// socket (generated, legacy, default) and both agent + shell terminals without a
// restart. A tmux hiccup here only costs un-clickable links, never the attach.
function ensureHyperlinksFeature(tmuxBin, tmuxSocket) {
  try {
    const args = tmuxSocketArgs(tmuxSocket);
    const cur = execFileSync(tmuxBin, [...args, 'show', '-s', 'terminal-features'],
      { timeout: 2000, encoding: 'utf8' });
    if (/hyperlinks/.test(cur)) return;
    execFileSync(tmuxBin, [...args, 'set', '-ag', 'terminal-features', 'xterm*:hyperlinks'],
      { timeout: 2000, stdio: 'ignore' });
  } catch { /* leave links un-clickable rather than fail the attach */ }
}

// npm sometimes drops the execute bit when extracting node-pty's prebuilt
// `spawn-helper`, which makes every PTY spawn fail with "posix_spawnp failed".
// Restore it at startup AND before each attach: a reinstall against a long-lived
// server strips the bit out from under us, and re-running this idempotent guard
// per `/pty` connection lets attach self-heal without a restart.
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
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
    }
  } catch (err) {
    console.error('[pty helper]', err.message);
  }
}

// Stream a tmux attach to an xterm.js client over one /pty socket. Closing the
// socket detaches THIS client only (kills `tmux attach`, not the tmux session),
// so switching/re-attaching is cheap and browser+iTerm2 can co-attach.
// When `?terminalId=<id>` is present the connection is for a plain-shell terminal
// (from the terminal registry) rather than an agent session. On disconnect the
// shell tmux session is killed and removed from the registry.
export function attachPtyChannel(ws, req, { sessionManager, tmuxFor, socketFor, sessionFromGraph, terminalRegistry }) {
  let term;
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
    ensurePtyHelperExecutable();
    ensureHyperlinksFeature(sessionManager.tmuxBin, tmuxSocket);
    // `|| 120/32` would promote a transient 0 (fit ran before layout settled) to a
    // bogus default; take a query size only when it's a real positive count.
    const qCols = Number(searchParams.get('cols'));
    const qRows = Number(searchParams.get('rows'));
    term = ptySpawn(sessionManager.tmuxBin, [...tmuxSocketArgs(tmuxSocket), 'attach', '-t', tmuxTarget], {
      name: 'xterm-256color',
      cols: qCols > 0 ? qCols : 120,
      rows: qRows > 0 ? qRows : 32,
      cwd,
      env: attachEnv(process.env, tmuxDir),
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
  term.onData((d) => {
    if (ws.readyState === 1) ws.send(d);
  });
  term.onExit(() => ws.readyState === 1 && ws.close());
  ws.on('message', (raw) => {
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
  });
  // A fresh attach paints on its own, but force one repaint shortly after so a
  // same-size onopen re-assert (a node-pty no-op) still lands a clean screen.
  scheduleRefresh(200);
  // Detach this client when the socket closes. For shell terminals, kill the
  // backing tmux session and remove it from the registry so it doesn't linger.
  ws.on('close', () => {
    clearTimeout(refreshTimer);
    try { term.kill(); } catch { /* already gone */ }
    if (shellTermEntry) {
      const { terminalId, tmuxName, socket } = shellTermEntry;
      terminalRegistry?.remove(terminalId);
      exec(sessionManager.tmuxBin, [...tmuxSocketArgs(socket), 'kill-session', '-t', tmuxName]).catch(() => {});
    }
  });
}
