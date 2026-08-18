#!/usr/bin/env node
import os from 'node:os';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import openModule from 'open';

import { buildGraph, createWatcher, sessionLabel } from './state-reader.js';
import { analyze } from './transcript-reader.js';
import { SessionManager, SESSIONS_DIR } from './session-manager.js';
import { worktreeStatus } from './worktree.js';
import { TaskStore } from './task-store.js';
import { MemoryStore } from './memory-store.js';
import { ScheduleStore } from './schedule-store.js';
import { MailboxStore } from './mailbox-store.js';
import { createMailSettleSweeper } from './mail-runner.js';
import { runDispatch } from './dispatch-runner.js';
import { runSessionAction } from './session-action-runner.js';
import { deliverPrNudge } from './pr-nudge-runner.js';
import { createSnoozeWakeSweeper } from './snooze-wake-runner.js';
import { createFullSweepGuard } from './poll-guard.js';
import { diffNeedsYou, diffCheckStatus, planCheckTransition, prPaneNudge, diffDirty, planDirtyTransition, prDirtyPaneNudge, prPaneLine, diffUnresolvedComments, planUnresolvedTransition, prUnresolvedPaneNudge } from './notifier.js';
import { setTmuxBin, sendText } from './tmux-scraper.js';
import { fetchPrStatus, mergePr, fetchUnresolvedThreadCount } from './pr-status.js';
import { normalisePr, linkMatches } from './mcp/links.js';
import { shouldOpenBrowser, jiraBaseUrl, prStatusPollSeconds, autoAttachPrEnabled, taskMemoryEnabled, subagentsExpandedByDefault, trustCodexLaunchCwd, childFullViewByDefault, readConfig } from './config-store.js';
import { listStyles } from './styles.js';
import { availableAgents, modelsWithDefault, validateDefaultModel } from './agents/index.js';
import { createMcpRequestHandler, extractCaller } from './mcp/server.js';
import { createMessageThrottle } from './mcp/message-throttle.js';
import { bindHost } from './runtime.js';
import { isAllowedOrigin, isAllowedHost } from './origin-check.js';
import { createHttpServer } from './http-handler.js';
import { resolveMarkdownPath } from './file-preview.js';
import { attachPtyChannel, ensurePtyHelperExecutable } from './pty-channel.js';
import { TerminalRegistry } from './terminal-registry.js';
import { createShellSession } from './shell-session.js';
import { createTargets } from './control/targets.js';
import { routeControlMessage } from './control/router.js';
import { acquireInstanceLock, InstanceLockError } from './instance-lock.js';
import { devShutdownConfig, devShutdownDecision } from './dev-shutdown.js';
import { DATA_DIR } from './data-dir.js';
import { scanAllDaily } from './usage-report.js';
import { startFdWatchdog } from './fd-watchdog.js';

const open = openModule.default || openModule;

const PORT = Number(process.env.AW_PORT) || Number(process.env.PORT) || 7878;
const HOST = bindHost();

// Last-resort guards: a single bad PTY/AppleScript/parse must never take the
// whole dashboard down. Log and keep serving.
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

ensurePtyHelperExecutable();

const sessionManager = new SessionManager();
const taskStore = new TaskStore();
const memoryStore = new MemoryStore();
const scheduleStore = new ScheduleStore();
const mailStore = new MailboxStore();
const terminalRegistry = new TerminalRegistry();

// A one-off missed during downtime fires once when overdue, UNLESS it's older than
// this — a long-down server must not fire a stale one-off. A recurring slot never
// backlogs (markFired advances strictly past now), so this only guards one-offs.
// A const here, where fireDueSchedules makes the staleness call — tunable later.
const STALE_MS = 12 * 60 * 60 * 1000;

let lastGraph = null;
const { sessionFromGraph, tmuxFor, socketFor } = createTargets(sessionManager, () => lastGraph);

// Current fd-watchdog alert, or null when clear — sent to any client that
// connects (or reconnects/reloads) while it's active, since a WS broadcast alone
// only reaches tabs already open at the moment it fires.
let fdWarning = null;

// When the last control client was connected/active — drives the dev-instance
// idle self-shutdown. Seeded to start time so a dev server launched and never
// driven still reaps itself once the window elapses.
let lastControlActivity = Date.now();

// Poll GitHub for every pr link on the board: auto-remove a link whose PR is
// now MERGED/CLOSED, else write its check status back onto the owning store, and
// rebuild if anything changed. Fetches sequentially (a handful of PRs) to avoid a
// burst of gh processes. Never throws. `only` limits the sweep to one owner (the
// on-attach fast path).
//
// The full sweep is re-entrancy-guarded (see createFullSweepGuard): overlapping ticks
// would each reassign diffCheckStatus's baseline and could re-fire a transition into a
// duplicate wake/resume. A targeted poll (`only` set) is never guarded — it must not be
// starved by a long full sweep and never runs the transition diff below.
const pollPrStatuses = createFullSweepGuard(runPrStatusSweep);

async function runPrStatusSweep(only) {
  const links = [
    ...taskStore.prLinks().map((l) => ({ ...l, scope: 'task' })),
    ...sessionManager.prLinks().map((l) => ({ ...l, scope: 'session' })),
  ].filter((l) => !only || (l.scope === only.scope && l.ownerId === only.ownerId));
  let changed = false;
  for (const { scope, ownerId, url, number, unresolvedCount: prevUnresolvedCount } of links) {
    const res = await fetchPrStatus(url);
    if (res == null) continue;
    const store = scope === 'task' ? taskStore : sessionManager;
    // A merged/closed PR is dead: drop its link automatically (any pr link,
    // however it was attached). Nudge a live owning session's pane, like the
    // checks notifier; a dormant session or task-scope link is silent.
    if (res.state === 'MERGED' || res.state === 'CLOSED') {
      if (removePrLink(store, ownerId, url)) {
        changed = true;
        if (scope === 'session') {
          const target = tmuxFor(ownerId);
          if (target) {
            const phrase = `${res.state === 'MERGED' ? 'merged' : 'closed'} — link removed`;
            sendText(target, prPaneLine(number, url, phrase), socketFor(ownerId)).catch(() => {});
          }
        }
      }
      continue;
    }
    // A second gh call, sequenced right after the first (still a handful of PRs
    // per sweep). On failure fall back to the link's existing stored count
    // rather than clobbering it with null — a transient gh hiccup must not look
    // like every thread just got resolved.
    const unresolvedCount = (await fetchUnresolvedThreadCount(url)) ?? prevUnresolvedCount;
    const at = new Date().toISOString();
    if (store.updateLinkStatus(ownerId, url, res.checkStatus, res.dirty, at, unresolvedCount)) changed = true;
  }
  // Detect check-status transitions only on the full sweep (the on-attach fast
  // path skips other links, so its baseline would be incomplete and re-fire).
  if (!only) {
    const current = [
      ...taskStore.prLinks().map((l) => ({ ...l, scope: 'task' })),
      ...sessionManager.prLinks().map((l) => ({ ...l, scope: 'session' })),
    ];
    // Collected so the unresolved-comment loop below can skip its OWN pane
    // nudge for any link that just got a checkStatus nudge this same tick (see
    // that loop for why: a "Request changes" review with inline comments fires
    // both diffs in the same sweep, and two unawaited deliverPrNudge calls to
    // one pane would interleave — the same hazard planCheckTransition's merge
    // branch already guards against for merge-vs-nudge).
    const checkStatusKeys = new Set();
    for (const ev of diffCheckStatus(current)) {
      checkStatusKeys.add(`${ev.scope}:${ev.ownerId}:${ev.url}`);
      broadcast({ type: 'pr-checks', scope: ev.scope, sessionId: ev.ownerId,
                  url: ev.url, number: ev.number, status: ev.checkStatus });
      const entry = sessionManager.entryFor(ev.ownerId);
      // The two gated decisions (auto-merge / pane-nudge) live in the pure
      // planCheckTransition (notifier.js, unit-tested matrix); all the I/O stays
      // here. The nudge now WAKES a dormant/suspended session (deliverPrNudge) so it
      // behaves like an idle-but-live one; the auto-merge confirmation line below
      // stays board-only when dormant (terminal/informational — not expanded here).
      const { merge: willMerge, nudge } = planCheckTransition(ev, entry);
      if (nudge) {
        // A live session gets the nudge in its pane; a DORMANT one (entry, no tmux)
        // is woken and handed the SAME nudge as its resume intent — dormancy is only
        // a RAM optimization, so it behaves like an idle-but-live session. Archived/
        // gone owners are board-toast-only (deliverPrNudge's archived guard). Fire-
        // and-forget so concurrent wakes for the same card (same-owner PRs in one
        // sweep, or a racing manual Resume) all reach resume()'s coalescing: the first
        // OWNS the relaunch (intent carries its nudge), each joiner delivers its own
        // nudge via a post-resume sendText fallback — so no nudge is dropped (see
        // deliverPrNudge). Rebuild only on a genuine 'dormant' wake so the woken card
        // flips live promptly; an 'error' (resume failed) surfaces via onPrWakeError
        // and must NOT rebuild.
        deliverPrNudge(ev, entry, {
          message: prPaneNudge(ev), tmuxFor, socketFor, sendText,
          sessionManager, memoryStore, taskStore, onError: onPrWakeError,
        }).then((mode) => (mode === 'dormant' ? rebuild() : undefined)).catch(() => {});
      }
      // A successful merge leaves the MERGED-state path (next poll) to remove the
      // link and nudge "merged"; either way we report the outcome now (board
      // toast + a live pane line).
      if (willMerge) {
        const res = await mergePr(ev.url);
        const target = tmuxFor(ev.ownerId);
        broadcast({ type: 'pr-merge', scope: ev.scope, sessionId: ev.ownerId,
                    url: ev.url, number: ev.number, ok: res.ok, error: res.ok ? null : res.error });
        if (target) {
          const phrase = res.ok ? 'auto-merged' : `auto-merge failed: ${res.error}`;
          sendText(target, prPaneLine(ev.number, ev.url, phrase), socketFor(ev.ownerId)).catch(() => {});
        }
      }
    }
    // Detect dirty (merge-conflict) transitions — own diff/baseline from
    // diffCheckStatus (notifier.js) since dirty is orthogonal to checkStatus.
    // Same board-toast-always / pane-nudge-gated shape as the checks transition
    // above; there is no auto-merge branch (a DIRTY PR can't be merged).
    for (const ev of diffDirty(current)) {
      broadcast({ type: 'pr-dirty', scope: ev.scope, sessionId: ev.ownerId, url: ev.url, number: ev.number });
      const entry = sessionManager.entryFor(ev.ownerId);
      if (planDirtyTransition(ev, entry)) {
        deliverPrNudge(ev, entry, {
          message: prDirtyPaneNudge(ev), tmuxFor, socketFor, sendText,
          sessionManager, memoryStore, taskStore, onError: onPrWakeError,
        }).then((mode) => (mode === 'dormant' ? rebuild() : undefined)).catch(() => {});
      }
    }
    // Detect unresolved review-thread-count increases — own diff/baseline,
    // independent of checkStatus/dirty (an unbounded counter, not an enum/bool).
    // Same board-toast-always / pane-nudge-gated shape as the dirty transition
    // above; there is no auto-merge branch (an unresolved comment never makes a
    // PR mergeable) and no "cleared" direction (see notifier.js). The board
    // toast always fires, but the PANE NUDGE is skipped when checkStatus already
    // nudged this same link this tick (checkStatusKeys, above) — a "Request
    // changes" review commonly trips BOTH diffs in one sweep (new inline
    // comments AND a fresh changes-requested transition), and two unawaited
    // deliverPrNudge calls to the same pane would interleave their pastes.
    for (const ev of diffUnresolvedComments(current)) {
      broadcast({ type: 'pr-unresolved', scope: ev.scope, sessionId: ev.ownerId,
                  url: ev.url, number: ev.number, count: ev.unresolvedCount, delta: ev.delta });
      const entry = sessionManager.entryFor(ev.ownerId);
      const key = `${ev.scope}:${ev.ownerId}:${ev.url}`;
      if (!checkStatusKeys.has(key) && planUnresolvedTransition(ev, entry)) {
        deliverPrNudge(ev, entry, {
          message: prUnresolvedPaneNudge(ev), tmuxFor, socketFor, sendText,
          sessionManager, memoryStore, taskStore, onError: onPrWakeError,
        }).then((mode) => (mode === 'dormant' ? rebuild() : undefined)).catch(() => {});
      }
    }
  }
  if (changed) await rebuild();
}

// Drop the pr link with this url from a store owner (getLinks/setLinks are
// symmetric on both stores). Returns true iff a link was actually removed.
function removePrLink(store, ownerId, url) {
  const links = store.getLinks(ownerId);
  const next = links.filter((l) => !(l.type === 'pr' && l.url === url));
  if (next.length === links.length) return false;
  store.setLinks(ownerId, next);
  return true;
}

// Perform a schedule's action and return the session it acted on. `dispatch`
// launches a brand-new session via the SAME runDispatch a manual launch uses (so a
// scheduled dispatch can't drift from a manual one); the `session` kind acts on an
// EXISTING session via runSessionAction (resume if dormant, message if live).
// Throws on a gone target — the caller turns that into a schedule-error.
function performScheduleAction(action, now) {
  if (!action || action.kind === 'dispatch') {
    return runDispatch(action?.dispatch || {}, { sessionManager, taskStore, memoryStore }, now);
  }
  return runSessionAction(action, { sessionManager, tmuxFor, socketFor, memoryStore, taskStore });
}

// Fire one schedule (shared by the ~30s tick and schedule-run-now): perform its
// action, record the fire, and broadcast the outcome. Never throws — a failure
// still advances the tick path so a broken schedule can't hot-loop every tick.
// `manual` (run-now) records the run but skips the advance, so a run-now never
// disturbs nextRunAt (a recurring schedule keeps its slot; a one-off stays
// enabled). Does NOT rebuild — the tick batches one rebuild for the whole due set;
// run-now rebuilds via runScheduleNow.
async function fireSchedule(id, { manual = false } = {}) {
  const snap = scheduleStore.snapshot().schedules.find((x) => x.id === id);
  if (!snap) return;
  const now = Date.now();
  const at = new Date(now).toISOString();
  try {
    const { sessionId } = await performScheduleAction(snap.action, now);
    scheduleStore.markFired(id, { at, sessionId }, now, { advance: !manual });
    broadcast({ type: 'schedule-fired', id, name: snap.name, sessionId });
  } catch (err) {
    scheduleStore.markFired(id, { at, sessionId: null }, now, { advance: !manual });
    broadcast({ type: 'schedule-error', id, name: snap.name, message: String(err?.message || err) });
  }
}

// run-now wrapper: fire immediately, then rebuild so the panel reflects lastRunAt
// and any new session at once. Injected into the control ctx as `runSchedule`.
async function runScheduleNow(id, opts) {
  await fireSchedule(id, opts);
  await rebuild();
}

// The scheduler tick: fire every due schedule, isolating failures (each fire is
// awaited and fireSchedule never throws). A one-off so overdue it's stale (older
// than STALE_MS) is marked missed, not fired — a long-down server must not run a
// stale one-off; a recurring slot never backlogs because markFired advances
// strictly past now. One batched rebuild if anything happened.
async function fireDueSchedules() {
  const now = Date.now();
  let any = false;
  for (const s of scheduleStore.due(now)) {
    if (s.when.kind === 'once' && now - Date.parse(s.when.runAt) > STALE_MS) {
      scheduleStore.markMissed(s.id);
      broadcast({ type: 'schedule-missed', id: s.id, name: s.name });
      any = true;
      continue;
    }
    await fireSchedule(s.id);
    any = true;
  }
  if (any) await rebuild();
}

// Snooze auto-wake tick: wake every elapsed snooze that carries a comment, deliver
// the note (auto-submitted), and clear it — comment-less snoozes are untouched (they
// stay amber for a human). Rides the schedule poll cadence beside fireDueSchedules
// (same single-owner-per-DATA_DIR lock, same fire-and-forget style). Deps injected in
// the runSessionAction style (no session-manager import in the runner). The sweeper
// carries an in-flight guard so a restart backlog can't overlap sweeps and double-wake
// a session; one batched rebuild if anything woke.
// A failed auto-wake (e.g. a lost/expired transcript that can't resume) is surfaced
// like the manual "Resume failed" toast and the schedule-error channel: broadcast a
// snooze-wake-error naming the session (labelled the same way auto-archived is), while
// fireDueSnoozeWakes clears that snooze so it isn't retried every tick forever.
function onSnoozeWakeError(sessionId, err) {
  const e = sessionManager.entryFor(sessionId);
  const label = sessionLabel({ names: [e?.name, e?.lastLabel], intent: e?.intent, cwd: e?.cwd, fallback: sessionId.slice(0, 8) });
  broadcast({ type: 'snooze-wake-error', sessionId, label, message: String(err?.message || err) });
}

// A dormant PR-check-transition wake failed to resume (e.g. a lost/expired
// transcript). Surface it like the snooze-wake-error / schedule-error channels
// rather than swallowing: diffCheckStatus already consumed the transition, so a
// silent failure would drop the nudge entirely with no re-fire.
function onPrWakeError(ev, err) {
  const e = sessionManager.entryFor(ev.ownerId);
  const label = sessionLabel({ names: [e?.name, e?.lastLabel], intent: e?.intent, cwd: e?.cwd, fallback: ev.ownerId.slice(0, 8) });
  broadcast({ type: 'pr-wake-error', sessionId: ev.ownerId, label, number: ev.number, url: ev.url, message: String(err?.message || err) });
}

const fireDueSnoozeWakesTick = createSnoozeWakeSweeper({
  entries: () => sessionManager.snoozedEntries(),
  sessionManager, tmuxFor, socketFor, memoryStore, taskStore,
  onWakeError: onSnoozeWakeError,
}, { onWoken: () => rebuild() });

// Mail settle sweeper: closes due settle windows (mailbox-store.js) and delivers
// the terse notification (mail-runner.js). A delivery failure has no sender to
// report to (the send already returned queued:true) and Phase 1 tracks no
// deliveryFailed state — the mail pill's unreadInfo age fallback is what still
// surfaces it to a human, so this just logs rather than broadcasting a toast.
const fireMailSettlesTick = createMailSettleSweeper({
  mailStore, sessionManager, tmuxFor, socketFor, memoryStore, taskStore,
  onError: (to, err) => console.error(`[mail] delivery failed for ${to}:`, err?.message || err),
}, { onWoken: () => rebuild() });

// POST /pr-attach — the launch-injected PostToolUse hook's callback. The hook
// runs INSIDE the one session whose Bash tool ran `gh pr create` and posts the
// new PR url with that session's card id in X-AW-Session, so the PR attaches to
// exactly that card — the precise attribution cwd-based polling couldn't give
// (sibling sessions sharing a cwd resolve the same PR). Honors autoAttachPr.
// Idempotent: a re-fired hook for an already-attached PR is a no-op.
async function prAttachHandler(req, res) {
  try {
    if (!autoAttachPrEnabled()) { res.writeHead(200).end('ok'); return; }
    const caller = extractCaller(req);
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = body ? JSON.parse(body)?.url : null;
    if (caller == null || !url) { res.writeHead(400).end('bad request'); return; }
    let link;
    try { link = normalisePr({ url }); } catch { res.writeHead(400).end('bad url'); return; }
    const existing = sessionManager.getLinks(caller);
    if (existing.some((l) => linkMatches(l, link))) { res.writeHead(200).end('ok'); return; }
    sessionManager.setLinks(caller, [...existing, link]);
    res.writeHead(200).end('ok');
    pollPrStatuses({ scope: 'session', ownerId: caller }).catch(() => {}); // immediate status
    rebuild().catch(() => {}); // surface the chip even before status lands
  } catch (err) {
    console.error('[pr-attach]', err);
    if (!res.headersSent) res.writeHead(500).end('error');
  }
}

// GET /file?path=… — read a markdown file for the click-to-preview modal.
// Localhost posture like the static routes; the response carries NO CORS header
// so a cross-origin page can't read it (load-bearing for the .md-anywhere read
// scope). resolveMarkdownPath gates: .md only, symlinks resolved, regular file,
// 2 MB cap. A read-time growth past the cap is an accepted race on a localhost
// dev tool.
const FILE_MAX_BYTES = 2 * 1024 * 1024;
async function fileHandler(req, res) {
  try {
    if (!isAllowedHost(req.headers.host, PORT)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    const raw = new URL(req.url, 'http://localhost').searchParams.get('path');
    const r = resolveMarkdownPath(raw, {
      homedir: os.homedir(), realpathSync: fs.realpathSync, statSync: fs.statSync, maxBytes: FILE_MAX_BYTES,
    });
    if (r.status !== 200) {
      res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: r.message }));
      return;
    }
    const content = await fs.promises.readFile(r.path, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ path: r.path, content }));
  } catch (err) {
    console.error('[file]', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'read error' }));
    }
  }
}

// spawn_session creates a full board session, mirroring the /ws dispatch path:
// dispatch (mints the card id, runs the memory binder pre-launch) → assign →
// rebuild. memoryStore/rebuild are reached the same way the dispatch handler does.
const mcpRequestHandler = createMcpRequestHandler({
  taskStore,
  graph: () => lastGraph,
  // list_tasks folds out scratch cwds when picking a task's bestFolder.
  sessionsDir: SESSIONS_DIR,
  dispatch: (opts) => sessionManager.dispatch(opts),
  memoryStore,
  rebuild: () => rebuild(),
  sessionManager,
  // schedule_session creates a schedule (dispatch / resume / message) through the
  // same store the /ws schedule handlers use; the tick owner fires it.
  scheduleStore,
  // Graph-based target resolvers (built above) so send_message can reach a live
  // peer's terminal and archive_session can snapshot a target before stopping it.
  tmuxFor,
  socketFor,
  sessionFromGraph,
  // Shared in-memory loop backstop for send_message; one instance for the process.
  messageThrottle: createMessageThrottle(),
  // The durable mailbox send_message/read_mail/list_mail all share.
  mailStore,
  config: { jiraBaseUrl },
  onPrLinksChanged: (scope, ownerId) => { pollPrStatuses({ scope, ownerId }).catch(() => {}); },
  // create_terminal deps
  terminalRegistry,
  createShellSession: (cwd, socket, command) => createShellSession(cwd, socket, sessionManager.tmuxBin, command),
  broadcast: (obj) => broadcast(obj),
  boardClients: () => controlWss.clients.size,
});

const server = createHttpServer({ port: PORT, mcpRequestHandler, prAttachHandler, fileHandler });

// --- WebSocket: control channel (graph + actions) and pty channel ---
const controlWss = new WebSocketServer({ noServer: true });
const ptyWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // CSRF gate: a cross-origin browser page can open a WS without a preflight, so
  // reject before handleUpgrade (an absent Origin is a non-browser client — allow).
  if (!isAllowedOrigin(req.headers.origin, PORT)) {
    socket.destroy();
    return;
  }
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/ws') {
    controlWss.handleUpgrade(req, socket, head, (ws) => controlWss.emit('connection', ws, req));
  } else if (pathname === '/pty') {
    ptyWss.handleUpgrade(req, socket, head, (ws) => ptyWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// Last broadcast style set, so a dropped-in style dir pushes live but unchanged
// scans don't spam every ~4s rebuild.
let lastStylesKey = null;

function broadcastStylesIfChanged() {
  const styles = listStyles();
  const key = JSON.stringify(styles);
  if (key === lastStylesKey) return;
  lastStylesKey = key;
  broadcast({ type: 'styles', styles });
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of controlWss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

async function rebuild() {
  await sessionManager.refreshAlive();
  // Sweep cleanly-exited agents into the archive before building the graph, so a
  // self-stopped session goes straight there rather than flickering through a
  // dormant Resume card. Carry the task snapshot so its archived row can still
  // show it.
  const autoArchived = await sessionManager.reconcileExitedSessions((sid) => ({
    task: taskStore.taskFor(sid),
    label: lastGraph?.sessions?.find((s) => s.sessionId === sid)?.label,
  }));
  const graph = await buildGraph(sessionManager, (sid, opts) => analyze(sid, undefined, opts), { mailStore });
  graph.tasks = taskStore.snapshot();
  graph.schedules = scheduleStore.snapshot(); // drives the Schedules panel off the live rebuild
  // Annotate each task with whether it has memory so tiles can render the dot
  // without fetching content.
  for (const t of graph.tasks.tasks) t.hasMemory = memoryStore.hasMemory(t.id);
  // Rides the graph (not the connect-time config message) so a settings toggle
  // re-renders every open board via the ordinary rebuild broadcast.
  graph.taskMemoryEnabled = taskMemoryEnabled();
  graph.subagentsExpandedByDefault = subagentsExpandedByDefault();
  graph.trustCodexLaunchCwd = trustCodexLaunchCwd();
  graph.childFullViewByDefault = childFullViewByDefault();
  lastGraph = graph;

  for (const sid of autoArchived) {
    const e = sessionManager.entryFor(sid);
    const label = sessionLabel({ names: [e?.name, e?.lastLabel], intent: e?.intent, cwd: e?.cwd, fallback: sid.slice(0, 8) });
    broadcast({ type: 'auto-archived', session: { sessionId: sid, label, worktree: await worktreeStatus(e?.worktree) } });
  }

  for (const s of diffNeedsYou(graph.sessions)) {
    broadcast({ type: 'notify', session: { sessionId: s.sessionId, label: s.label, waitingFor: s.waitingFor } });
  }
  broadcast({ type: 'graph', graph });
  broadcastStylesIfChanged();
  return graph;
}

controlWss.on('connection', (ws) => {
  lastControlActivity = Date.now();
  ws.send(JSON.stringify({ type: 'config', sessionsDir: SESSIONS_DIR, homeDir: os.homedir() }));
  if (lastGraph) ws.send(JSON.stringify({ type: 'graph', graph: lastGraph }));
  if (fdWarning) ws.send(JSON.stringify({ type: 'fd-warning', active: true, ...fdWarning }));
  availableAgents()
    .then((list) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'agents', agents: list.map((a) => ({ id: a.id, label: a.label, models: modelsWithDefault(a), efforts: a.efforts || [] })) }));
      }
    })
    .catch(() => {});
  // ctx is per-connection because reply() closes over this socket; the rest are
  // shared singletons + the graph-target resolvers.
  const ctx = {
    sessionManager,
    taskStore,
    memoryStore,
    scheduleStore,
    mailStore,
    rebuild,
    runSchedule: runScheduleNow,
    graph: () => lastGraph,
    sessionFromGraph,
    tmuxFor,
    socketFor,
    reply: (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    broadcast,
    terminalRegistry,
    createShellSession: (cwd, socket, command) => createShellSession(cwd, socket, sessionManager.tmuxBin, command),
  };
  ws.on('message', (raw) => { lastControlActivity = Date.now(); routeControlMessage(raw, ctx); });
});

// --- PTY channel: stream a tmux attach to xterm.js ---
ptyWss.on('connection', (ws, req) => {
  attachPtyChannel(ws, req, { sessionManager, tmuxFor, socketFor, sessionFromGraph, terminalRegistry });
});

async function main() {
  // Refuse to start if another wrangler already owns this DATA_DIR — a second
  // instance would clobber tasks.json/mappings.json with its own stale snapshot
  // (the "sessions unassigned / deleted tasks reappear on restart" bug). Acquired
  // before any store write (init/rebuild) so a duplicate never gets a save in.
  let instanceLock;
  try {
    instanceLock = await acquireInstanceLock({ port: PORT });
  } catch (err) {
    if (err instanceof InstanceLockError) {
      console.error(`[agent-wrangler] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  // Free the lock promptly on a graceful stop (the `process.on('exit')` handler
  // inside acquire doesn't run on a bare signal) so a `kickstart -k` successor
  // doesn't have to wait out the restart-handoff grace before acquiring.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => { instanceLock.release(); process.exit(0); });
  }
  await sessionManager.init();
  setTmuxBin(sessionManager.tmuxBin);
  // Repoint every active session's memory symlink before the first build, repairing
  // any staleness from assignment changes made while the server was down.
  for (const { sessionId } of sessionManager.activeEntries())
    memoryStore.bindSession(sessionId, taskStore.taskFor(sessionId)?.id || null);
  await rebuild();

  // Watch state files for instant updates; also poll to refresh cost/liveness.
  const watcher = createWatcher();
  watcher.on('change', () => rebuild().catch(() => {}));
  // Memory changing on disk (agent append or the human's own editor): refresh the
  // dot via rebuild and nudge any open editor to live-refresh.
  const memoryWatcher = memoryStore.createWatcher();
  memoryWatcher.on('change', (taskId) => { rebuild().catch(() => {}); broadcast({ type: 'memory-changed', taskId }); });
  setInterval(() => rebuild().catch(() => {}), 4000);
  // Suspend reconcile on a slower cadence than rebuild — teardown is rare and the
  // 4h idle threshold gives ample hysteresis. Rebuild only when it actually acts.
  setInterval(() => {
    sessionManager.reconcileSuspend(lastGraph?.sessions || [], readConfig())
      .then((ids) => { if (ids.length) return rebuild(); })
      .catch(() => {});
  }, 60000);

  // The real fd-leak canary (see fd-watchdog.js for why the ulimit alone can't be
  // one: Node self-raises its soft limit to the hard limit, so wrangler-start.sh's
  // ulimit is just a shared blast-radius backstop now, not a detector). `since` is
  // preserved across escalating levels so the banner shows how long it's been
  // climbing, not just the latest poll.
  startFdWatchdog({
    onAlert: ({ count, level }) => {
      fdWarning = { count, level, since: fdWarning?.since ?? new Date().toISOString() };
      broadcast({ type: 'fd-warning', active: true, ...fdWarning });
    },
    onClear: () => {
      fdWarning = null;
      broadcast({ type: 'fd-warning', active: false });
    },
  });

  validateDefaultModel();

  server.listen(PORT, HOST, () => {
    // Loopback presents as "localhost"; any other bind prints its actual host.
    const host = (HOST === '127.0.0.1' || HOST === '::1') ? 'localhost' : HOST;
    const url = `http://${host}:${PORT}`;
    console.log(`agent-wrangler running at ${url}`);
    if (shouldOpenBrowser()) open(url).catch(() => {});
  });

  // Background PR check-status poll. setInterval fires on a fixed cadence regardless
  // of whether the prior async tick has settled, so a slow sweep CAN overlap the next
  // tick — pollPrStatuses' own in-flight guard makes an overlapping full-sweep tick a
  // no-op (see there). unref so it never keeps the process alive on its own.
  const prPoll = setInterval(() => {
    pollPrStatuses().catch(() => {});
  }, prStatusPollSeconds() * 1000);
  prPoll.unref();

  // Scheduler tick: fire due schedules. Mirrors the suspend/PR loops — fire-and-
  // forget (a slow dispatch can't stack ticks) and unref'd so it never keeps the
  // process alive. The single-instance-per-DATA_DIR lock makes this the sole
  // scheduler owner, so a schedule can never double-fire across instances.
  const schedulePoll = setInterval(() => {
    fireDueSchedules().catch(() => {});
    fireDueSnoozeWakesTick().catch(() => {});
  }, 30000);
  schedulePoll.unref();

  // Mail settle sweep: a fixed 10s window needs a finer cadence than the 30s
  // schedule poll above to close near its deadline (spec: "~2s"). Fire one sweep
  // immediately at boot, before the interval starts, so a settle deadline that
  // passed while the server was down fires on this first sweep rather than
  // waiting up to 2s more — and, more importantly, so it's not lost entirely if
  // the process is killed again before the interval's first tick.
  fireMailSettlesTick().catch(() => {});
  const mailPoll = setInterval(() => {
    fireMailSettlesTick().catch(() => {});
  }, 2000);
  mailPoll.unref();

  // Keep the Usage dashboard's per-file scan cache populated even if nobody ever opens
  // the panel: Claude Code deletes its transcripts past ~30 days and a costed day only
  // outlives that deletion if it was cached first (usage-report.js
  // resolveClaudeTranscript). Daily is well inside that window. Unlike prPoll there is
  // no in-flight guard and none is needed — a sweep overlapping a panel-triggered scan
  // is a no-op by construction (both walk the same mappings, so both build a complete
  // seen-set before the eviction loop). The first run is a few minutes after listen,
  // not a whole day: a service restarted more often than the interval (a laptop
  // rebooting) would otherwise never sweep at all, which is the case this exists for.
  const usageSweep = () => scanAllDaily().catch(() => {});
  const usageWarm = setTimeout(usageSweep, 5 * 60 * 1000);
  usageWarm.unref();
  const usagePoll = setInterval(usageSweep, 24 * 60 * 60 * 1000);
  usagePoll.unref();

  // Dev-instance self-shutdown: a dev server (AW_DEV set by the run-dev skill)
  // reaps itself when its data dir is wiped out from under it or it's been idle
  // with no control client — so a forgotten teardown can't leave it running
  // forever, reparented to launchd. Never fires for the production service
  // (AW_DEV unset → enabled false). Released lock comes free via the exit handler.
  const devCfg = devShutdownConfig();
  if (devCfg.enabled) {
    const devReap = setInterval(() => {
      const reason = devShutdownDecision({
        enabled: devCfg.enabled,
        idleMs: devCfg.idleMs,
        now: Date.now(),
        lastClientActivity: lastControlActivity,
        clientsConnected: controlWss.clients.size,
        dataDirExists: fs.existsSync(DATA_DIR),
      });
      if (reason) {
        console.log(`[agent-wrangler] dev instance shutting down (${reason})`);
        process.exit(0);
      }
    }, 60000);
    devReap.unref();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
