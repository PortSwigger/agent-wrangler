import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isOwnedTmux, adapterForProcess, adapterForContainerProcess } from './agents/index.js';
import { tmuxSocketArgs } from './tmux-socket.js';
import { paneComposerIsEmpty } from './ghost-suggestion.js';

const exec = promisify(execFile);

let TMUX = 'tmux';
export function setTmuxBin(bin) {
  TMUX = bin || 'tmux';
}

// Run tmux on a specific socket (`-L <socket>`, or the default socket when the
// name is empty/absent). The socket is per-session: an install's generated socket
// for its own sessions, '' for legacy default-socket ones.
function tmux(socket, args, opts) {
  return exec(TMUX, [...tmuxSocketArgs(socket), ...args], opts);
}

export function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI sequences
    .replace(/[\x00-\x08\x0b-\x1f]/g, '');
}

// All panes across every tmux session, with the pane's leaf pid, cwd, the tmux
// pane id + window index (so a specific pane can be captured/targeted — a session
// running an agent team has >1 pane), and the pane_title (Claude writes its live
// status+summary there via an OSC sequence). pane_title is the only field that
// can itself contain '|', so it goes last and the remainder is rejoined; pane_id
// (`%N`) and window_index are '|'-free, so they take fixed slots before it.
const PANE_FORMAT = '#{session_name}|#{pane_pid}|#{pane_current_path}|#{pane_id}|#{window_index}|#{pane_title}';

// Parse one PANE_FORMAT line. pane_title is last and rejoined because it's the
// only field that can itself contain '|'; every earlier field (incl. pane_id
// `%N` and the window index) is '|'-free, so they take fixed leading slots.
export function parsePaneLine(line) {
  const [name, pid, cwd, paneId, windowIndex, ...title] = line.split('|');
  return { name, panePid: Number(pid), cwd, paneId, windowIndex, paneTitle: title.join('|') };
}

async function listClaudePanes(socket) {
  try {
    const { stdout } = await tmux(socket, ['list-panes', '-a', '-F', PANE_FORMAT]);
    return stdout.trim().split('\n').filter(Boolean).map(parsePaneLine);
  } catch {
    return [];
  }
}

// Claude sets its terminal title to "<status-glyph> <summary>" — the glyph is a
// live spinner (✳ when idle, rotating frames while working) and tmux records the
// whole thing as the pane_title. Return the bare summary, stripping the leading
// glyph run so the label is stable as the spinner cycles. Returns null when the
// title isn't Claude's: tmux's default pane_title is the hostname, which starts
// with a letter, so requiring a leading glyph keeps hostnames out of the label.
export function claudeTitle(paneTitle) {
  const raw = (paneTitle || '').trim();
  if (!/^[^\p{L}\p{N}\s]/u.test(raw)) return null;
  return raw.replace(/^[^\p{L}\p{N}]+/u, '').trim() || null;
}

// Build a pid -> {ppid, command} forest from a single `ps` call.
async function processTree() {
  const children = new Map();
  const cmd = new Map();
  try {
    const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,command=']);
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      cmd.set(pid, m[3]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }
  } catch {
    /* ps failed */
  }
  return { children, cmd };
}

// Walk a pane's process subtree to find an agent pid, if any → { pid, agent }.
// Checks the executable matcher first (a plain host agent process), then the
// container-exec matcher (a devcontainer/docker exec wrapping the agent as an
// argument) — a host command never has the wrapper, so this is additive, never
// a behaviour change for host sessions. Exported for unit testing.
export function findAgentPid(startPid, tree) {
  const queue = [startPid];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const cmd = tree.cmd.get(pid) || '';
    const adapter = adapterForProcess(cmd) || adapterForContainerProcess(cmd);
    if (adapter) return { pid, agent: adapter.id };
    for (const child of tree.children.get(pid) || []) queue.push(child);
  }
  return null;
}

// Every agent-running tmux pane across the given sockets, each tagged with the
// socket it was found on → { tmuxName, socket, claudePid, agent, cwd, command,
// paneId, windowIndex, paneTitle }. list-panes -a yields one entry PER PANE, so
// a session hosting an agent team surfaces once per member pane; paneId lets a
// caller capture/target an individual member. The process tree is socket-
// independent, so it's read once and shared.
export async function discoverClaudeSessions(sockets = [''], excludeNames = new Set()) {
  const tree = await processTree();
  const out = [];
  for (const socket of sockets) {
    const panes = await listClaudePanes(socket);
    for (const pane of panes) {
      if (excludeNames.has(pane.name)) continue;
      const hit = findAgentPid(pane.panePid, tree);
      if (hit) out.push({ tmuxName: pane.name, socket, claudePid: hit.pid, agent: hit.agent, cwd: pane.cwd, command: tree.cmd.get(hit.pid) || '', paneId: pane.paneId, windowIndex: pane.windowIndex, paneTitle: pane.paneTitle });
    }
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Does this `claude` command line own the given session? Matches the id as a
// whole token after `--session-id` (the original) or `--resume` (a fork) — a
// fork's command keeps the *original* id, so this catches both, regardless of
// what mappings.json currently records.
function commandRefsSession(command, ownerId) {
  const id = escapeRegExp(ownerId);
  return new RegExp(`(?:--(?:session-id|resume)[=\\s]+|\\b(?:resume|fork)\\s+)${id}(?:\\s|$)`).test(command);
}

// Every wrangler-owned (`cc_`) tmux currently running this session — the
// original *and* any resume forks of it. The reliable kill target: the recorded
// mapping name can drift from the tmux actually hosting the process, so teardown
// scans by what's running rather than trusting the record. Foreign (non-`cc_`)
// tmuxes are never returned — we don't reap sessions we didn't launch.
//
// `claimedByOthers` excludes tmuxes that are the recorded home of a *different*
// board id: a deliberate fork runs `claude --resume <parent> --fork-session`, so
// its command is indistinguishable from a resume-fork of the parent — but it's a
// separate session that must survive the parent's teardown. The owning mapping is
// the only thing that tells them apart, so the caller passes those names here.
export function tmuxesForSession(discovered, ownerId, { claimedByOthers } = {}) {
  if (!ownerId) return [];
  return discovered
    .filter((d) => isOwnedTmux(d.tmuxName) && commandRefsSession(d.command || '', ownerId))
    .filter((d) => !claimedByOthers?.has(d.tmuxName))
    .map((d) => d.tmuxName);
}

export async function capturePane(name, lines = 60, socket = '') {
  try {
    const { stdout } = await tmux(socket, ['capture-pane', '-t', name, '-p', '-S', `-${lines}`], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return '';
  }
}

// capture-pane WITH escape sequences, and only the last few lines. Separate from
// capturePane above on purpose: every existing caller feeds plain text to
// stripAnsi/classify, and switching the shared helper to -e would push escapes
// into all of them. The escapes are the entire point here — parseGhostSuggestion
// (ghost-suggestion.js) tells a suggestion from typed text by the faint
// attribute, and cannot do its job without them. Defaults to 6 lines because the
// only thing it reads is the composer.
export async function capturePaneStyled(name, lines = 6, socket = '') {
  try {
    const { stdout } = await tmux(socket, ['capture-pane', '-t', name, '-p', '-e', '-S', `-${lines}`], {
      maxBuffer: 256 * 1024,
    });
    return stdout;
  } catch {
    return '';
  }
}

// Derive live state from the pane: only the "esc to interrupt" working signal
// vs idle. The "needs you" (waiting) state comes from Claude's own session
// file (status: 'waiting'), not from scraping the pane — pane scraping produced
// false positives (e.g. a newline in the prompt looked like a selection menu).
export function classify(paneText) {
  const recent = stripAnsi(paneText).split('\n').filter((l) => l.trim()).slice(-12).join('\n');
  if (/esc to interrupt/i.test(recent)) return { status: 'working' };
  // Verified against the real fresh-container login flow (Group G E2E capture):
  // the method-picker ("Select login method: 1. Claude account with
  // subscription…"), the OAuth URL screen (claude.com/cai/oauth/authorize,
  // "Browser didn't open? … to sign in"), and the code-paste prompt ("Paste
  // code here if prompted"). A fresh devcontainer has no credentials, so the
  // first launch parks on one of these awaiting the user — this must read as
  // non-idle or the idle-timer suspend gate reaps it.
  if (/oauth\/authorize|select login method|paste code here if prompted/i.test(recent)) return { status: 'needs-you' };
  // A COLD devcontainer dispatch runs `devcontainer up` + postCreateCommand (1-2 min)
  // in the pane before claude starts. That window shows CLI/build output, not claude,
  // so without this it reads as idle and the suspend gate could reap it; surface it as
  // working with a hint instead (the bring-up marker is Group-E-verified: the CLI prints
  // "Running the postCreateCommand from devcontainer.json..." during postCreate). A fatal
  // `up` failure usually aborts the && chain FAST → a dead pane, whose error the dormant
  // path already surfaces via exitOutput ("An error occurred setting up the container." /
  // "Command failed: docker pull ..." — Group-E-captured); this failure branch is the
  // best-effort catch for the narrower window where the pane is still alive when the
  // error text lands, keyed on the CLI's canonical failure line.
  if (/devcontainer up failed|an error occurred setting up the container|error:.*container|failed to (build|start|create).*container/i.test(recent)) {
    return { status: 'needs-you', waitingFor: 'container bring-up failed' };
  }
  if (/running the postcreatecommand|resolving feature dependencies|\[\+\]\s+(building|running)/i.test(recent)) {
    return { status: 'working', waitingFor: 'starting container' };
  }
  return { status: 'idle' };
}

// Each CLI renders its own footer text for "a background/async job is still
// running", so detection is keyed by agent id. Claude's requires a LEADING
// middot (so it can't collide with an unrelated "Running N shell command…"
// tool-call line elsewhere in the scrollback, which has no middot at all) but
// deliberately does NOT require a trailing one: the footer is the last thing on
// its line, so a narrow pane truncates it — verified against a real capture,
// the trailing-middot form silently stopped matching once the pane was
// narrower than the full "· N shell(s) · …" segment, while requiring only the
// leading middot survives down to the word "shell(s)" itself being cut.
// Codex's "N background terminal(s) running · /ps to view · /stop to close" is
// distinctive enough on its own (verified against a real `codex` session).
// Killing the pane kills these jobs regardless of agent; only Claude's CLI
// surfaces an ambiguous message about it on the next resume ("No completion
// record was found") — Codex degrades gracefully instead — but both leave the
// job dead all the same, so both are worth the same suspend/archive caution.
const BACKGROUND_SHELL_PATTERNS = {
  claude: /·\s*\d+\s+shells?\b/,
  codex: /\d+\s+background terminals?\s+running/i,
};

// The model named in the TUI's own status bar — the ONLY live source for it.
// A `/model` switch is not recorded in the transcript at all (verified: the line
// types written are the command's own plumbing, none carrying a model), so the
// board's `modelPill` — derived from the last assistant message's `message.model`
// — keeps reporting the OLD model until the next turn actually runs. That made
// the chat view's chip contradict the pane sitting next to it.
//
// The status bar looks like `◆ Sonnet 5 | ███░░ 7% | 📅 $96 | Σ $977 | 📁 dir`.
// Identified by the context meter's percentage next to a pipe rather than by
// position, so it is not confused with conversation text, and the LAST match
// wins because the bar is at the bottom. The leading glyph varies (✦, ◆) so it
// is stripped as "everything before the first letter or digit" rather than
// matched against a list that a new glyph would silently break.
export function paneModelLabel(paneText) {
  if (typeof paneText !== 'string') return null;
  const line = stripAnsi(paneText).split('\n').filter((l) => /\|/.test(l) && /\d+%/.test(l)).pop();
  if (!line) return null;
  const first = line.slice(0, line.indexOf('|'));
  const label = first.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  // Bounded, and rejected outright if it is not the shape of a model name — a
  // wrong label here would misreport live state, so no label beats a bad one.
  return label && label.length <= 40 ? label : null;
}

export function hasBackgroundShell(paneText, agent = 'claude') {
  const pattern = BACKGROUND_SHELL_PATTERNS[agent];
  if (!pattern) return false;
  const recent = stripAnsi(paneText).split('\n').filter((l) => l.trim()).slice(-12).join('\n');
  return pattern.test(recent);
}

// Send literal keys / named keys (e.g. "Enter", "Up", "2") to a session.
export async function sendKeys(name, keys, socket = '') {
  await tmux(socket, ['send-keys', '-t', name, ...keys]);
}

// Deliver a (possibly multi-line) block into a pane via tmux's paste buffer, WITHOUT
// submitting it (no Enter). Using the buffer — not `send-keys -l` — is what makes it
// safe for the review-first prefill: send-keys injects embedded newlines literally, so
// a TUI treats the first newline as Enter and submits early, and a leading `-` gets
// misparsed as a tmux flag.
//
// `-p` (BRACKETED paste) is load-bearing and must not be dropped — the buffer alone is
// NOT enough. Measured against tmux + a real Claude TUI: `paste-buffer` without `-p`
// puts a literal CR on the pty for every newline, so the TUI submits at the first one
// and treats each following line as a separate queued message. A three-line prompt
// landed in the transcript as two user messages; with `-p` the identical text landed as
// ONE user message with its newlines intact (31-line paste verified too — full text,
// never the TUI's `[Pasted text #N]` display placeholder). tmux only emits the
// ESC[200~/ESC[201~ wrapper when the pane's app has enabled bracketed paste, so `-p` is
// a no-op — byte-for-byte the old behaviour — against anything that hasn't (verified
// against a plain `cat`), which is why it is safe to apply unconditionally rather than
// per agent. Ordering keeps sendText's trailing Enter a submit and not a swallowed
// newline: the end marker precedes it on the same byte stream.
async function pasteBlock(name, text, socket = '', run = tmux) {
  const tmpFile = path.join(os.tmpdir(), `cm-${crypto.randomBytes(5).toString('hex')}.txt`);
  const buf = `cm${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmpFile, text, 'utf8');
  try {
    await run(socket, ['load-buffer', '-b', buf, tmpFile]);
    await run(socket, ['paste-buffer', '-p', '-b', buf, '-t', name]);
    await run(socket, ['delete-buffer', '-b', buf]).catch(() => {});
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

// Empty the pane's composer, and CONFIRM it rather than assuming.
//
// Why this is needed at all: interrupting a turn makes Claude Code restore the
// interrupted prompt into its OWN composer. Verified against a live pane — and it
// is length-dependent, which is what makes it so easy to miss: a 72-character
// prompt was not restored, a 281-character one was. Every paste from the chat view
// lands at the cursor, so a restored prompt silently fuses with whatever is pasted
// next and the agent receives ONE concatenated prompt (the exact reported bug:
// "…count from 1 to 40.OK, I am running the toolbox now…").
//
// Ctrl+U kills to the start of the line, so a multi-line draft needs one press per
// line — hence a bounded loop that re-reads the pane instead of a fixed number of
// presses. `capture-pane -e` is required: paneComposerIsEmpty has to tell faint
// ghost text (not content, and replaced by a paste anyway) from something typed,
// and it fails safe by reporting NOT empty when it cannot tell. Returns true only
// on a confirmed-empty composer, so a caller can decide what to do when the pane
// will not come clean rather than pasting into it blind.
export async function clearComposer(name, socket = '', { capture = capturePaneStyled, run = tmux, maxPresses = 12 } = {}) {
  for (let i = 0; i <= maxPresses; i += 1) {
    if (paneComposerIsEmpty(await capture(name, 6, socket))) return true;
    await run(socket, ['send-keys', '-t', name, 'C-u']);
    // The TUI redraws asynchronously, so re-reading immediately would judge the
    // previous frame and burn the whole budget in a few milliseconds.
    await new Promise((r) => setTimeout(r, 60));
  }
  return paneComposerIsEmpty(await capture(name, 6, socket));
}

// Prefill a pane's input with text but DON'T submit it — no Enter, so a human reviews
// and hits Enter themselves. Contrast sendText, which pastes + Enter. Delivered as a
// single paste block (see pasteBlock) so a multi-line note is never auto-submitted at
// its first newline. Used to deliver a snooze note into a woken session for review.
export async function prefillPane(name, text, socket = '', run = tmux) {
  await pasteBlock(name, text, socket, run);
}

// The pane's current title. Claude writes "<status-glyph> <summary>" here via OSC
// once it has booted (claudeTitle rejects tmux's default hostname title), so this
// is the readiness signal a post-resume prefill waits on. Empty on failure.
export async function paneTitle(name, socket = '') {
  try {
    const { stdout } = await tmux(socket, ['display-message', '-p', '-t', name, '#{pane_title}']);
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function killSession(name, socket = '') {
  await tmux(socket, ['kill-session', '-t', name]);
}

// Deliver a (possibly multi-line) follow-up message via the paste buffer (avoids the
// shell-escaping pitfalls of `send-keys -l`) AND submit it with a trailing Enter.
// Shares the paste-block mechanism with prefillPane, which omits the Enter. `run` is
// the low-level tmux runner (test seam).
export async function sendText(name, text, socket = '', run = tmux) {
  await pasteBlock(name, text, socket, run);
  await new Promise((r) => setTimeout(r, 120));
  await run(socket, ['send-keys', '-t', name, 'Enter']);
}
