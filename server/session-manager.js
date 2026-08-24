import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { discoverClaudeSessions, tmuxesForSession, capturePane } from './tmux-scraper.js';
import { buildInnerCommand, withCleanClaudeEnv, shellQuote } from './agents/claude.js';
import { adapterFor, isOwnedTmux, CLOUD_TMUX_PREFIX } from './agents/index.js';
import { runtimeFor } from './runtimes/index.js';
import { containerIdFor } from './runtimes/devcontainer.js';
import { classifyEnvironmentId, buildTeleportCommand } from './runtimes/cloud.js';
import { cloudAttachSupported, CLOUD_ATTACH_UNSUPPORTED_MSG } from './cloud-attach.js';
import { watchCloudLaunch, pruneCloudLaunchLogs } from './cloud-launch-watch.js';
import { addDirFor, linkPathFor } from './memory-store.js';
import { createWorktree, addDetachedWorktree, gitRepoRoot, slugFromIntent, renameBranch, WorktreeError } from './worktree.js';
import { launchCwd, findTranscript } from './transcript-reader.js';
import { DATA_DIR } from './data-dir.js';
import { paneCommand } from './launch-script.js';
import { tmuxSocketArgs, socketsToScan, socketForEntry } from './tmux-socket.js';
import { resolveInstanceSocket, trustCodexLaunchCwd, childFullViewByDefault } from './config-store.js';
import { ensureCodexTrust } from './codex-trust.js';
import { writeJsonAtomic, readJsonOrLoud } from './atomic-json.js';
import { isLegacyWorkerWorkflow } from './workflow.js';
import { resolveTmuxBin } from './tmux-resolve.js';

const exec = promisify(execFile);
const MAP_FILE = path.join(DATA_DIR, 'mappings.json');

// Scratch dirs for sessions dispatched without a folder live under DATA_DIR,
// NOT inside the wrangler checkout. A scratch dir has no .git of its own, and
// readBranch walks up to the nearest enclosing repo — so keeping these inside
// the source tree made every blank-cwd session report the wrangler's own branch
// (the "branch bleeding between sessions" bug). DATA_DIR isn't a git repo.
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

// Env for a `tmux attach` child. Strips TMUX/TMUX_PANE so the client is never
// seen as nested — if the server itself was launched from inside a tmux those
// are inherited, and tmux then refuses with "sessions should be nested with
// care, unset $TMUX to force". Also prepends the tmux dir so node-pty finds it.
export function attachEnv(env, tmuxDir) {
  const { TMUX, TMUX_PANE, ...rest } = env;
  return { ...rest, PATH: `${tmuxDir}:${env.PATH || ''}` };
}

// Expand a leading `~` to the home dir. tmux's `-c` start-directory does NOT
// expand tilde, and silently falls back to $HOME when the path doesn't exist —
// so a user-typed `~/vcs/foo` would launch in the home dir instead. Other
// shells expand tilde before we ever see the path, but our UI input doesn't.
export function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// YYYYMMDDHHMMSS — human-sortable scratch-folder name.
function timestampName(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function isInsideSessions(dir) {
  const rel = path.relative(SESSIONS_DIR, dir);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Pure decision: which dead tmuxes are clean agent exits to auto-archive. A
// candidate qualifies iff it's an owned (`cc_`) tmux mapped to a session that
// isn't already archived and whose pane exited with status 0 (a deliberate
// /exit or a self-stopped agent). A non-zero or unknown (null) status is left
// for the existing dead-pane path so a crash/failed-resume keeps surfacing its
// output with Resume. Foreign (non-`cc_`) tmuxes are never swept.
//
// CLOUD IS EXCLUDED, and this is not an optimisation. A cloud CREATE pane exits 0
// the moment the CLI has printed the new session's id — which is exactly the
// "clean agent exit" signature above, so without this filter every cloud card
// self-archived seconds after it appeared. The exit means "the local client
// finished", never "the cloud session finished": the agent is still running in a
// VM we cannot see. The exclusion stays correct once interactive attach ships,
// too — a cloud pane exiting then means the local ATTACH ended, still not the
// session.
export function archivableExits(deadEntries) {
  return deadEntries.filter(
    (d) => typeof d.tmux === 'string' && isOwnedTmux(d.tmux)
      && d.sessionId && !d.archived && d.status === 0
      && d.runtime !== 'cloud',
  );
}

// How long `teleport` watches its new pane before converting the card. Not a
// discovery window — the local conversation id is preset via `--session-id`, so
// there is nothing to wait for; this is purely long enough for a teleport the CLI
// is going to REFUSE to have exited (it does so in a second or two), because a
// still-live pane is the only evidence of success there is. ~5 s, so a teleport
// that works still feels immediate.
const TELEPORT_WATCH_TRIES = 10;
const TELEPORT_WATCH_POLL_MS = 500;

// A long snooze (>= 1h) also reclaims a session's RAM by suspending it. A shorter
// snooze is a pure visibility hide (no resume cost on a quick re-open).
export const SUSPEND_MIN_SNOOZE_MS = 60 * 60 * 1000;

// The idle-timer threshold in ms from config. Absent => 8h (on by default — long
// enough that a session untouched this long is genuinely abandoned, so the rare
// casualty, e.g. a background dev server, is one you'd have returned to by now if
// it mattered); an explicit 0 disables the timer (null); any positive number is
// that many hours. The explicit-suspend path (suspendPending) still works when null.
export function suspendIdleMs(config = {}) {
  const h = config.suspendIdleHours;
  if (h === 0) return null;
  const hours = (typeof h === 'number' && h > 0) ? h : 8;
  return hours * 60 * 60 * 1000;
}

// The global kill switch for ALL automatic suspending — distinct from
// `suspendIdleHours: 0`, which only silences the idle timer (an explicit
// suspendPending or a long snooze still tear a session down). `suspendEnabled:
// false` disables every automatic path: the reconcile loop bails and the
// snooze handler skips its teardown, so a session is only ever suspended by a
// future deliberate user action. On by default. Keyed on the install config.
export function suspendEnabled(config = {}) {
  return config.suspendEnabled !== false;
}

// Pure decision: which live (managed) sessions to tear down. A candidate is
// { sessionId, managed, attached, status, hasBackgroundShell, suspendPending,
// lastActivity }. Rules: only managed (has a live tmux to kill); never while a
// client is attached; only when idle (never working/needs-you — killing those
// loses work or the human's place); never with a live background shell (the
// pane kill leaves no transcript trace of the kill, which is what produces the
// "No completion record was found" noise on the next resume — automatic suspend
// has no human present to choose "kill jobs first", so it just waits). Then
// EITHER an explicit suspend is pending (fire as soon as idle), OR it has been
// idle for >= idleMs (timer; skipped when idleMs is null).
export function suspendableSessions(candidates, { idleMs, now }) {
  return candidates.filter((c) => {
    if (!c.managed || c.attached || c.status !== 'idle' || c.hasBackgroundShell) return false;
    if (c.suspendPending) return true;
    if (idleMs == null || typeof c.lastActivity !== 'number') return false;
    return (now - c.lastActivity) >= idleMs;
  });
}

// Pure: the mapping entry for a forked session. Inherits the parent's intent,
// model, and name; an explicit title (from the fork dialog) overrides the
// inherited name. The board shows a fork as `[FORK] <name>` (see withForkMark).
// `forkedFrom` records the parent board id — provenance, and the fork marker.
export function forkEntry({ short, tmux, cwd, parentEntry, parentId, name = '', createdAt }) {
  const explicit = name && name.trim();
  const entry = {
    short,
    tmux,
    cwd,
    agent: parentEntry?.agent || 'claude',
    intent: parentEntry?.intent || '(forked)',
    name: explicit ? name.trim() : (parentEntry?.name || undefined),
    model: parentEntry?.model ?? null,
    createdAt,
    forkedFrom: parentId,
    liveSessionId: undefined,
    runtime: parentEntry?.runtime,
    // Same argv-is-current-code reasoning as resumeEntry — a fork's launch also
    // runs buildInnerCommand/allowedToolsArg fresh, so it always carries
    // read_mail/list_mail. NOT inherited from parentEntry: a fork gets a fresh
    // card id and its own empty mailbox (unread mail is dropped on fork), so its
    // capability is its own, not the parent's history.
    mailCapable: true,
  };
  // A name inherited from the parent is marked so the board shows "[FORK] <name>"
  // until the user renames it; an explicit title (or a later rename) is user-chosen
  // and shows as-is. See withForkMark.
  if (!explicit && parentEntry?.name) entry.nameInherited = true;
  return entry;
}

// Pure: how to relaunch a session on resume. Normally a plain resume of its live
// id. But a fork whose own transcript was never written (created then archived
// without a single message — Claude writes a fork's transcript only on its first
// message) has no conversation of its own, and its branch point was never saved
// anywhere: re-sourcing from the parent would silently diverge if the parent has
// moved on since. So refuse with guidance rather than reproduce the wrong thing.
export function resumePlan({ entry, resumeId, forkLiveExists }) {
  if (entry?.forkedFrom && !forkLiveExists) {
    return { mode: 'refuse', message: NEVER_MESSAGED_FORK_MSG };
  }
  return { mode: 'resume', resumeId };
}

// Shared refusal text for resume and fork of a never-messaged fork.
export const NEVER_MESSAGED_FORK_MSG =
  'This fork has no conversation of its own yet (it was never messaged). Fork its parent instead, or send this fork a message first.';

// Refusal text when a Claude resume can't locate the conversation's transcript.
export const RESUME_NO_TRANSCRIPT_MSG =
  "Can't resume — this conversation's transcript isn't on disk (it may have been deleted, or a nested-looking launch dropped it). Refusing to start a blank session in its place so the card isn't silently replaced by an empty one.";

// Pure: where to relaunch a preset-id (Claude) resume — guarding the silent-empty
// footgun. `claude --resume <id>` is scoped to the launch cwd's project bucket and
// FAILS OPEN: handed an id that isn't bucketed under that cwd it starts a fresh,
// EMPTY conversation instead of erroring, so the user sees a "cleared" session and
// thinks it's lost (the transcript is fine on disk, just orphaned). So: no transcript
// found anywhere → refuse (don't replace a lost session with a blank one); transcript
// found with a known, still-existing launch dir → relaunch THERE (its bucket),
// overriding a drifted/blank entry.cwd that would otherwise strand the resume. When
// the launch dir is unknown or gone, fall back to the caller's resolved dir (the
// resume-needs-dir prompt has already had its say on a missing dir).
export function resumeLaunchPlan({ transcriptFound, launchDir, launchDirExists, fallbackDir }) {
  if (!transcriptFound) return { mode: 'refuse', message: RESUME_NO_TRANSCRIPT_MSG };
  return { mode: 'resume', dir: (launchDir && launchDirExists) ? launchDir : fallbackDir };
}

// Pure: whether a resumed entry's workflow marker should reload the issue-to-pr
// skill plugin — true only for a genuine orchestrator marker, never a worker
// (a modern worker carries `parentSession` instead of `workflow`; a legacy
// pre-migration worker still carries the old `{parent}` shape and must be
// excluded here too). Shares its classification with state-reader.js's
// `deriveParentSession` read-side fallback via `isLegacyWorkerWorkflow`, so the
// two can't drift apart.
export function shouldReloadWorkflowSkill(workflow) {
  return Boolean(workflow) && !isLegacyWorkerWorkflow(workflow);
}

// Pure: the fresh mapping entry resume() rebuilds (without archivedAt, so the card
// returns to the board) while preserving the durable bits of the prior entry. Split
// out so the carry-forward set is unit-testable — provenance (forkedFrom, spawnedBy,
// nameInherited — the [FORK] marker must survive an idle-suspend on a still-unnamed
// fork), the worktree it lives in, the autopilot `workflow` marker (a multi-hour run
// that hits the idle-suspend would otherwise lose its phase chip on resume), any
// attached links (a PR/Jira link attached before an idle-suspend must survive the
// resume that follows it), the per-session PR-automation toggles (autoFixPrChecks,
// autoMergeOnPass — an explicit true/false on either must not silently revert to its
// default across the very idle-suspend cycle a long workflow run is most likely to hit),
// and the per-child full/compact display override (childFullView — same reasoning);
// note `entry.snooze` is deliberately NOT here — it's dropped unconditionally by this
// function's own field list, not because callers reliably clearSnooze() before resume
// — some resume() call sites don't) all survive.
export function resumeEntry(prev, { short, tmux, cwd, agent, resumeId, socket, now }) {
  return {
    short, tmux, cwd,
    agent,
    intent: prev?.intent || '(resumed)',
    name: prev?.name,
    nameInherited: prev?.nameInherited,
    model: prev?.model ?? null,
    effort: prev?.effort ?? null,
    createdAt: prev?.createdAt ?? now,
    liveSessionId: resumeId,
    // Conversations this card owned before the agent abandoned them with `/clear`
    // (see noteLiveSessionId). Durable: their transcripts still hold real spend, and
    // dropping them here would take that spend off the card's cost AND out of the
    // usage scan cache that outlives the transcript itself.
    priorLiveSessionIds: prev?.priorLiveSessionIds,
    socket,
    forkedFrom: prev?.forkedFrom,
    spawnedBy: prev?.spawnedBy,
    worktree: prev?.worktree,
    workflow: prev?.workflow,
    parentSession: prev?.parentSession,
    runtime: prev?.runtime,
    links: prev?.links,
    autoFixPrChecks: prev?.autoFixPrChecks,
    autoMergeOnPass: prev?.autoMergeOnPass,
    childFullView: prev?.childFullView,
    // A cloud card's whole cloud identity (its `session_…` id, URL, environment)
    // must survive the resume that re-attaches to it — that id is the only handle
    // on the running session, and losing it would strand the work in the cloud
    // with no way back. Also retained across a Teleport conversion so a local card
    // can still render `was ☁`.
    cloud: prev?.cloud,
    // The relaunch below always runs buildInnerCommand/allowedToolsArg from the
    // CURRENT code, so a resumed session's argv always carries read_mail/list_mail
    // regardless of what it was launched with originally — stamp it true
    // unconditionally (never carried over from `prev`; this is deliberately about
    // the argv this resume just built, not the entry's history). send_message reads
    // this to decide mailbox vs. direct-push fallback for the recipient.
    // EXCEPT cloud: a cloud relaunch is `claude --cloud <session_…>`, which carries
    // no --mcp-config and no --allowedTools at all (nothing in the VM can reach
    // 127.0.0.1), so its recipient has no mailbox tool either way.
    mailCapable: prev?.runtime !== 'cloud',
  };
}

// Resolve worktree creation for a dispatch: derive the branch (default = intent
// slug), create the worktree, and return the cwd to launch in plus the entry
// field to persist. Throws WorktreeError on refusal (caller aborts dispatch).
export async function resolveWorktree({ cwd, intent = '', branch = '', folderName = '', auto = false, short = '' }) {
  // A scratch/blank cwd is a throwaway dir under SESSIONS_DIR (freshened per
  // dispatch) — not a real repo to branch from. Refuse rather than silently
  // skip, so the toggle never appears to do nothing.
  if (!cwd || isInsideSessions(cwd)) {
    throw new WorktreeError('Worktree mode needs a real git repository — choose a project folder, not a blank or scratch directory.');
  }
  // Branch must be git-ref-safe: restrict to [A-Za-z0-9-] (defensive — the client
  // sanitizes too). Fall back to the intent slug if a typed branch sanitizes away.
  const b = ((branch.trim() || slugFromIntent(intent, { short })).replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+|-+$/g, '')) || slugFromIntent('', { short });
  const folder = folderName.trim();
  const res = await createWorktree({ cwd, branch: b, folderName: folder ? expandTilde(folder) : '', auto });
  // Record repoRoot so cleanup-on-archive can find the branch even after the
  // worktree dir is gone (repoRootForWorktree falls back to suffix-stripping for
  // legacy entries that predate this).
  return { cwd: res.path, branch: res.branch, worktree: { path: res.path, branch: res.branch, repoRoot: res.repoRoot } };
}

export class SessionManager {
  constructor() {
    this.map = new Map(); // sessionId -> { short, tmux, cwd, intent, model, createdAt, worktree?, archivedAt? }
    this.alive = new Set(); // tmux session names with a live (non-dead) pane
    this.dead = new Set(); // tmux sessions kept by remain-on-exit after their command exited
    this.deadStatus = new Map(); // dead tmux name -> pane exit code (absent if tmux didn't report one)
    this.tmuxBin = 'tmux'; // resolved to an absolute path in init()
    this.socket = ''; // this install's generated tmux socket, resolved in init()
    // The socket pre-migration (legacy) sessions live on: the default socket ('')
    // in production, overridable for isolated migration testing.
    this.legacySocket = process.env.AW_LEGACY_TMUX_SOCKET || '';
    this.socketByName = new Map(); // tmux name -> socket it was last discovered on
    this._resuming = new Map(); // card id -> in-flight resume promise (coalesces concurrent resumes)
    // Seam (like _newSession/_save) so a test can observe/stub the one call in
    // dispatch/resume/fork that touches a real machine-global dotfile
    // (~/.codex/config.toml) instead of this class's own owned state.
    this._ensureCodexTrust = ensureCodexTrust;
    // Same kind of seam, for the one call in dispatch that polls a real tmux pane's
    // output after the launch has already returned. A test stubs this to assert the
    // wiring (and to capture the log path) without a tmux server or a 120 s poll.
    this._cloudLaunch = watchCloudLaunch;
    // Third seam of the same kind. The attach gate answers off config.json, which
    // `node --test` may not write (it's the developer's real data dir), so the one
    // caller that acts on the answer reads it through here.
    this._cloudAttachSupported = cloudAttachSupported;
    // Fourth seam. The teleport watch reads a pane's dying words to put them in the
    // error it throws; a test needs to supply that text without a real tmux, and the
    // scraper's own `capturePane` swallows its failures so it can't be stubbed by
    // making tmux fail.
    this._capturePane = capturePane;
    this._load();
  }

  entryFor(sessionId) {
    return this.map.get(sessionId);
  }

  // [sessionId, entry] pairs for every mapped session carrying a snooze — feeds the
  // snooze auto-wake tick (which fires only elapsed, commented ones).
  snoozedEntries() {
    return [...this.map].filter(([, e]) => e.snooze);
  }

  entryByTmux(name) {
    for (const [sessionId, v] of this.map) {
      if (v.tmux === name) return { sessionId, ...v };
    }
    return null;
  }

  // Which mapped sessionId owns this tmux session (null if not ours).
  tmuxOwner(name) {
    for (const [sessionId, v] of this.map) {
      if (v.tmux === name) return sessionId;
    }
    return null;
  }

  forget(sessionId) {
    if (this.map.delete(sessionId)) this._save();
  }

  // Tear down every owned tmux currently hosting this session: the recorded
  // mapping name *plus* any original/fork tmux found by scanning what's actually
  // running. The recorded name drifts (a resume re-points it to the new fork
  // while the original lingers), so killing only the record leaks the original —
  // this scans by session id instead. Verifies each is gone and warns rather
  // than swallowing failures. Returns the names it targeted.
  async killForSession(sessionId) {
    const entry = this.map.get(sessionId);
    const recorded = entry?.tmux;
    let discovered = [];
    try {
      discovered = await discoverClaudeSessions(this.scanSockets());
    } catch { /* tmux unavailable */ }
    // A deliberate fork's command resumes this id, so a command-line scan can't tell
    // it apart from a resume-fork of this session. Exclude any tmux that is the
    // recorded home of a *different* board id (a fork's own identity) so archiving a
    // parent never reaps its forks — they survive as independent sessions.
    const claimedByOthers = new Set(
      [...this.map].filter(([sid]) => sid !== sessionId).map(([, v]) => v.tmux).filter(Boolean),
    );
    const socketOf = new Map(discovered.map((d) => [d.tmuxName, d.socket]));
    const targets = new Set(tmuxesForSession(discovered, sessionId, { claimedByOthers }));
    if (recorded) targets.add(recorded);
    for (const name of targets) {
      // Kill on the socket the tmux actually lives on: discovered socket, else the
      // owning entry's recorded socket (legacy → default).
      const socket = socketOf.has(name) ? socketOf.get(name) : this.socketOf(name);
      await this._tmux(socket, ['kill-session', '-t', name]).catch(() => {});
      const survived = await this._tmux(socket, ['has-session', '-t', name]).then(() => true).catch(() => false);
      if (survived) console.warn(`[wrangler] kill-session left ${name} alive (session ${sessionId})`);
    }
    await this.refreshAlive();
    return [...targets];
  }

  // Set a session aside into the archive: keep its mapping (so it stays resumable)
  // but stamp when it was archived. A session discovered externally has no
  // mapping yet — adopt it (using the caller's snapshot) so it too can be
  // archived and later resumed.
  archive(sessionId, snapshot = {}) {
    let entry = this.map.get(sessionId);
    if (!entry) {
      entry = {
        short: crypto.randomBytes(4).toString('hex'),
        tmux: null,
        cwd: snapshot.cwd || null,
        intent: snapshot.intent || '',
        model: null,
        createdAt: Date.now(),
      };
      this.map.set(sessionId, entry);
    }
    entry.archivedAt = Date.now();
    // Drop a deferred-suspend intent: an archived session leaves the board, so a
    // pending teardown is moot (and would otherwise linger in the JSON).
    delete entry.suspendPending;
    // Snapshot the task it was archived from ({id, name}) so the archived listing
    // (Search) can still show "was: <name>" after the task is later deleted (which
    // drops the live assignment). Mirrors how cwd/intent are snapshotted above.
    if (snapshot.task) entry.task = { id: snapshot.task.id, name: snapshot.task.name };
    // Set only when this session was swept up by a task-archive cascade (never by
    // a solo archive or a session-descendant cascade) — the link the archived
    // listing/restore use to know which sessions to nest under and bulk-restore
    // with their task.
    if (snapshot.viaTaskArchive) entry.viaTaskArchive = snapshot.viaTaskArchive;
    // Freeze the last known display label so the archived row (Search) shows the
    // name the user saw on the board (typically the terminal title Claude set),
    // not just the intent/cwd fallback. Only stored here — not copied back to
    // live sessions on resume, so
    // a resumed session re-derives its label from the running agent.
    if (snapshot.label) entry.lastLabel = snapshot.label;
    this._save();
    return true;
  }

  isArchived(sessionId) {
    return Boolean(this.map.get(sessionId)?.archivedAt);
  }

  // Give a session a custom display name. Adopts an externally-discovered
  // session into the registry (like archive) so the name persists. An empty
  // name clears the custom name, reverting to the derived label.
  rename(sessionId, name, snapshot = {}) {
    let entry = this.map.get(sessionId);
    if (!entry) {
      entry = {
        short: crypto.randomBytes(4).toString('hex'),
        tmux: null,
        cwd: snapshot.cwd || null,
        intent: snapshot.intent || '',
        model: null,
        createdAt: Date.now(),
      };
      this.map.set(sessionId, entry);
    }
    const trimmed = (name || '').trim();
    if (trimmed) entry.name = trimmed;
    else delete entry.name;
    // A rename is a user-chosen name, so it's no longer the inherited parent name —
    // drop the fork marker (a cleared name reverts to a marked, derived label).
    delete entry.nameInherited;
    this._save();
    return true;
  }

  // Put a session to sleep until `until` (absolute epoch ms). Adopts an
  // externally-discovered session into the registry first (like archive/rename)
  // so the timer persists. The phase (asleep/awake) is derived client-side from
  // `until` vs now — there is no server timer.
  setSnooze(sessionId, until, snapshot = {}) {
    let entry = this.map.get(sessionId);
    if (!entry) {
      entry = {
        short: crypto.randomBytes(4).toString('hex'),
        tmux: null,
        cwd: snapshot.cwd || null,
        intent: snapshot.intent || '',
        model: null,
        createdAt: Date.now(),
      };
      this.map.set(sessionId, entry);
    }
    entry.snooze = { until, createdAt: Date.now() };
    // An optional note the user attached in the Custom snooze modal; delivered to
    // the agent on wake. Store it only when it's a real non-empty string so a
    // snooze never carries an empty comment (dropped with the snooze on clear).
    const comment = typeof snapshot.comment === 'string' ? snapshot.comment.trim() : '';
    if (comment) entry.snooze.comment = comment;
    this._save();
    return true;
  }

  // Wake a session for good (on open, or "Wake now"): drop the snooze, keep the
  // entry. No-op if the session isn't mapped or wasn't snoozed.
  clearSnooze(sessionId) {
    const entry = this.map.get(sessionId);
    if (!entry || !entry.snooze) return false;
    delete entry.snooze;
    delete entry.suspendPending;
    this._save();
    return true;
  }

  // Promote a nested child to a full top-level session by clearing its parent
  // link. Its own children (if any) are untouched — they keep pointing at it,
  // so the whole subtree moves to top-level together. Callers (control
  // handler / MCP tool) are responsible for the workflow-worker guard — this
  // trusts it already ran. No-op (false) if unmapped.
  detachSession(sessionId) {
    const entry = this.map.get(sessionId);
    if (!entry) return false;
    delete entry.parentSession;
    this._save();
    return true;
  }

  // Nest a session under another. Callers are responsible for the cycle and
  // same-task guards — this trusts they already ran. No-op (false) if either
  // side isn't a mapped entry.
  attachSession(sessionId, parentSessionId) {
    const entry = this.map.get(sessionId);
    if (!entry || !this.map.has(parentSessionId)) return false;
    entry.parentSession = parentSessionId;
    // "New child sessions show full view by default" (the settings copy) means
    // NEW — a creation-time snapshot, not a live rule every untouched child
    // keeps following forever. Stamp it in now, once, so a later flip of the
    // global default never retroactively changes an already-nested child.
    // Only when unset: a session re-attached after being detached (or moved to
    // a different parent) already carries a stamp from its earlier nesting
    // (explicit or default-derived) and keeps it unchanged.
    if (entry.childFullView === undefined) entry.childFullView = childFullViewByDefault();
    this._save();
    return true;
  }

  // Per-session override for the PR check-failure nudge (the auto-fix prompt the
  // poller sends into a live pane). Tri-state: absent ⇒ inherit the default
  // (on); an explicit boolean wins. Adopts an externally-discovered session
  // first (like setSnooze) so the override persists. Keyed on the card id.
  // Record what the launch scrape learned about a cloud session: its `session_…`
  // id and claude.ai URL (see cloud-launch-watch.js). Idempotent by design — it
  // no-ops once an id is already stored, so a later stray `session_…` match in the
  // pane's scrollback (a second create in the same pane, a pasted id) can never
  // clobber a good one. Only ever writes to a `runtime: 'cloud'` entry.
  noteCloudSession(sessionId, { cloudSessionId, url } = {}) {
    const entry = this.map.get(sessionId);
    if (!entry || entry.runtime !== 'cloud' || !cloudSessionId) return false;
    if (entry.cloud?.sessionId) return false;
    entry.cloud = { ...(entry.cloud || {}), sessionId: cloudSessionId, url: url || entry.cloud?.url || null };
    this._save();
    return true;
  }

  // The cloud session is gone (a steer came back saying it's archived). Stamped
  // rather than only toasted so the card keeps showing it — there is no other
  // signal a cloud session has ended, so a lost toast would leave a card that
  // looks live forever.
  markCloudArchived(sessionId, now = Date.now()) {
    const entry = this.map.get(sessionId);
    if (!entry?.cloud || entry.cloud.archivedAt) return false;
    entry.cloud = { ...entry.cloud, archivedAt: now };
    this._save();
    return true;
  }

  // The Teleport conversion: this card stops being a cloud card and becomes an
  // ordinary local one, in place. `runtime` goes back to ABSENT because that's how
  // local is stored (see runtimeFor's contract comment) — flipping it to the string
  // 'local' would work today but breaks the "absent ⇒ local" back-compat rule every
  // pre-runtime entry relies on. From here the card gets transcript, cost, diff,
  // resume, mail and PR watching with no cloud-specific code on any of those paths;
  // `entry.cloud` is deliberately RETAINED so the card can render a `was ☁` chip
  // (and so the cloud session's id survives for anyone auditing where the work
  // started).
  convertCloudToLocal(sessionId, { worktree, liveSessionId } = {}) {
    const entry = this.map.get(sessionId);
    if (!entry || entry.runtime !== 'cloud' || !liveSessionId) return false;
    entry.runtime = undefined;
    entry.worktree = worktree || entry.worktree;
    entry.liveSessionId = liveSessionId;
    entry.mailCapable = true;
    this._save();
    return true;
  }

  setAutoFixPrChecks(sessionId, enabled, snapshot = {}) {
    let entry = this.map.get(sessionId);
    if (!entry) {
      entry = {
        short: crypto.randomBytes(4).toString('hex'),
        tmux: null,
        cwd: snapshot.cwd || null,
        intent: snapshot.intent || '',
        model: null,
        createdAt: Date.now(),
      };
      this.map.set(sessionId, entry);
    }
    entry.autoFixPrChecks = Boolean(enabled);
    this._save();
    return true;
  }

  // Per-session opt-in for auto-merging the PR once its checks pass (the poller
  // runs `gh pr merge` on the passing transition). Unlike autoFixPrChecks this
  // defaults OFF when absent — merging is consequential, so it's an explicit
  // choice. Adopts an externally-discovered session first (like setSnooze) so
  // the override persists. Keyed on the card id.
  setAutoMergeOnPass(sessionId, enabled, snapshot = {}) {
    let entry = this.map.get(sessionId);
    if (!entry) {
      entry = {
        short: crypto.randomBytes(4).toString('hex'),
        tmux: null,
        cwd: snapshot.cwd || null,
        intent: snapshot.intent || '',
        model: null,
        createdAt: Date.now(),
      };
      this.map.set(sessionId, entry);
    }
    entry.autoMergeOnPass = Boolean(enabled);
    this._save();
    return true;
  }

  // Per-CHILD (parentSession set) override for whether it renders as a full card
  // instead of the default compact `.worker-row` — the card menu's "Full view"
  // toggle. Unset (never nested through attachSession/dispatch, which stamp a
  // boolean at creation time — see there) reads as compact on the client (NOT
  // a live read of config.json childFullViewByDefault; that setting only ever
  // seeds the creation-time stamp, never overrides an already-stamped or
  // never-stamped child later). Adopts an externally-discovered session first
  // (like setAutoFixPrChecks) so the override persists. Keyed on the card id.
  setChildFullView(sessionId, enabled, snapshot = {}) {
    let entry = this.map.get(sessionId);
    if (!entry) {
      entry = {
        short: crypto.randomBytes(4).toString('hex'),
        tmux: null,
        cwd: snapshot.cwd || null,
        intent: snapshot.intent || '',
        model: null,
        createdAt: Date.now(),
      };
      this.map.set(sessionId, entry);
    }
    entry.childFullView = Boolean(enabled);
    this._save();
    return true;
  }

  // Record the current phase of an autopilot (issue→PR) run, so the board chip
  // tracks progress. Called by the `issue-to-pr` skill via the workflow_phase MCP
  // tool. Adopts an unmapped session first (like setSnooze) — the tmux process is
  // alive before dispatch() does its map.set, so an early phase report must create
  // the entry rather than no-op; dispatch() then merges onto it. Preserves
  // issue/startedAt across a phase change. Keyed on the card id.
  setWorkflowPhase(sessionId, { label, kind } = {}, snapshot = {}) {
    let entry = this.map.get(sessionId);
    if (!entry) {
      entry = {
        short: crypto.randomBytes(4).toString('hex'),
        tmux: null,
        cwd: snapshot.cwd || null,
        intent: snapshot.intent || '',
        model: null,
        createdAt: Date.now(),
      };
      this.map.set(sessionId, entry);
    }
    entry.workflow = { ...(entry.workflow || {}), phase: { label, kind, at: Date.now() } };
    this._save();
    return true;
  }

  // Rename this session's worktree branch to a descriptive name. Called by an
  // autopilot run via the name_branch MCP tool once it knows the work (the
  // dispatch-time slug is just a placeholder). Does the git rename in the worktree
  // and syncs `entry.worktree.branch` (+ repoRoot) so cleanup/status target the
  // right ref; the card's branch badge already follows HEAD on its own. Throws on
  // a session with no wrangler-created worktree (the only place a rename is safe).
  // Keyed on the card id.
  async renameWorktreeBranch(sessionId, desired) {
    const entry = this.map.get(sessionId);
    if (!entry) throw new Error('Unknown session.');
    if (!entry.worktree?.path) {
      throw new Error('This session has no wrangler-created worktree, so there is no branch to rename.');
    }
    const { branch, repoRoot } = await renameBranch({
      worktreePath: entry.worktree.path,
      repoRoot: entry.worktree.repoRoot,
      desired,
      currentBranch: entry.worktree.branch,
    });
    entry.worktree = { ...entry.worktree, branch, repoRoot };
    this._save();
    return branch;
  }

  // Read a session's links (by card id). Empty for an unmapped session.
  getLinks(sessionId) {
    const entry = this.map.get(sessionId);
    return entry && Array.isArray(entry.links) ? [...entry.links] : [];
  }

  // Replace a session's whole link list (the MCP set_links session scope).
  // Adopts an externally-discovered session into the registry first (like
  // setSnooze) so the links persist. Caller has already validated each link.
  setLinks(sessionId, links, snapshot = {}) {
    let entry = this.map.get(sessionId);
    if (!entry) {
      entry = {
        short: crypto.randomBytes(4).toString('hex'),
        tmux: null,
        cwd: snapshot.cwd || null,
        intent: snapshot.intent || '',
        model: null,
        createdAt: Date.now(),
      };
      this.map.set(sessionId, entry);
    }
    entry.links = Array.isArray(links) ? [...links] : [];
    this._save();
    return true;
  }

  // Every pr link across all mapped sessions, as
  // { ownerId, url, number, checkStatus, dirty, unresolvedCount } —
  // number/checkStatus/dirty/unresolvedCount drive the check/dirty/unresolved-
  // comment transition notifiers; the poll loop's update path only reads url.
  prLinks() {
    const out = [];
    for (const [sessionId, entry] of this.map)
      for (const l of entry.links || [])
        if (l.type === 'pr' && l.url)
          out.push({ ownerId: sessionId, url: l.url, number: l.number, checkStatus: l.checkStatus, dirty: l.dirty, unresolvedCount: l.unresolvedCount });
    return out;
  }

  // Write checkStatus/dirty/unresolvedCount onto the pr link with this url on a
  // session, in place. Always bumps the freshness timestamp on a match, but
  // returns true only when checkStatus OR dirty actually changed (false if
  // both unchanged or the session/link isn't found) — that return drives the
  // poller's rebuild, so a stable PR mustn't trigger a graph broadcast.
  // unresolvedCount is deliberately EXCLUDED from that comparison: it renders
  // nowhere in public/ (notification-only, per the approved design), so a
  // thread resolving/unresolving shouldn't force a graph rebuild — the
  // unresolved-comment notifier reads the persisted value straight from the
  // store on every sweep regardless of this return. unresolvedCount is
  // appended LAST (after fetchedAt) rather than inserted mid-signature, so the
  // existing positional-arg call sites/tests aren't silently broken by an
  // argument shift.
  updateLinkStatus(sessionId, url, checkStatus, dirty, fetchedAt, unresolvedCount) {
    const entry = this.map.get(sessionId);
    if (!entry) return false;
    const link = (entry.links || []).find((l) => l.type === 'pr' && l.url === url);
    if (!link) return false;
    const changed = link.checkStatus !== checkStatus || Boolean(link.dirty) !== Boolean(dirty);
    link.checkStatus = checkStatus;
    link.dirty = dirty;
    link.checkStatusFetchedAt = fetchedAt;
    link.unresolvedCount = unresolvedCount;
    this._save();
    return changed;
  }


  // Tear down the session's live tmux but KEEP its mapping entry, so the card
  // stays on the board as dormant and one-click Resume brings it back. Stamps
  // suspendedAt (advisory: lets the UI show "suspended" vs a crash) and clears any
  // deferred-suspend flag. Reuses killForSession, so it's orphan-proof in the
  // resume-fork case. resume() rebuilds the entry fresh, so it naturally drops
  // suspendedAt/suspendPending on wake.
  async suspend(sessionId, { label } = {}) {
    const entry = this.map.get(sessionId);
    if (!entry) return false;
    await this.killForSession(sessionId);
    entry.suspendedAt = Date.now();
    delete entry.suspendPending;
    // Snapshot the board label so the dormant card keeps the name the user saw
    // (typically the terminal title Claude set).
    if (label) entry.lastLabel = label;
    this._save();
    return true;
  }

  // Defer a suspend: the user asked to suspend/snooze a session that's currently
  // working, so we don't kill it now — the reconcile loop completes the teardown
  // once it next goes idle. Cleared by suspend(), resume(), archive(), and
  // clearSnooze() (when a snooze is also present).
  markSuspendPending(sessionId) {
    const entry = this.map.get(sessionId);
    if (!entry) return false;
    entry.suspendPending = true;
    this._save();
    return true;
  }

  // Which tmux session names currently have at least one attached client (a
  // browser /pty `tmux attach` or an iTerm2 window). Used to skip suspending a
  // terminal someone is actively viewing. Scans the same sockets as discovery.
  async attachedSessions() {
    const attached = new Set();
    for (const socket of this.scanSockets()) {
      try {
        const { stdout } = await this._tmux(socket, ['list-clients', '-F', '#{client_session}']);
        for (const line of stdout.split('\n')) {
          const n = line.trim();
          if (n) attached.add(n);
        }
      } catch {
        /* no tmux server on that socket */
      }
    }
    return attached;
  }

  // Mapped sessions still on the board (not archived).
  activeEntries() {
    return [...this.map].filter(([, v]) => !v.archivedAt).map(([sessionId, v]) => ({ sessionId, ...v }));
  }

  // Archived mapped sessions (they feed graph.history), newest first.
  archivedEntries() {
    return [...this.map]
      .filter(([, v]) => v.archivedAt)
      .map(([sessionId, v]) => ({ sessionId, ...v }))
      .sort((a, b) => b.archivedAt - a.archivedAt);
  }

  // Coalesce concurrent resumes of the SAME session. resume() has several
  // near-simultaneous callers (the manual WS handler, the schedule runner, the
  // snooze auto-wake sweep) that all key on the card id — the same id
  // killForSession/relaunch operate on. Two overlapping calls would each
  // killForSession + relaunch, and the second's kill reaps the first's
  // freshly-spawned tmux mid-boot (losing its auto-submitted note and
  // double-relaunching). While a resume for a card id is in flight, a second
  // call for that SAME id joins its promise instead of starting its own
  // kill+relaunch; both callers see the identical result (or the same rejection
  // — the manual toast / sweep onWakeError paths still fire). The finally clears
  // the entry whether the resume settled or threw, so a later (sequential)
  // resume can retry. Sequential resumes are unaffected.
  resume(sessionId, cwd, opts = {}) {
    const existing = this._resuming.get(sessionId);
    if (existing) return existing;
    const p = Promise.resolve(this._doResume(sessionId, cwd, opts))
      .finally(() => this._resuming.delete(sessionId));
    this._resuming.set(sessionId, p);
    return p;
  }

  // Is a resume for this card id in flight? Lets a would-be caller decide
  // SYNCHRONOUSLY (no await before its own resume()) whether it will OWN the
  // relaunch or merely JOIN an existing one — the coalescing above hands a joiner
  // the in-flight promise and silently ignores its opts.intent, so a joiner that
  // needs its intent delivered must detect the join and fall back (see
  // deliverPrNudge). Reading it right before resume() is race-free: resume()
  // registers the _resuming slot synchronously before its first await.
  isResuming(sessionId) {
    return this._resuming.has(sessionId);
  }

  // Resume an existing session's conversation in a fresh, attachable tmux
  // session (used for sessions not already running in tmux).
  async _doResume(sessionId, cwd, { intent = '' } = {}) {
    // Tear down every tmux currently hosting this session before forking a fresh
    // one — not just the recorded name. A prior resume may have left the original
    // (or an earlier fork) running under a drifted record; killing only prev.tmux
    // leaked it. Scanning by session id reaps them all so re-resume starts clean.
    const prev = this.map.get(sessionId);
    const agent = prev?.agent || 'claude';
    const adapter = adapterFor(agent);
    const runtime = runtimeFor(prev?.runtime);
    await this.killForSession(sessionId);
    const short = crypto.randomBytes(4).toString('hex');
    const tmux = this._tmuxName(agent, short, prev?.runtime);
    let dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    // Cloud resume = re-ATTACH a local pane to a session still running in the
    // cloud. It must branch BEFORE the resume-id resolution below, all of which is
    // about host transcripts: for a cloud entry `liveSessionId` is absent, so
    // `resumeId` would fall back to the CARD id and `claude --resume <card id>`
    // would fail open into a fresh, empty LOCAL session (CLAUDE.md's fails-open
    // rule) — silently replacing a running cloud session with a blank local one.
    // `cloud.skipsHostResumeGuard` documents why none of that machinery applies.
    if (prev?.runtime === 'cloud') {
      if (!this._cloudAttachSupported()) throw new Error(CLOUD_ATTACH_UNSUPPORTED_MSG);
      const launchCmd = runtime.buildLaunch({ mode: 'resume', cwd: dir, sessionId, entry: prev });
      await this._newSession(tmux, dir, launchCmd, this.socket);
      // Watch this pane too — an ATTACH is the only launch that can print the
      // refusal line, so it's the only one that can move the gate's answer in either
      // direction. Not awaited, same as dispatch's: a resume must return at once.
      const logPath = await this._pipePaneToFile(tmux, this.socket, sessionId);
      Promise.resolve(this._cloudLaunch({ sessionManager: this, sessionId, tmux, socket: this.socket, logPath, mode: 'attach' }))
        .catch((e) => console.error(`[cloud] attach watch for ${sessionId} failed:`, e?.message || e));
      // resumeEntry carries `cloud` forward and leaves mailCapable false for a cloud
      // entry; `resumeId` is null because there is no host conversation to resume —
      // storing the card id here is exactly the confusion the three-namespace rule
      // forbids.
      this.map.set(sessionId, resumeEntry(prev, {
        short, tmux, cwd: dir, agent, resumeId: undefined, socket: this.socket, now: Date.now(),
      }));
      this._save();
      await this.refreshAlive();
      return { tmux };
    }
    // Memory binds to the owner/mapped id (this `sessionId`, stable across the
    // fork), not the new id --fork-session gives the process — per the resume-fork
    // invariant, so the memory follows the durable identity.
    // Resolve which agent-native id to resume. Claude's lives under the board id,
    // so the cached value (== sessionId) or the board id itself both work. Codex
    // mints its own rollout id: trust a cached id only if it's a real one (not the
    // board id a prior race/fallback may have stored), else re-discover it from the
    // launch dir — by resume time the rollout definitely exists. Never resume the
    // board id for codex; that's what produced "Run `codex resume` without an ID".
    let resumeId;
    if (adapter.presetsSessionId) {
      resumeId = prev?.liveSessionId || sessionId;
    } else if (prev?.liveSessionId && prev.liveSessionId !== sessionId) {
      resumeId = prev.liveSessionId;
    } else {
      resumeId = await adapter.discoverLiveId({ cwd: dir, launchedAt: 0 });
    }
    if (!resumeId) {
      throw new Error(`Could not locate a ${agent} session to resume (no rollout found under ${dir}).`);
    }
    // A never-messaged Claude fork has no transcript under its own id (Claude writes
    // it only on the first message) and its branch point was never saved — refuse
    // rather than resume a missing conversation. (Codex discovers its id, so this
    // only applies to preset-id agents.)
    let plan = { mode: 'resume', resumeId };
    if (adapter.presetsSessionId && !runtime.skipsHostResumeGuard && prev?.forkedFrom) {
      plan = resumePlan({ entry: prev, resumeId, forkLiveExists: Boolean(await launchCwd(resumeId)) });
    }
    if (plan.mode === 'refuse') throw new Error(plan.message);
    // Guard the silent-empty-session footgun for preset-id agents (Claude): verify
    // the conversation's transcript actually exists and relaunch in its own bucket
    // dir, so a missing transcript or a drifted/blank cwd can't make `claude
    // --resume` fail open into a fresh, empty session (see resumeLaunchPlan). Codex
    // discovers its own rollout and isn't cwd-bucketed the same way, so skip it.
    if (adapter.presetsSessionId && !runtime.skipsHostResumeGuard) {
      const transcript = await findTranscript(plan.resumeId);
      const launchDir = transcript ? await launchCwd(plan.resumeId) : null;
      const lp = resumeLaunchPlan({
        transcriptFound: Boolean(transcript),
        launchDir,
        launchDirExists: Boolean(launchDir) && fs.existsSync(launchDir),
        fallbackDir: dir,
      });
      if (lp.mode === 'refuse') throw new Error(lp.message);
      dir = lp.dir;
    }
    if (agent === 'codex' && trustCodexLaunchCwd()) this._ensureCodexTrust(prev?.worktree?.repoRoot || dir);
    const inner = adapter.buildResume({
      sessionId, resumeId: plan.resumeId, cwd: dir, model: prev?.model || undefined, effort: prev?.effort || undefined,
      memoryDir: addDirFor(sessionId), memoryPath: linkPathFor(sessionId),
      // A resumed orchestrator entry (resumeEntry preserves the marker) reloads the
      // issue-to-pr skill plugin so a suspended/rebooted autopilot run keeps it —
      // see shouldReloadWorkflowSkill for what disqualifies a worker (modern or
      // legacy-shaped) from reloading it.
      workflow: shouldReloadWorkflowSkill(prev?.workflow),
      // A scheduled resume can carry a message to deliver as the relaunch prompt
      // (claude --resume … -- <intent>), avoiding a paste race against a booting
      // agent. Empty for an interactive resume. (Codex resume ignores it.)
      intent,
      spawnedBy: prev?.spawnedBy,
    });
    const launchCmd = await runtime.wrapLaunch({ inner, cwd: dir, sessionId, worktree: prev?.worktree, workflow: shouldReloadWorkflowSkill(prev?.workflow) });
    await this._newSession(tmux, dir, launchCmd, this.socket);
    // Rebuild the entry without `archivedAt` (so it returns to the board) while
    // preserving the original description, creation time, provenance/worktree, and
    // the autopilot workflow marker (see resumeEntry). Resume relaunches on this
    // install's socket — so a legacy default-socket session migrates here.
    this.map.set(sessionId, resumeEntry(prev, {
      short, tmux, cwd: dir, agent, resumeId, socket: this.socket, now: Date.now(),
    }));
    this._save();
    await this.refreshAlive();
    return { tmux };
  }

  // Fork an existing conversation into a *new* board identity. Unlike resume()
  // — which revives the same id in place and first kills every owned tmux —
  // fork leaves the parent entirely untouched and registers the branch under a
  // fresh id, so parent and fork coexist as two diverging cards. `sourceId` is
  // the LIVE conversation id to branch from; the caller resolves it as
  // liveSessionId||sessionId so a previously-resumed session forks from its
  // current state, not a frozen owner-id transcript.
  async fork({ sourceId, parentId, parentEntry, cwd, prompt = '', name = '', bindMemory } = {}) {
    const agent = parentEntry?.agent || 'claude';
    const adapter = adapterFor(agent);
    const short = crypto.randomBytes(4).toString('hex');
    const tmux = this._tmuxName(agent, short);
    const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const sessionId = crypto.randomUUID(); // fresh CARD id (mapping key), NOT the source id
    // The fork's live conversation gets its own id, distinct from the card id. A
    // preset agent (Claude) is handed it via --session-id so the conversation lives
    // under a known id (no phantom → the fork is resumable); a discover agent (Codex)
    // mints its own, resolved post-launch. Identity + scoped memory inject on the CARD id.
    const presetLiveId = adapter.presetsSessionId ? crypto.randomUUID() : undefined;
    if (agent === 'codex' && trustCodexLaunchCwd()) this._ensureCodexTrust(parentEntry?.worktree?.repoRoot || dir);
    const inner = adapter.buildFork({
      sessionId, liveSessionId: presetLiveId, sourceId, cwd: dir, model: parentEntry?.model || undefined, effort: parentEntry?.effort || undefined, intent: prompt,
      memoryDir: addDirFor(sessionId), memoryPath: linkPathFor(sessionId),
    });
    bindMemory?.(sessionId);
    const launchCmd = await runtimeFor(parentEntry?.runtime).wrapLaunch({
      inner, cwd: dir, sessionId, worktree: parentEntry?.worktree,
    });
    const launchedAt = Date.now();
    await this._newSession(tmux, dir, launchCmd, this.socket);
    const liveSessionId = presetLiveId || await this._resolveLiveId(adapter, { sessionId, cwd: dir, launchedAt });
    // No killForSession — the parent's mapping and tmux are deliberately left alone.
    const entry = forkEntry({ short, tmux, cwd: dir, parentEntry, parentId, name, createdAt: launchedAt });
    entry.liveSessionId = liveSessionId || undefined;
    entry.socket = this.socket;
    this.map.set(sessionId, entry);
    this._save();
    await this.refreshAlive();
    return { sessionId, tmux };
  }

  // The card id whose conversation is `liveSessionId`, or null if no card owns it.
  // Covers the legacy pre-split shape too, where the card id IS the conversation id
  // (those entries carry no liveSessionId) — miss that and adopt would happily mint
  // a SECOND card for a conversation that already has one.
  cardForLive(liveSessionId) {
    if (!liveSessionId) return null;
    if (this.map.has(liveSessionId)) return liveSessionId;
    for (const [cardId, e] of this.map) {
      if (e.liveSessionId === liveSessionId) return cardId;
    }
    return null;
  }

  // Record that the agent swapped conversations on us. Claude's live id can change
  // with nothing on our side doing it: `/clear` abandons the running conversation
  // and starts a fresh one — new id, new transcript — in the same process and pane.
  // Only launch/fork/resume ever wrote `liveSessionId`, so the entry went on
  // pointing at the abandoned conversation: the card reverted to its pre-clear label
  // the moment the pane went away (while attached it looks fine — the live label
  // tracks the pane title), and Resume then relaunched the ABANDONED conversation,
  // orphaning everything done since the clear. buildGraph reads the true live id
  // from the pane process's session file on every rebuild, so it's the only place
  // that sees the swap — this is its write-back.
  //
  // The outgoing id is kept in `priorLiveSessionIds` because it still holds real
  // spend: usage-report.js costs every transcript a card has owned, and a file left
  // out doesn't just under-report — it misses `seenClaudeFiles` and gets its scan-
  // cache entry evicted, which for a transcript Claude Code has since deleted is the
  // permanent record. Deliberately NOT folded into `cardForLive`: an abandoned
  // conversation stays unowned so Search can Adopt it onto its own card, which is
  // the only way back to pre-clear work.
  async noteLiveSessionId(sessionId, liveSessionId, { transcriptFor = findTranscript } = {}) {
    const entry = this.map.get(sessionId);
    if (!entry || !liveSessionId || entry.liveSessionId === liveSessionId) return false;
    // A cloud card's liveSessionId must stay ABSENT — that absence is what keeps
    // `--resume`, transcript costing and the resume guards off it (see the
    // three-namespaces rule). The local pane IS a `claude` process, so it may well
    // write a `~/.claude/sessions/<pid>.json` of its own for the CLIENT; adopting
    // that id would point the card at a conversation that holds none of the work,
    // and would make Resume `--resume` it instead of attaching to the cloud session.
    if (entry.runtime === 'cloud') return false;
    // Never take over a conversation another card already owns (or that IS another
    // card id): two entries on one transcript double-count its cost and fight over
    // whose resume wins.
    const owner = this.cardForLive(liveSessionId);
    if (owner && owner !== sessionId) return false;
    // Wait for the new conversation's transcript to exist. _doResume refuses outright
    // when it can't find one, so repointing early would trade a stale-but-resumable
    // card for an unresumable one; the next rebuild retries, and findTranscript
    // caches the hit, so this costs one directory scan per clear. Gated exactly like
    // that resume guard — a discover-id agent (Codex) isn't bucketed this way, and a
    // devcontainer session's transcript lives inside the container, not on the host.
    const needsTranscript = adapterFor(entry.agent || 'claude').presetsSessionId
      && !runtimeFor(entry.runtime).skipsHostResumeGuard;
    if (needsTranscript && !(await transcriptFor(liveSessionId))) return false;
    const prior = new Set(entry.priorLiveSessionIds || []);
    if (entry.liveSessionId) prior.add(entry.liveSessionId);
    prior.delete(liveSessionId); // re-swapping back to a conversation makes it current, not prior
    entry.liveSessionId = liveSessionId;
    if (prior.size) entry.priorLiveSessionIds = [...prior];
    this._save();
    return true;
  }

  // Register a conversation that exists on disk but was never launched by us as a
  // NEW card — the third and last way a card id is minted (dispatch, fork, adopt).
  // Launches nothing: the entry lands dormant (tmux null) and the caller decides
  // whether to resume() it, so a failed launch is a card the user can retry or
  // remove rather than a half-created session.
  //
  // The conversation id goes in `liveSessionId`, never the map key: the card id is
  // never a conversation id (see CLAUDE.md), and it's this split that makes a Codex
  // rollout adoptable at all — _doResume reads `prev.liveSessionId` for a discover
  // agent, and keying the card on the rollout id would look like the "no cached id"
  // case and re-discover the wrong (most recent) rollout.
  adopt({ liveSessionId, agent = 'claude', cwd = '', intent = '' } = {}) {
    const existing = this.cardForLive(liveSessionId);
    if (existing) return { sessionId: existing, adopted: false };
    const sessionId = crypto.randomUUID();
    this.map.set(sessionId, {
      short: crypto.randomBytes(4).toString('hex'),
      tmux: null,
      cwd: cwd || null,
      agent,
      intent,
      model: null,
      effort: null,
      createdAt: Date.now(),
      liveSessionId,
    });
    this._save();
    return { sessionId, adopted: true };
  }

  // Re-copy the per-task notes into a live devcontainer session's container. Host
  // sessions follow a reassignment for free (the agent reads through the repointed
  // by-session symlink); a devcontainer session's notes were COPIED in at launch, so
  // a reassignment must re-copy notes.md to keep the in-container notes current.
  // No-op unless the entry is a devcontainer runtime with a running container (a
  // stopped/dormant container yields no cid → skip; best-effort). `run` is injectable
  // for tests (default: the module's promisified execFile).
  async syncNotesToContainer(sessionId, { run = exec } = {}) {
    const entry = this.map.get(sessionId);
    if (!entry || entry.runtime !== 'devcontainer' || !entry.cwd) return;
    const cid = await containerIdFor(entry.cwd, run);
    if (!cid) return;
    await run('docker', ['cp', '-L', linkPathFor(sessionId), `${cid}:/tmp/aw-${sessionId}/notes`]);
  }

  _load() {
    const raw = readJsonOrLoud(MAP_FILE, 'mappings.json');
    if (!raw) return; // missing/empty = first run; corrupt already logged + backed up
    for (const [sid, v] of Object.entries(raw)) this.map.set(sid, v);
  }

  _save() {
    writeJsonAtomic(MAP_FILE, Object.fromEntries(this.map));
  }

  // Size each tmux window to the most recently active client so the browser
  // sidebar and an iTerm2 window can attach at once without clamping.
  async init() {
    // main() already validated tmux is present (before acquireInstanceLock) —
    // resolve again here rather than thread the value through, so this class
    // has no dependency on being constructed after that check.
    this.tmuxBin = await resolveTmuxBin();
    // This install's own tmux socket (generated + persisted on first run). New
    // sessions launch here; legacy default-socket sessions drain over time.
    this.socket = resolveInstanceSocket();
    try {
      await this._tmux(this.socket, ['set-option', '-g', 'window-size', 'latest']);
    } catch {
      /* tmux server may not be up yet; harmless */
    }
    await this.refreshAlive();
  }

  // The single place a tmux session name is composed. `runtime` is threaded in
  // rather than composed at the call sites so the cloud prefix can't be spelled
  // two ways: a cloud pane holds the local `claude` CLIENT, not the agent, so it
  // is named by its RUNTIME (`cl_`) instead of the agent adapter's prefix — the
  // pane's process is the same `claude` binary either way, and a `cc_` name would
  // make a cloud pane indistinguishable from a real local Claude session to
  // anything reading names (attach pickers, the owned-tmux sweep).
  _tmuxName(agentId, short, runtime) {
    if (runtime === 'cloud') return `${CLOUD_TMUX_PREFIX}${short}`;
    return `${adapterFor(agentId).tmuxPrefix}${short}`;
  }

  // Resolve the durable live-session id to cache on the entry. Claude is given
  // its id at launch (presetsSessionId), so it returns immediately. Codex mints
  // its own rollout id *asynchronously* after launch, so a single probe races
  // the rollout file's creation and usually finds nothing — poll briefly until it
  // appears. Returns null only if no rollout shows up (e.g. the agent died before
  // writing one), in which case the entry stores no live id rather than a wrong one.
  async _resolveLiveId(adapter, { sessionId, cwd, launchedAt }) {
    if (adapter.presetsSessionId) return sessionId;
    for (let i = 0; i < 20; i++) {
      const id = await adapter.discoverLiveId({ cwd, launchedAt });
      if (id) return id;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  }

  // Run tmux on a specific socket (`-L <socket>`, or the default socket when the
  // name is empty). The socket is per-session: this install's generated socket for
  // its own sessions, '' for legacy default-socket ones.
  _tmux(socket, args, opts) {
    return exec(this.tmuxBin, [...tmuxSocketArgs(socket), ...args], opts);
  }

  // Create a detached tmux session for `inner` on `socket`, keeping the pane
  // visible if the command exits immediately so its error message is readable.
  // The redundant-looking `cd` is load-bearing: `-c dir` alone is NOT enough. A tmux
  // SERVER whose own cwd has been deleted (the wrangler's install dir renamed after
  // the server started, say) stops honouring `-c` and hands every new pane that dead
  // directory instead — `pwd` prints literally ".". Claude limps along there; the
  // devcontainer CLI calls process.cwd() at module load and dies before doing anything
  // (`uv_cwd` ENOENT → instantly dead pane, no session), which is how this surfaced.
  // cd'ing inside the pane command makes a launch independent of the tmux server's cwd,
  // and a genuinely missing dir then fails loudly in the pane rather than silently
  // launching the agent somewhere else. Every `inner` we build is an `&&`-chain or a
  // single command, so prefixing with `&&` can't change its precedence.
  // paneCommand is what keeps a long first prompt launchable: the intent rides inline
  // in `inner`, and tmux rejects any single command over ~16 KB, so an oversized one is
  // moved into a file the pane sources instead (see launch-script.js).
  async _newSession(tmux, dir, inner, socket) {
    const cmd = paneCommand(tmux, `cd ${shellQuote(dir)} && ${inner}`);
    await this._tmux(socket, ['new-session', '-d', '-s', tmux, '-c', dir, cmd]);
    await this._tmux(socket, ['set-option', '-t', tmux, 'remain-on-exit', 'on']).catch(() => {});
    // Hide tmux's status bar: it's purely cosmetic here (nothing reads it) and
    // its row is better spent on Claude's TUI. Scoped per-session so it can't
    // blank the bar on the user's own sessions sharing this tmux server.
    await this._tmux(socket, ['set-option', '-t', tmux, 'status', 'off']).catch(() => {});
    // Mouse on so the wheel enters tmux copy-mode scrollback instead of being
    // translated to arrow keys for the alt-screen Claude TUI (which only sees
    // them as input-history navigation and prints "use PgUp/PgDn to scroll").
    // Trade-off: in a pane whose app doesn't grab the mouse (Codex renders inline;
    // Claude grabs it), tmux owns click-drag → copy-mode. That copy still reaches
    // the browser clipboard via OSC 52 (see set-clipboard below + xterm.js's
    // ClipboardAddon, public/app.js `attachClipboard`); Option/Shift-drag also
    // does a native xterm.js selection.
    await this._tmux(socket, ['set-option', '-t', tmux, 'mouse', 'on']).catch(() => {});
    // Force set-clipboard on for THIS session so copy-mode emits the OSC 52 the
    // browser addon needs — the default is usually `external` (which also works),
    // but a user's global `set-clipboard off` would silently break browser copy.
    await this._tmux(socket, ['set-option', '-t', tmux, 'set-clipboard', 'on']).catch(() => {});
  }

  // Tee a pane's RAW output to a file so the cloud launch scrape reads unwrapped
  // bytes (see cloud-launch-watch.js for why capture-pane alone isn't enough).
  // Keyed on the card id, not the tmux name, so a resume/relaunch of the same card
  // overwrites its own log rather than accumulating one per tmux. Returns the log
  // path, or null when the pipe couldn't be set up — the watcher then relies on its
  // capture-pane fallback, so a failure here degrades rather than breaks.
  async _pipePaneToFile(tmux, socket, sessionId) {
    const dir = path.join(DATA_DIR, 'cloud-launch-logs');
    try {
      fs.mkdirSync(dir, { recursive: true });
      pruneCloudLaunchLogs(dir);
      const logPath = path.join(dir, `${sessionId}.log`);
      fs.writeFileSync(logPath, '');
      await this._tmux(socket, ['pipe-pane', '-t', tmux, '-o', `cat >> ${shellQuote(logPath)}`]);
      return logPath;
    } catch (e) {
      console.error(`[cloud] could not pipe ${tmux} to a log file:`, e?.message || e);
      return null;
    }
  }

  // Teleport: pull a running cloud session down into a fresh local worktree and
  // convert the card in place. This is the ONLY way back to full local capability
  // — transcript, cost, diff, terminal, mail and PR watching all start working
  // afterwards with no cloud-specific code on any of those paths.
  //
  // The worktree is DETACHED because `claude --teleport` checks out whatever ref the
  // cloud session was on; pre-deciding a branch would either fight that checkout or
  // record a name the session never used — so the BRANCH is read back after launch.
  // The live conversation id is not discovered but PRESET (`--session-id`): a
  // teleported session writes no transcript at all until its first human message, so
  // there is nothing on disk to find. If the teleport itself fails we deliberately do
  // NOT convert: a half-converted card (local runtime, no live id, no conversation)
  // would be unresumable, which is strictly worse than a cloud card that failed to
  // teleport.
  // `tries`/`pollMs` are injectable purely so a test can assert the conversion (and
  // the failure cleanup) without a real `claude --teleport` or a 5-second wait.
  async teleport(sessionId, { tries = TELEPORT_WATCH_TRIES, pollMs = TELEPORT_WATCH_POLL_MS } = {}) {
    const prev = this.map.get(sessionId);
    if (!prev) throw new Error('No such session.');
    if (prev.runtime !== 'cloud') throw new Error('Only a cloud session can be teleported.');
    const cloudSessionId = prev.cloud?.sessionId;
    if (!cloudSessionId) {
      throw new Error("This cloud session's id hasn't been read back from its launch yet — wait for the ☁ chip to show a session id, or open it on claude.ai.");
    }
    const repoRoot = prev.cwd ? await gitRepoRoot(prev.cwd) : null;
    if (!repoRoot) throw new Error(`Can't teleport: ${prev.cwd || 'this session'} isn't inside a git repository any more.`);
    // Reap the card's old `cl_` create pane BEFORE anything else. Once the entry's
    // tmux is repointed at the new `cc_` name, `entryByTmux` no longer resolves the
    // old one, so nothing would ever sweep it and remain-on-exit would keep it on
    // the socket forever. Safe here: the teleport command below references the
    // CLOUD session id, not the card id, so this can't reap the pane it's about to
    // create.
    await this.killForSession(sessionId);
    const short = crypto.randomBytes(4).toString('hex');
    const folderName = `${path.basename(repoRoot)}-teleport-${short}`;
    const wt = await addDetachedWorktree({ repoRoot, folderName });
    let converted = false;
    let tmux = null;
    try {
      // A local Claude session from this moment on, so it takes the ordinary `cc_`
      // prefix rather than `cl_` — the pane really is a local agent now.
      tmux = this._tmuxName('claude', short);
      // PRESET, never discovered. A teleported session writes nothing under
      // ~/.claude/projects until its first human message, so the recency scan this
      // used to do could only ever time out on a teleport that was working
      // perfectly — it made the conversion unreachable. `--session-id` is honoured
      // by `--teleport` (probed live, claude 2.1.241: the transcript lands at
      // exactly this uuid on the first message), which is strictly more robust than
      // matching on mtime anyway.
      const liveSessionId = crypto.randomUUID();
      await this._newSession(tmux, wt.path, buildTeleportCommand({ cloudSessionId, liveSessionId }), this.socket);
      // The success signal is the pane STAYING ALIVE for the whole window. A
      // teleport the CLI refuses (unknown id, no access, auth) exits within a second
      // or two; a successful one sits at an interactive prompt indefinitely.
      // Deliberately NOT a match on the CLI's "Session resumed" wording — a string
      // that can change under us must not be what decides whether a card converts.
      // The loop runs to the end rather than breaking early on the branch: the
      // branch (a detached `HEAD`) is readable on the first tick, so breaking on it
      // would leave the liveness check with a single sample and convert a card whose
      // teleport died a second later.
      let branch = null;
      for (let i = 0; i < tries; i++) {
        await new Promise((r) => setTimeout(r, pollMs));
        const dead = await this._paneDeadOutput(tmux);
        if (dead) {
          // The pane text is captured HERE, before the finally block kills it — the
          // whole reason a human reads this error is to find out what the CLI said,
          // and telling them to "check the pane" would point at something we are
          // about to destroy.
          throw new Error(`Teleport failed — \`claude --teleport\` exited instead of opening a session, so the card stays a cloud session rather than becoming a local one that can't be resumed. The pane said:\n${dead}`);
        }
        // `claude --teleport` checks out the cloud session's ref after the process
        // starts, so keep the LAST reading rather than the first: a checkout that
        // lands mid-window should be the name we record.
        const b = await this._readWorktreeBranch(wt.path);
        if (b) branch = b;
      }
      // `HEAD` (still detached) is a legitimate answer, so store it as-is rather
      // than inventing a branch name the session isn't on.
      const worktree = { path: wt.path, branch: branch || 'HEAD', repoRoot };
      const entry = this.map.get(sessionId);
      entry.short = short;
      entry.tmux = tmux;
      entry.cwd = wt.path;
      entry.socket = this.socket;
      this.convertCloudToLocal(sessionId, { worktree, liveSessionId });
      converted = true;
      await this.refreshAlive();
      return { sessionId, tmux, cwd: wt.path, branch: worktree.branch, liveSessionId };
    } finally {
      if (!converted) {
        // Kill the pane FIRST. `claude --teleport` is still running in it, and no
        // entry points at that tmux yet (the entry's tmux is only repointed on
        // success), so leaving it would orphan a live agent nothing can reach —
        // and pulling its worktree out from under it would be worse still.
        if (tmux) await this._tmux(this.socket, ['kill-session', '-t', tmux]).catch(() => {});
        // Then clean up ONLY a worktree we just created that is still empty of real
        // work: `git worktree remove` refuses a dirty one, which is exactly the
        // guard we want (the repo's "cleanup is offered, never automatic" instinct
        // for anything with content). Otherwise every retry stacks a stray
        // detached worktree.
        await this._removeEmptyWorktree(wt.path, repoRoot);
      }
    }
  }

  // "Has this pane exited, and if so what did it leave on screen?" — the teleport
  // watch's one question, answered in one call. Returns the pane's trailing output
  // (always a non-empty string, so the caller can treat it as truthy) once the pane
  // is dead, else null. `remain-on-exit` is what makes the text still readable; a
  // tmux error (pane already gone entirely) reads as "not dead" rather than
  // inventing a failure, since killing the conversion on a transient tmux hiccup
  // would be the worse mistake.
  async _paneDeadOutput(tmux) {
    let dead = false;
    try {
      const { stdout } = await this._tmux(this.socket, ['list-panes', '-t', tmux, '-F', '#{pane_dead}']);
      dead = String(stdout || '').trim().split('\n').some((l) => l.trim() === '1');
    } catch {
      return null;
    }
    if (!dead) return null;
    const text = await this._capturePane(tmux, 40, this.socket).catch(() => '');
    const trimmed = String(text || '').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-12).join('\n');
    return trimmed || '(the pane exited without printing anything)';
  }

  // The checked-out branch of a just-created worktree, or null while git hasn't
  // finished (or when HEAD is detached and git prints the literal `HEAD`, which the
  // caller treats as a real answer). File-free: one cheap git call, polled.
  async _readWorktreeBranch(dir) {
    try {
      const { stdout } = await exec('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  // `git worktree remove` refuses a dirty worktree, which is exactly the guard we
  // want: it removes the empty one this teleport just made and leaves anything with
  // real content alone. Best effort — a failure here must not mask the teleport
  // error that brought us here.
  async _removeEmptyWorktree(dir, repoRoot) {
    try {
      await exec('git', ['-C', repoRoot, 'worktree', 'remove', dir]);
    } catch {
      /* dirty, or already gone — leave it for the human */
    }
  }

  // A tmux session is only attachable if it still has a live pane. `remain-on-exit`
  // keeps exited panes around (so resume errors stay readable), but those dead
  // sessions are still listed by `list-sessions` — counting them as alive would
  // trap a session on a corpse and never re-offer Resume. So we classify per pane:
  // a session is alive if any of its panes is not dead, otherwise it's dead.
  async refreshAlive() {
    this.alive = new Set();
    this.dead = new Set();
    this.deadStatus = new Map();
    this.socketByName = new Map();
    // Scan this install's socket plus the default socket while legacy sessions
    // remain there. Each socket is a separate tmux server, so we query each and
    // remember which socket every session was found on (for attach/kill/capture).
    for (const socket of this.scanSockets()) {
      let stdout = '';
      try {
        ({ stdout } = await this._tmux(socket, ['list-panes', '-a', '-F', '#{session_name}\x1f#{pane_dead}\x1f#{pane_dead_status}']));
      } catch {
        continue; // that socket's server isn't running → nothing there
      }
      const seen = new Set();
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        const [name, dead, deadStatus] = line.split('\x1f');
        if (!name) continue;
        seen.add(name);
        this.socketByName.set(name, socket);
        if ((dead || '').trim() !== '1') this.alive.add(name);
        else if (deadStatus !== undefined && deadStatus.trim() !== '') this.deadStatus.set(name, Number(deadStatus));
      }
      for (const name of seen) if (!this.alive.has(name)) this.dead.add(name);
    }
    return this.alive;
  }

  // The socket a tmux name lives on: the last socket discovery saw it on, else the
  // owning entry's recorded socket (legacy entries → default socket '').
  socketOf(name) {
    if (this.socketByName.has(name)) return this.socketByName.get(name);
    return socketForEntry(this.entryByTmux(name), this.legacySocket);
  }

  // The tmux sockets to scan: this install's socket, plus the legacy socket while
  // any non-archived legacy session is still there.
  scanSockets() {
    return socketsToScan([...this.map.values()], this.socket, this.legacySocket);
  }

  // Auto-archive sessions whose Claude agent exited cleanly inside an owned tmux:
  // a clean exit (pane_dead_status 0) is a deliberate /exit or self-stop, so set
  // it aside as archived (recoverable via Resume) and reap the corpse — orphan-
  // proof even in the resume-fork case via killForSession. Non-zero/unknown exits
  // are left for the dead-pane path to surface on the board. `snapshotFor` lets
  // the caller inject per-session archive snapshot fields (e.g. the task), since
  // the manager doesn't know the task store. Returns the archived sessionIds.
  async reconcileExitedSessions(snapshotFor = () => ({})) {
    const deadEntries = [...this.dead].map((tmux) => {
      const sessionId = this.tmuxOwner(tmux);
      return {
        tmux,
        sessionId,
        status: this.deadStatus.has(tmux) ? this.deadStatus.get(tmux) : null,
        archived: sessionId ? this.isArchived(sessionId) : false,
        // Fed to archivableExits so it can skip cloud entries — see the
        // exits-0-is-not-finished reasoning there.
        runtime: sessionId ? this.map.get(sessionId)?.runtime : undefined,
      };
    });
    const toArchive = archivableExits(deadEntries);
    for (const { sessionId } of toArchive) {
      this.archive(sessionId, snapshotFor(sessionId) || {});
      await this.killForSession(sessionId);
    }
    return toArchive.map((d) => d.sessionId);
  }

  // Reclaim RAM from idle/snoozed sessions: given the freshly-built graph's
  // sessions (the source of live status + lastActivity, which the manager doesn't
  // own) and this install's config, tear down the tmux of each suspendable session
  // (idle past the threshold, or an explicit pending suspend that's now idle),
  // never touching working/needs-you or an attached terminal. Mirrors
  // reconcileExitedSessions: does the work, returns the affected ids. Graph data is
  // passed in as plain values, so the manager gains no graph/state-reader coupling.
  async reconcileSuspend(graphSessions = [], config = {}) {
    if (!suspendEnabled(config)) return [];
    const idleMs = suspendIdleMs(config);
    const attached = await this.attachedSessions();
    const candidates = graphSessions.map((s) => ({
      sessionId: s.sessionId,
      managed: Boolean(s.tmux),
      attached: s.tmux ? attached.has(s.tmux) : false,
      status: s.status,
      hasBackgroundShell: Boolean(s.hasBackgroundShell),
      suspendPending: Boolean(this.map.get(s.sessionId)?.suspendPending),
      lastActivity: s.lastActivity,
      label: s.label,
    }));
    const toSuspend = suspendableSessions(candidates, { idleMs, now: Date.now() });
    for (const c of toSuspend) await this.suspend(c.sessionId, { label: c.label });
    return toSuspend.map((c) => c.sessionId);
  }

  // The tmux session mapped to this id, but only if it has exited (dead pane kept
  // by remain-on-exit). Lets the UI surface the failure output and re-offer Resume.
  deadTmuxNameFor(sessionId) {
    const entry = this.map.get(sessionId);
    if (!entry) return null;
    return this.dead.has(entry.tmux) ? entry.tmux : null;
  }

  tmuxNameFor(sessionId) {
    const entry = this.map.get(sessionId);
    if (!entry) return null;
    return this.alive.has(entry.tmux) ? entry.tmux : null;
  }

  attachTargetFor(sessionId) {
    return this.tmuxNameFor(sessionId);
  }

  // Launch a new Claude session inside a named, detached tmux session.
  // Create (and return) a fresh scratch dir, never reusing an existing one.
  // `preferred` is the path the client already displayed; we honour it unless it
  // collides, in which case we append a short suffix rather than share a folder.
  _freshScratchDir(preferred) {
    let dir = preferred || path.join(SESSIONS_DIR, timestampName(new Date()));
    while (fs.existsSync(dir)) dir = `${preferred || path.join(SESSIONS_DIR, timestampName(new Date()))}-${crypto.randomBytes(1).toString('hex')}`;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // A real user-typed cwd may not exist yet; create it (mkdir -p) before launch so
  // `tmux new-session -c` doesn't silently fall back to $HOME. Mirrors
  // _freshScratchDir's create; a failure (e.g. path is a file, or no permission)
  // propagates so dispatch surfaces an error rather than launching in the wrong dir.
  _ensureCwd(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async dispatch({ cwd, intent = '', model, effort, agent = 'claude', runtime = 'local', addDirs = [], bindMemory,
                   worktree = false, worktreeBranch = '', worktreeFolderName = '', worktreeAuto = false,
                   autoMergeOnPass, workflow: workflowOpt, spawnedBy, parentSession,
                   cloudEnvironmentId = '', cloudRef = '' } = {}) {
    const trimmed = cwd && expandTilde(String(cwd).trim());
    const isCloud = runtime === 'cloud';
    // A cloud session has no local checkout at all — the VM clones from the pushed
    // remote — so a worktree would be a directory nothing ever opens, plus a branch
    // nobody is on. The dialog hides the toggle; refuse here for the paths that
    // don't go through it (spawn_session, a schedule).
    if (isCloud && worktree) {
      throw new Error('Worktree mode and Cloud are mutually exclusive: a cloud session works from the pushed remote and has no local checkout to branch.');
    }
    // Runtime preflight, BEFORE any dir/worktree side effect so a refusal is a clean
    // board error (thrown → the dispatch handler relays it as a toast), never a stray
    // scratch dir plus an opaque dead pane. e.g. the devcontainer runtime refuses a
    // repo with no .devcontainer config instead of letting `devcontainer up` try to
    // synthesize one and die in the pane.
    const rt = runtimeFor(runtime);
    // The bag is widened, not replaced: devcontainer's `preflight({ cwd })`
    // destructure ignores the extra keys. Cloud needs all four — it refuses codex,
    // refuses workflow mode, and validates the environment id's prefix before that
    // id can pick a launch form.
    const preflightErr = rt.preflight
      ? await rt.preflight({ cwd: trimmed, agent, workflow: Boolean(workflowOpt), cloud: { environmentId: cloudEnvironmentId, ref: cloudRef } })
      : null;
    if (preflightErr) throw new Error(preflightErr);
    // Blank → a fresh timestamped scratch dir; a scratch path the client proposed
    // is ensured-fresh and created here; a real user-typed path is created too
    // (mkdir -p) so it exists before tmux launches in it — but NOT in worktree
    // mode, where the path must already be a git repo (resolveWorktree rejects a
    // non-repo below), so a nonexistent path stays a clean failure rather than
    // leaving a stray empty dir behind.
    const dir = !trimmed ? this._freshScratchDir()
      : isInsideSessions(trimmed) ? this._freshScratchDir(trimmed)
      : worktree ? trimmed
      : this._ensureCwd(trimmed);
    cwd = dir;
    const short = crypto.randomBytes(4).toString('hex');
    const sessionId = crypto.randomUUID();
    const adapter = adapterFor(agent);
    const tmux = this._tmuxName(agent, short, runtime);

    // Worktree mode: create the worktree BEFORE launch and start the session in
    // it. Throws WorktreeError on refusal — abort the whole dispatch (no tmux, no
    // mapping entry). Only attempted for a real (non-scratch) git cwd.
    // Worktree mode: create the worktree BEFORE launch and start the session in
    // it. resolveWorktree refuses a blank/scratch cwd (throws WorktreeError), so a
    // bad target aborts the whole dispatch (no tmux, no entry) with a clear error
    // rather than silently launching without a worktree.
    let worktreeEntry;
    if (worktree) {
      const wt = await resolveWorktree({
        cwd, intent, branch: worktreeBranch, folderName: worktreeFolderName, auto: worktreeAuto, short,
      });
      cwd = wt.cwd;
      worktreeEntry = wt.worktree;
    }

    // The conversation runs under its own live id, distinct from the card id, so
    // the card id is never also a conversation id. Preset for Claude; Codex mints
    // and we discover it post-launch.
    // Cloud mints NO preset live id: no `--session-id` is passed (the create form
    // takes none) and no host conversation exists, so there is nothing to preset
    // and `_resolveLiveId` is never called either — a cloud entry's liveSessionId
    // stays absent, which is what keeps every transcript/cost path off it.
    const presetLiveId = (!isCloud && adapter.presetsSessionId) ? crypto.randomUUID() : undefined;
    // Only an ORCHESTRATOR run loads the issue-to-pr skill plugin; a worker (tagged
    // via `parentSession`, never `workflow`) is briefed via its intent and never
    // runs the procedure.
    const loadWorkflowSkill = Boolean(workflowOpt);
    if (agent === 'codex' && trustCodexLaunchCwd()) this._ensureCodexTrust(worktreeEntry?.repoRoot || cwd);
    // A runtime that defines `buildLaunch` REPLACES the adapter's, rather than
    // decorating it (this and _doResume are its only two read sites). Cloud needs
    // that because a cloud launch is a different `claude` invocation entirely — no
    // --session-id, no --mcp-config, no --add-dir, no appended prompt: none of it
    // can reach the VM.
    const rawInner = rt.buildLaunch
      ? rt.buildLaunch({ mode: 'dispatch', cwd, sessionId, intent, cloud: { environmentId: cloudEnvironmentId, ref: cloudRef } })
      : adapter.buildLaunch({ sessionId, liveSessionId: presetLiveId, cwd, intent, model, effort, addDirs, worktree: worktreeEntry || null, workflow: loadWorkflowSkill, spawnedBy });
    // Bind the per-session memory link to its task (or scratch) BEFORE launch, so
    // AW_TASK_MEMORY and --add-dir resolve the moment the agent boots — and BEFORE
    // wrapLaunch, so the devcontainer runtime's `docker cp` of the memory dir sees
    // a real symlink target rather than a not-yet-created one. dispatch mints the
    // sessionId, so the caller hands in a binder rather than doing it after the
    // launch returns.
    //
    // Still called for a cloud dispatch even though the launch injects NO
    // AW_TASK_MEMORY (the VM can't see a host path) — "bound but not injected"
    // looks like a bug otherwise. The bind creates the dir and the per-session
    // symlink so the human's notes UI works on a cloud card exactly like any
    // other, and so a later Teleport conversion finds the memory already wired.
    bindMemory?.(sessionId);
    const inner = await rt.wrapLaunch({ inner: rawInner, cwd, sessionId, worktree: worktreeEntry || null, workflow: loadWorkflowSkill });
    const launchedAt = Date.now();
    await this._newSession(tmux, cwd, inner, this.socket);

    // Cloud: start piping the pane's raw output to a file and scrape it for the new
    // `session_…` id / claude.ai URL. Deliberately NOT awaited — a cloud dispatch
    // must return as fast as any other, and the pills fill in on a later graph poll
    // (buildGraph reads the entry, so there's no rebuild plumbing to thread).
    if (isCloud) {
      const logPath = await this._pipePaneToFile(tmux, this.socket, sessionId);
      Promise.resolve(this._cloudLaunch({ sessionManager: this, sessionId, tmux, socket: this.socket, logPath }))
        .catch((e) => console.error(`[cloud] launch scrape for ${sessionId} failed:`, e?.message || e));
    }

    const liveSessionId = isCloud ? undefined : (presetLiveId || await this._resolveLiveId(adapter, { sessionId, cwd, launchedAt }));

    // Merge onto any entry an early setWorkflowPhase already adopted (the process is
    // alive before this map.set, so the skill can report a phase first). The launch
    // workflowOpt is authoritative for the initial marker; fall back to the adopted
    // one so a pre-launch phase report isn't clobbered for a non-workflow dispatch.
    const existing = this.map.get(sessionId);
    const nestedParent = parentSession || existing?.parentSession;
    // A `nest:true` spawn (spawn_session) sets `parentSession` here directly —
    // the session is a CHILD from the moment it's created, so this is the
    // creation-time "new child" snapshot the settings copy promises (see
    // attachSession's matching comment). Only when unset: a pre-adopted entry
    // (an early setWorkflowPhase report landing before this map.set) may
    // already carry one.
    const childFullView = nestedParent && existing?.childFullView === undefined ? childFullViewByDefault() : existing?.childFullView;
    const entry = { ...existing, short, tmux, cwd, agent, runtime: runtime === 'local' ? undefined : runtime, intent, model: model || null, effort: effort || null, createdAt: launchedAt, liveSessionId: liveSessionId || undefined, worktree: worktreeEntry, socket: this.socket, workflow: workflowOpt ?? existing?.workflow, autoMergeOnPass: autoMergeOnPass ? true : (existing?.autoMergeOnPass || undefined), spawnedBy: spawnedBy || undefined, parentSession: nestedParent, childFullView, mailCapable: !isCloud };
    if (isCloud) {
      // `sessionId` is the third id namespace's placeholder: `cloud.sessionId` is
      // the CLOUD session's own `session_…` handle, filled in post-launch by the log
      // scrape. It is NEVER the card id and never `liveSessionId` — and it must
      // never be `--resume`d (it isn't a conversation id at all; `claude --cloud
      // <session_…>` attaches to it and `claude --teleport <session_…>` pulls it
      // local).
      entry.cloud = {
        sessionId: null,
        url: null,
        environmentId: cloudEnvironmentId || null, // null = the account default environment
        kind: classifyEnvironmentId(cloudEnvironmentId) === 'self-hosted' ? 'self-hosted' : 'anthropic',
        createdAt: launchedAt,
      };
    }
    this.map.set(sessionId, entry);
    this._save();
    await this.refreshAlive();
    return { sessionId, tmux, cwd };
  }
}

export { buildInnerCommand, withCleanClaudeEnv };
