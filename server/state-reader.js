import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import chokidar from 'chokidar';
import { discoverClaudeSessions, capturePane, classify, claudeTitle, hasBackgroundShell as detectBackgroundShell } from './tmux-scraper.js';
import { CLAUDE_DIR, SESSIONS_DIR, readJsonSafe, statusOf, liveStatusDecision, liveState } from './claude-paths.js';
import { adapterFor } from './agents/index.js';
import { runtimeFor } from './runtimes/index.js';
import { worktreeStatus } from './worktree.js';
import { repoSlugFor } from './repo-slug.js';
import { isLegacyWorkerWorkflow } from './workflow.js';
import { usageSince } from './transcript-reader.js';

const execp = promisify(execFile);

// pid -> { tty, cpu } for every process, from one `ps` call. A real `ttysNNN`
// means the session lives in an open terminal window; `??` means background.
async function procInfo() {
  const map = new Map();
  try {
    const { stdout } = await execp('ps', ['-axo', 'pid=,tty=,%cpu=']);
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\S+)\s+([\d.]+)/);
      if (m) map.set(Number(m[1]), { tty: m[2], cpu: parseFloat(m[3]) });
    }
  } catch {
    /* ps unavailable */
  }
  return map;
}

const ROSTER = path.join(CLAUDE_DIR, 'daemon', 'roster.json');
const JOBS_DIR = path.join(CLAUDE_DIR, 'jobs');

const WORKTREE_MARKER = '/.claude/worktrees/';

// Real checked-out branch for a cwd: walk up to the gitdir (handles linked
// worktrees, where <cwd>/.git is a file pointing at the gitdir) and read HEAD.
// Returns the branch name, a short sha for a detached HEAD, or null. File reads
// only — no `git` subprocess, since buildGraph runs on every state change.
async function readBranch(cwd) {
  try {
    let dir = path.resolve(cwd);
    let entry = null;
    for (let i = 0; i < 40; i++) {
      const cand = path.join(dir, '.git');
      const st = await fsp.stat(cand).catch(() => null);
      if (st) { entry = { cand, isFile: st.isFile() }; break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!entry) return null;
    let gitDir = entry.cand;
    if (entry.isFile) {
      const m = (await fsp.readFile(entry.cand, 'utf8')).match(/gitdir:\s*(.+)/);
      if (!m) return null;
      gitDir = path.resolve(dir, m[1].trim());
    }
    const head = (await fsp.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return ref ? ref[1] : head.slice(0, 8) || null;
  } catch {
    return null;
  }
}

// In-flight tasks for a background job (running tool calls, queued work).
function readJobInFlight(jobId) {
  if (!jobId) return null;
  const data = readJsonSafe(path.join(JOBS_DIR, jobId, 'state.json'));
  if (!data) return null;
  const f = data.inFlight || {};
  return { running: f.tasks ?? 0, queued: f.queued ?? 0, kinds: f.kinds || [] };
}

// A generic nesting link ("this session is a child of that session"), derived
// read-side from a mapping entry. `entry.workflow` narrows to orchestrator-only
// ({issue,phase,startedAt}); a legacy pre-migration entry may still carry the old
// worker shape `{parent: <id>}` with none of those fields — recognize it and fold
// it into `parentSession` (nulling `workflow`) so `isWorkflowRun` (Boolean(workflow))
// doesn't wrongly read a stale legacy worker as its own orchestrator run. No write-
// back — this runs on every buildGraph, mirroring the `liveSessionId` legacy pattern.
function deriveParentSession(entry) {
  const raw = entry?.workflow;
  const legacyWorker = isLegacyWorkerWorkflow(raw);
  return {
    workflow: legacyWorker ? null : (raw || null),
    parentSession: entry?.parentSession ?? (legacyWorker ? raw.parent : null),
    spawnedBy: entry?.spawnedBy ?? null,
  };
}

// Pull every "--add-dir <path>" occurrence out of a flat arg array.
function extractAddDirs(args) {
  const dirs = [];
  if (!Array.isArray(args)) return dirs;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--add-dir' && args[i + 1]) dirs.push(args[i + 1]);
  }
  return dirs;
}

// Build the live "agent team" member rows for a lead session: each teammate is a
// full Claude running in its OWN pane of the SAME tmux session as the lead. They
// write no ~/.claude/sessions/<pid>.json, so there's no hook status — scrape the
// member's specific pane (paneId is server-unique, so `-t %N` targets it) for the
// working/idle signal, exactly like a pane-scraped agent (no needs-you). Purely
// descriptive: teammates are not wrangler sessions (no card id, no attach, no cost).
async function buildTeammates(entries) {
  const out = [];
  for (const e of entries) {
    const text = e.paneId ? await capturePane(e.paneId, 60, e.socket || '') : '';
    out.push({
      name: e.member.name || e.member.agentType || 'teammate',
      agentType: e.member.agentType || null,
      color: e.member.color || null,
      status: e.paneId ? classify(text).status : 'unknown',
      paneId: e.paneId || null,
    });
  }
  return out;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but owned by another user
  }
}

// Read all session descriptors written by every live Claude process, skipping
// stale files whose process has already exited.
function readSessions() {
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const data = readJsonSafe(path.join(SESSIONS_DIR, f));
    if (data && data.sessionId && isAlive(data.pid)) out.push(data);
  }
  return out;
}

// Index the daemon roster by sessionId for intent/name/add-dir enrichment.
function readRosterBySession() {
  const roster = readJsonSafe(ROSTER);
  const map = new Map();
  if (!roster?.workers) return map;
  for (const w of Object.values(roster.workers)) {
    if (w?.sessionId) map.set(w.sessionId, w);
  }
  return map;
}

function addDirsFromWorker(worker) {
  if (!worker?.dispatch) return [];
  const { respawnFlags, launch } = worker.dispatch;
  return [
    ...extractAddDirs(respawnFlags),
    ...extractAddDirs(launch?.flagArgs),
    ...extractAddDirs(launch?.args),
  ];
}

// Claude Code titles a freshly-launched session with its own auto "agent" name —
// the cwd basename plus an optional short hex hash, e.g. `enterprise-3f` — and
// holds it there until it regenerates a conversation summary (a just-resumed
// session often never does). That name otherwise outranks `intent`/`summary` in
// `sessionLabel` below, flipping a meaningful card to junk the moment the pane is
// scraped, so we treat it as no title and fall through. The basename is matched
// verbatim (regex-escaped), the hex tail case-insensitively; a real summary is a
// phrase (spaces, non-hex words) so it won't collide.
function isAutoAgentTitle(title, cwd) {
  const base = cwd ? path.basename(cwd) : '';
  if (!base) return false;
  const t = String(title || '');
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^${esc}(-[0-9a-f]+)?$`, 'i').test(t)) return true;
  // For a long basename, Claude Code truncates it mid-word before appending the
  // hex tail (e.g. "…open-te-04" for a "…open-terminal" cwd), so the exact match
  // above misses it. Treat a substantial truncated prefix (+ optional hex tail)
  // as the same placeholder — a real summary is a phrase, so it can't collide
  // with a bare dash-joined prefix of the cwd basename.
  const stripped = t.replace(/-[0-9a-f]+$/i, '');
  return stripped.length >= base.length / 2 && stripped.length < base.length
    && base.toLowerCase().startsWith(stripped.toLowerCase());
}

// Single source of truth for a session's display label, shared by all three
// build sites so live, resumed, and dormant sessions read identically. Explicit
// human-chosen names (user rename, live-fork name, dispatch seed name) win as-is;
// next is `liveTitle` — the summary Claude itself writes to the terminal title,
// so a card mirrors exactly what the agent's iTerm tab shows — then the
// auto-derived intent or transcript summary. `liveTitle` exists only for sessions
// with a live pane, so dormant/history sessions fall through to intent/summary as
// before. Labels are returned in full — the UI clips them to the available width
// via CSS ellipsis, so a fixed-character cap here would truncate short of the
// space a card has. The "(resumed)" placeholder and blanks count as absent — a
// resumed session with no real name falls through to its summary/cwd rather than
// literally showing it.
function sessionLabel({ names = [], liveTitle, aiTitle, intent, summary, cwd, fallback } = {}) {
  // The auto-name filter applies to every candidate, not just `liveTitle`: it
  // also leaks into the cached `lastLabel` (snapshotted from a poisoned display
  // label), the live fork's session-file `name`, and the transcript summary. The
  // final cwd-basename fallback below is intentionally NOT filtered — it's the
  // honest "nothing better" label, whereas an auto-name must never preempt a real
  // intent/summary.
  const clean = (s) => {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    return !t || t === '(resumed)' || isAutoAgentTitle(t, cwd) ? '' : t;
  };
  for (const n of names) {
    const c = clean(n);
    if (c) return c;
  }
  const live = clean(liveTitle);
  if (live) return live;
  const derived = clean(aiTitle) || clean(intent) || clean(summary);
  if (derived) return derived;
  return (cwd ? path.basename(cwd) : '') || fallback || '';
}

// A fork is shown as `[FORK] <label>` while it has no user-chosen name — i.e. an
// un-named fork or one still showing the inherited parent name (`nameInherited`).
// Once the user renames it (or set an explicit fork title), the name is theirs and
// shows as-is, no marker. `forkedFrom` marks a fork.
function withForkMark(label, entry) {
  if (!entry?.forkedFrom) return label;
  const userNamed = entry.name && !entry.nameInherited;
  if (userNamed || label.startsWith('[FORK] ')) return label;
  return `[FORK] ${label}`;
}

// Build the folder + session graph from the raw state, enriched by the
// session-manager (tmux ownership) and an optional cost/sub-agent provider.
// `discover` is a test seam (defaults to the real tmux scan) so the pane→node
// logic — team-member routing and the dedup — is testable without a live tmux.
export async function buildGraph(sessionManager, enrich, { runtimeResolver = runtimeFor, discover = discoverClaudeSessions, capture = capturePane, mailStore } = {}) {
  const now = Date.now();
  // The mail pill's data, keyed on card id like every other per-session field —
  // omitted entirely (undefined) when no mailStore is injected, so a caller that
  // doesn't pass one (most tests) sees no `mail` field rather than a fabricated
  // empty one.
  const mailInfo = (sid) => (mailStore ? mailStore.unreadInfo(sid, now) : undefined);
  const sessions = readSessions();
  const roster = readRosterBySession();

  // Discover every Claude session running in tmux (not just app-launched ones)
  // so they're all attachable, keyed by the live `claude` pid.
  let pidToTmux = new Map();
  let discovered = [];
  try {
    discovered = await discover(sessionManager?.scanSockets?.() || ['']);
  } catch {
    /* tmux not available */
  }
  // A COLD devcontainer dispatch spends 1–2 min in `devcontainer up` + postCreateCommand
  // before `claude` starts. During that window the pane runs the bring-up wrapper, which
  // has no `claude` token for discoverClaudeSessions to match (and the joined launch
  // script's `claude` tail is past ps's command-column truncation), so the session isn't
  // discovered and would fall to the dormant loop below as a "Resume" card despite a live,
  // building container. Detect it by tmux LIVENESS instead (immune to that quirk): an owned
  // devcontainer entry whose tmux is alive but wasn't discovered is a bring-up in progress —
  // synthesize a discovered record so the normal live-tmux loop scrapes + classifies it into
  // a working/needs-you node with the "starting container" hint (attachable during bring-up).
  // Devcontainer-only: a host session's pane IS `claude`, so it's always discovered. A null
  // pid is safe (liveState/procInfo tolerate it → no cost/tty until claude runs). Fallback-
  // only: skips a tmux already in `discovered`, so it never double-counts a running session.
  const discoveredTmux = new Set(discovered.map((d) => d.tmuxName));
  for (const entry of sessionManager?.activeEntries?.() || []) {
    if (entry.runtime !== 'devcontainer') continue;
    const tmuxName = sessionManager?.tmuxNameFor?.(entry.sessionId);
    if (!tmuxName || discoveredTmux.has(tmuxName)) continue;
    discovered.push({ tmuxName, socket: sessionManager?.socketOf?.(tmuxName) ?? '', claudePid: null, agent: entry.agent || 'claude', cwd: entry.cwd, command: '', paneTitle: '' });
    discoveredTmux.add(tmuxName);
  }
  const proc = await procInfo();

  // An "agent team" runs each teammate as a full Claude in its OWN pane of the
  // lead's tmux session, so `discovered` (one entry per pane) holds >1 entry for
  // one session name — the second, third, … are team members, not their own
  // sessions. Split them out: a member becomes a `teammates` row on its lead node
  // (grouped by shared tmux name); the rest are the primary session panes. This is
  // load-bearing — every keyed map below is built from PRIMARY panes so a member
  // pane can't overwrite the lead's title/status ("last pane wins") nor synthesize
  // a phantom duplicate card sharing the lead's id.
  const teammatesByTmux = new Map();
  const primary = [];
  for (const d of discovered) {
    const member = adapterFor(d.agent)?.parseTeamMember?.(d.command);
    if (member) {
      if (!teammatesByTmux.has(d.tmuxName)) teammatesByTmux.set(d.tmuxName, []);
      teammatesByTmux.get(d.tmuxName).push({ ...d, member });
    } else {
      primary.push(d);
    }
  }
  pidToTmux = new Map(primary.map((d) => [d.claudePid, d.tmuxName]));

  // The live Claude running in each owned tmux, keyed by tmux name: its post-fork
  // session id, hook-written status, and dispatch name. A resume forks the
  // conversation under a new id, so the *owner* id's own session file goes frozen;
  // this lets both passes below read the running fork's live state instead.
  const liveByTmux = new Map();
  for (const d of primary) {
    const ls = liveState(d.claudePid);
    if (ls) liveByTmux.set(d.tmuxName, ls);
  }

  // The summary Claude wrote to each owned pane's title (glyph stripped), keyed by
  // tmux name — the primary auto-label so a card reads like the agent's own tab.
  const titleByTmux = new Map(primary.map((d) => [d.tmuxName, claudeTitle(d.paneTitle)]));

  const folders = new Map(); // path -> node
  const ensureFolder = (p) => {
    if (!p) return null;
    if (!folders.has(p)) {
      const isWorktree = p.includes(WORKTREE_MARKER);
      folders.set(p, {
        id: `folder:${p}`,
        type: 'folder',
        path: p,
        label: path.basename(p) || p,
        isWorktree,
      });
    }
    return folders.get(p);
  };

  const nodes = [];
  const edges = [];
  const sessionList = [];
  // Dedupe branch lookups across sessions that share a cwd within this build;
  // cache the promise so concurrent identical lookups collapse to one read.
  const branchCache = new Map();
  const branchFor = (cwd) => {
    if (!cwd) return Promise.resolve(null);
    if (!branchCache.has(cwd)) branchCache.set(cwd, readBranch(cwd));
    return branchCache.get(cwd);
  };
  const seen = new Set();

  for (const s of sessions) {
    if (seen.has(s.sessionId)) continue;
    seen.add(s.sessionId);

    // Archived sessions belong in graph.history, never on the board — even if
    // their process is still alive (the kill may lag or fail). Curation wins.
    if (sessionManager?.isArchived?.(s.sessionId)) continue;

    // Skip forked copies created by Resume: a tmux session we own but mapped to
    // a *different* (original) session id. The original node represents it.
    const discTmux = pidToTmux.get(s.pid) || null;
    const forkOwner = discTmux && sessionManager?.tmuxOwner ? sessionManager.tmuxOwner(discTmux) : null;
    if (forkOwner && forkOwner !== s.sessionId) continue;

    // The board is a curated view of wrangler-managed sessions only. A live
    // Claude is managed iff it has a mapping entry (launched/adopted by us) or
    // runs inside a tmux we own. Bare sessions started elsewhere are not shown
    // automatically — they're brought in deliberately via Search's Adopt.
    const managedSession = Boolean(sessionManager?.entryFor?.(s.sessionId)) || Boolean(forkOwner);
    if (!managedSession) continue;

    // Our owned tmux for this session is actually running a *fork* (a resume gave
    // the live Claude a new id) — so this id's own session file is frozen at
    // whatever it last wrote (e.g. a stale "waiting"). Skip it here and let the
    // synthesized-node pass below represent it from the running fork's live
    // status/title instead of the corpse. Without this the card sticks on the
    // pre-resume state (e.g. "needs you" while the fork is busy).
    const ownTmux = sessionManager?.tmuxNameFor?.(s.sessionId) || null;
    const liveHere = ownTmux ? liveByTmux.get(ownTmux) : null;
    if (liveHere?.liveSid && liveHere.liveSid !== s.sessionId) continue;

    const worker = roster.get(s.sessionId);
    const cwd = s.cwd || worker?.cwd;
    const addDirs = [...new Set(addDirsFromWorker(worker))];
    // Attachable if the app launched it OR we discovered it running in tmux.
    const tmux = sessionManager?.tmuxNameFor(s.sessionId) || discTmux || null;
    // A mapped tmux whose command exited (kept by remain-on-exit) isn't attachable,
    // but its last output explains why a resume failed — surface it for the UI.
    const deadTmux = !tmux ? sessionManager?.deadTmuxNameFor?.(s.sessionId) : null;
    const exitOutput = deadTmux ? (await capture(deadTmux, 40, sessionManager?.socketOf?.(deadTmux) ?? '')).trim() || null : null;
    const intent = worker?.dispatch?.seed?.intent ?? '';

    const mapEntry = sessionManager?.entryFor?.(s.sessionId);
    const enrichment = enrich ? await enrich(s.sessionId, { since: usageSince(mapEntry) }) : null;
    const agentId = mapEntry?.agent || 'claude';
    const name = sessionLabel({
      names: [mapEntry?.name, s.name && s.name !== s.jobId ? s.name : null, worker?.dispatch?.seed?.name],
      liveTitle: tmux ? titleByTmux.get(tmux) : null,
      aiTitle: enrichment?.aiTitle,
      intent: intent || mapEntry?.intent,
      summary: enrichment?.summary,
      cwd,
      fallback: s.sessionId.slice(0, 8),
    });

    // The "needs you" (waiting) state comes from the session file's own status;
    // for attachable sessions we only scrape the pane to fill in working/idle
    // when the file reports nothing.
    // Trust a recognized file status; surface a reported-but-unrecognized one as
    // 'unknown' (visible, never idle); pane-scrape only when nothing was reported.
    // hasBackgroundShell has no file-status equivalent, so it needs the pane
    // text regardless — captured once here and reused for both checks rather
    // than scraping twice.
    let status = liveStatusDecision(s.status);
    const paneText = tmux ? await capture(tmux, 60, sessionManager?.socketOf?.(tmux) ?? '') : '';
    if (status === 'scrape') status = tmux ? classify(paneText).status : 'unknown';
    // Claude's own 'shell' status (→ working) means "a Bash tool is tracked as
    // live" — it covers both a still-blocking foreground command AND a detached
    // run_in_background job the turn has already ended on; the file can't tell
    // those apart, but the pane can (a still-blocking command keeps "esc to
    // interrupt" visible). Trust the pane here rather than a 'shell' status that
    // can go stale for as long as the job runs (verified against a real session:
    // frozen 20+ minutes after the pane itself reached its idle prompt) — else a
    // detached background job pins the card at "busy" for its entire lifetime.
    if (s.status === 'shell' && tmux && classify(paneText).status === 'idle') status = 'idle';
    // A dropped API connection ends the turn with no permission request, so the
    // status file reports idle/unknown even though the response is incomplete —
    // surface it as needs-you instead of a silent "done" (see transcript-reader's
    // apiError tracking). Skipped when the file already says working/needs-you.
    const apiErrorNeedsYou = Boolean(enrichment?.apiError) && status !== 'working' && status !== 'needs-you';
    if (apiErrorNeedsYou) status = 'needs-you';
    // Each agent's CLI renders its own "a background job is running" marker —
    // detectBackgroundShell is keyed on agentId (see tmux-scraper.js).
    const hasBackgroundShell = tmux ? detectBackgroundShell(paneText, agentId) : false;
    const parentFields = deriveParentSession(mapEntry);
    const teammates = tmux && teammatesByTmux.has(tmux) ? await buildTeammates(teammatesByTmux.get(tmux)) : [];

    const session = {
      id: `session:${s.sessionId}`,
      type: 'session',
      sessionId: s.sessionId,
      pid: s.pid,
      label: name,
      agent: agentId,
      status,
      hasBackgroundShell,
      rawStatus: s.status || null,
      waitingFor: apiErrorNeedsYou ? 'API error — connection closed mid-response' : (s.waitingFor || null),
      kind: s.kind || worker?.dispatch?.source || 'unknown',
      cwd,
      branch: await branchFor(cwd),
      repoSlug: await repoSlugFor(cwd),
      addDirs,
      intent,
      createdAt: mapEntry?.createdAt || null,
      model: mapEntry?.model || null,
      snooze: mapEntry?.snooze || null,
      runtime: mapEntry?.runtime || null,
      workflow: parentFields.workflow,
      parentSession: parentFields.parentSession,
      spawnedBy: parentFields.spawnedBy,
      autoFixPrChecks: mapEntry?.autoFixPrChecks ?? true,
      autoMergeOnPass: mapEntry?.autoMergeOnPass ?? false,
      childFullView: mapEntry?.childFullView ?? null,
      links: mapEntry?.links || [],
      worktree: await worktreeStatus(mapEntry?.worktree),
      jobId: s.jobId || null,
      tasks: readJobInFlight(s.jobId),
      updatedAt: s.updatedAt || null,
      lastActivity: enrichment?.lastActivity ?? null,
      tty: proc.get(s.pid)?.tty ?? null,
      cpu: proc.get(s.pid)?.cpu ?? null,
      managed: Boolean(tmux),
      // A live-restart (or dormant Resume) is mid-flight for this card: the client
      // holds the card in place and shows a "restarting" badge instead of the
      // dormant re-skin during the kill→relaunch gap. Keyed on the card id, the
      // same key resume()/_resuming uses.
      restarting: Boolean(sessionManager?.isResuming?.(s.sessionId)),
      tmux,
      socket: tmux ? (sessionManager?.socketOf?.(tmux) ?? '') : null,
      exitOutput,
      usd: enrichment?.usd ?? null,
      advisorUsd: enrichment?.advisorUsd ?? null,
      tokens: enrichment?.tokens ?? null,
      subAgents: enrichment?.subAgents ?? [],
      teammates,
      mail: mailInfo(s.sessionId),
    };
    sessionList.push(session);
    nodes.push(session);

    // Folder reach: cwd + every granted directory.
    const reach = [cwd, ...addDirs].filter(Boolean);
    for (const fp of reach) {
      ensureFolder(fp);
      edges.push({ id: `${session.id}->folder:${fp}`, source: session.id, target: `folder:${fp}` });
    }

    // Sub-agents as dashed child nodes.
    for (const sa of session.subAgents) {
      const said = `subagent:${s.sessionId}:${sa.id}`;
      nodes.push({
        id: said,
        type: 'subagent',
        label: sa.label,
        agentType: sa.agentType,
        parent: session.id,
      });
      edges.push({ id: `${session.id}->${said}`, source: session.id, target: said });
    }
  }

  // Synthesize nodes for wrangler-owned tmux sessions that have no live session
  // file under their owner id — chiefly a Resume fork, which runs under a new id
  // inside a tmux we own, so the main loop filters the fork out and the owned
  // tmux would otherwise go unrepresented. Only tmuxes we own qualify; foreign
  // tmuxes started outside the wrangler stay off the board (Search's Adopt
  // brings one in by resuming it into a tmux of our own).
  // Iterate PRIMARY panes only (team-member panes are folded into their lead's
  // `teammates` below, never their own node). `synthesized` dedupes by realSid so
  // two primary panes of one owned tmux (any multi-pane case) can't emit two nodes
  // sharing the same `session:<realSid>` id — the phantom-duplicate-card bug.
  const usedTmux = new Set(sessionList.map((s) => s.tmux).filter(Boolean));
  const synthesized = new Set();
  for (const d of primary) {
    if (usedTmux.has(d.tmuxName)) continue;
    const appEntry = sessionManager?.entryByTmux?.(d.tmuxName) || null;
    if (!appEntry) continue;
    const realSid = appEntry.sessionId;
    if (synthesized.has(realSid)) continue;
    synthesized.add(realSid);
    // An archived session that's still running in tmux stays off the board.
    if (sessionManager?.isArchived?.(realSid)) continue;
    const fcwd = d.cwd || appEntry?.cwd;
    const agentId = appEntry?.agent || d.agent || 'claude';
    const adapter = adapterFor(agentId);
    // The Claude actually running in this owned tmux may be a Resume fork with a
    // *different* id than the owner. Read its live id + hook-written status from
    // the pane process's session file and enrich from that live id, so status,
    // cost, and activity track the running session — not the frozen owner-id
    // transcript. Fall back to a pane scrape + owner enrichment when the file is
    // absent (no regression for sessions without a hook-written file).
    const runtime = runtimeResolver(appEntry?.runtime);
    const live = (runtime.readLive ? await runtime.readLive({ entry: appEntry, tmuxName: d.tmuxName, socket: d.socket }) : null)
      || adapter.readLive({ pid: d.claudePid, cwd: d.cwd })
      || (adapter.presetsSessionId
        ? null
        : { liveSid: appEntry?.liveSessionId || await adapter.discoverLiveId({ cwd: fcwd, launchedAt: 0 }), status: 'unknown', name: null, waitingFor: null });
    // The running conversation is the truth, and it can be one the entry has never
    // heard of: `/clear` swaps the live id under us. Persist it — this read is the
    // only place that sees the swap, and left unrecorded the entry keeps pointing at
    // the abandoned conversation (stale label once dormant, and Resume brings the
    // abandoned one back). No-ops when unchanged; see noteLiveSessionId.
    if (live?.liveSid) await sessionManager?.noteLiveSessionId?.(realSid, live.liveSid);
    const enr = (runtime.analyze ? await runtime.analyze({ entry: appEntry, liveSid: live?.liveSid || appEntry?.liveSessionId }) : null)
      || await adapter.analyze(live?.liveSid || appEntry?.liveSessionId || realSid, { since: usageSince(appEntry) });
    // A recognized live status wins (Claude's mapped status, or Codex's). Else
    // surface a reported-but-unrecognized status as 'unknown', and only scrape when
    // nothing was reported (Codex has no status file → live.rawStatus is absent).
    let status = live && live.status !== 'unknown' ? live.status : liveStatusDecision(live?.rawStatus);
    const paneText = await capture(d.tmuxName, 60, d.socket || '');
    // classify() may also carry a hint (e.g. devcontainer bring-up/failure) alongside
    // the status — only meaningful on the scrape branch, since a recognized live
    // status above already has its own waitingFor (needs-you) or none (working/idle).
    let scrapeWaitingFor = null;
    if (status === 'scrape') { const c = classify(paneText); status = c.status; scrapeWaitingFor = c.waitingFor || null; }
    // Same override as the managed-session pass above: Claude's 'shell' status
    // can go stale for as long as a detached background job runs, well past the
    // pane's own idle prompt — trust the pane over it. `live.status` above is
    // already mapped, so `rawStatus` is the only way to tell 'shell' from 'busy'.
    if (live?.rawStatus === 'shell' && classify(paneText).status === 'idle') status = 'idle';
    // See the managed-session pass above: a dropped API connection ends the turn
    // without a permission request, so surface it as needs-you rather than idle.
    const apiErrorNeedsYou = Boolean(enr?.apiError) && status !== 'working' && status !== 'needs-you';
    if (apiErrorNeedsYou) status = 'needs-you';
    // Each agent's CLI renders its own "a background job is running" marker —
    // detectBackgroundShell is keyed on agentId (see tmux-scraper.js).
    const hasBackgroundShell = detectBackgroundShell(paneText, agentId);
    const sid = realSid;
    const parentFields = deriveParentSession(appEntry);
    const teammates = teammatesByTmux.has(d.tmuxName) ? await buildTeammates(teammatesByTmux.get(d.tmuxName)) : [];
    const session = {
      id: `session:${sid}`,
      type: 'session',
      sessionId: sid,
      agent: agentId,
      liveSessionId: live?.liveSid || null,
      pid: d.claudePid,
      // A user rename on the mapping wins; else the live fork's own dispatch name
      // (the original title) before the "(resumed)" intent placeholder.
      label: withForkMark(
        sessionLabel({
          names: [appEntry?.name, live?.name],
          liveTitle: claudeTitle(d.paneTitle),
          aiTitle: enr?.aiTitle,
          intent: appEntry?.intent,
          summary: enr?.summary,
          cwd: fcwd,
          fallback: d.tmuxName,
        }),
        appEntry,
      ),
      status,
      hasBackgroundShell,
      rawStatus: null,
      waitingFor: apiErrorNeedsYou ? 'API error — connection closed mid-response' : (live?.waitingFor || scrapeWaitingFor || null),
      kind: 'tmux',
      cwd: fcwd,
      branch: await branchFor(fcwd),
      repoSlug: await repoSlugFor(fcwd),
      addDirs: [],
      intent: appEntry?.intent || '',
      createdAt: appEntry?.createdAt || null,
      model: appEntry?.model || null,
      snooze: appEntry?.snooze || null,
      runtime: appEntry?.runtime || null,
      workflow: parentFields.workflow,
      parentSession: parentFields.parentSession,
      spawnedBy: parentFields.spawnedBy,
      autoFixPrChecks: appEntry?.autoFixPrChecks ?? true,
      autoMergeOnPass: appEntry?.autoMergeOnPass ?? false,
      childFullView: appEntry?.childFullView ?? null,
      links: appEntry?.links || [],
      worktree: await worktreeStatus(appEntry?.worktree),
      jobId: null,
      // Carry a real, monotonic updatedAt so the client can tell needs-you
      // episodes apart (isAcknowledged matches on it). A bare null here made
      // every episode look acknowledged (null===null), so the alarm ring never
      // re-armed. The live file's stamp is authoritative for a resume-fork; a
      // pure-scrape session (no live file) falls back to its last activity.
      updatedAt: live?.updatedAt ?? enr?.lastActivity ?? null,
      lastActivity: enr?.lastActivity ?? null,
      tty: proc.get(d.claudePid)?.tty ?? null,
      cpu: proc.get(d.claudePid)?.cpu ?? null,
      managed: true,
      restarting: Boolean(sessionManager?.isResuming?.(realSid)),
      tmux: d.tmuxName,
      socket: d.socket || '',
      usd: enr?.usd ?? null,
      advisorUsd: enr?.advisorUsd ?? null,
      tokens: enr?.tokens ?? null,
      subAgents: enr?.subAgents ?? [],
      teammates,
      mail: mailInfo(sid),
    };
    sessionList.push(session);
    nodes.push(session);
    if (fcwd) {
      ensureFolder(fcwd);
      edges.push({ id: `${session.id}->folder:${fcwd}`, source: session.id, target: `folder:${fcwd}` });
    }
  }

  // On-board sessions we launched that have no live process right now (terminal
  // killed, crashed, or wiped by a reboot). They persist on the board via their
  // mapping and offer Resume, until the user explicitly archives them. mappings
  // survive restarts, so this is what makes the board outlive its processes.
  const representedSids = new Set(sessionList.map((s) => s.sessionId));
  for (const entry of sessionManager?.activeEntries?.() || []) {
    const sid = entry.sessionId;
    if (representedSids.has(sid)) continue;
    representedSids.add(sid);
    const cwd = entry.cwd || null;
    const agentId = entry.agent || 'claude';
    const deadTmux = sessionManager.deadTmuxNameFor?.(sid);
    const exitOutput = deadTmux ? (await capture(deadTmux, 40, entry.socket || '')).trim() || null : null;
    // Enrich by the LIVE id, not the card id: a Claude session's transcript (cost,
    // last activity, summary) lives under entry.liveSessionId, a distinct UUID from
    // the card id. Enriching by `sid` here found no transcript, so dormant cards lost
    // their cost/age. Legacy entries have no liveSessionId → fall back to the card id
    // (which for them is the live id). Mirrors the Codex branch.
    const runtime = runtimeResolver(entry.runtime);
    const enrichment = (runtime.analyze ? await runtime.analyze({ entry, liveSid: entry.liveSessionId || sid }) : null)
      || ((entry.agent && entry.agent !== 'claude')
        ? await adapterFor(entry.agent).analyze(entry.liveSessionId || sid, { since: usageSince(entry) })
        : (enrich ? await enrich(entry.liveSessionId || sid, { since: usageSince(entry) }) : null));
    const label = sessionLabel({
      names: [entry.name, entry.lastLabel],
      aiTitle: enrichment?.aiTitle,
      intent: entry.intent,
      summary: enrichment?.summary,
      cwd,
      fallback: sid.slice(0, 8),
    });
    const markedLabel = withForkMark(label, entry);
    const parentFields = deriveParentSession(entry);
    const session = {
      id: `session:${sid}`,
      type: 'session',
      sessionId: sid,
      pid: null,
      label: markedLabel,
      agent: agentId,
      status: 'idle',
      hasBackgroundShell: false, // dormant — no live pane to have one
      rawStatus: null,
      waitingFor: null,
      kind: 'managed',
      cwd,
      branch: await branchFor(cwd),
      repoSlug: await repoSlugFor(cwd),
      addDirs: [],
      intent: entry.intent || '',
      createdAt: entry.createdAt || null,
      model: entry.model || null,
      snooze: entry.snooze || null,
      runtime: entry.runtime || null,
      workflow: parentFields.workflow,
      parentSession: parentFields.parentSession,
      spawnedBy: parentFields.spawnedBy,
      autoFixPrChecks: entry.autoFixPrChecks ?? true,
      autoMergeOnPass: entry.autoMergeOnPass ?? false,
      childFullView: entry.childFullView ?? null,
      links: entry.links || [],
      suspendedAt: entry.suspendedAt || null,
      worktree: await worktreeStatus(entry.worktree),
      jobId: null,
      tasks: null,
      updatedAt: null,
      lastActivity: enrichment?.lastActivity ?? null,
      tty: null,
      cpu: null,
      managed: false, // no live tmux → click takes the Resume path, not attach
      // Set while this dormant card's own Resume/Restart is in flight (the tmux is
      // being relaunched right now). This is the site that actually renders during
      // the kill→relaunch gap, so the badge + no-dormant-flicker depend on it.
      restarting: Boolean(sessionManager?.isResuming?.(sid)),
      tmux: null,
      socket: entry.socket || null,
      exitOutput,
      dormant: true,
      usd: enrichment?.usd ?? null,
      advisorUsd: enrichment?.advisorUsd ?? null,
      tokens: enrichment?.tokens ?? null,
      subAgents: enrichment?.subAgents ?? [],
      teammates: [], // dormant — no live panes to host a team
      mail: mailInfo(sid),
    };
    sessionList.push(session);
    nodes.push(session);
    if (cwd) {
      ensureFolder(cwd);
      edges.push({ id: `${session.id}->folder:${cwd}`, source: session.id, target: `folder:${cwd}` });
    }
  }

  // Folder nodes + worktree -> parent repo links.
  for (const folder of folders.values()) {
    nodes.push(folder);
    if (folder.isWorktree) {
      const parent = folder.path.split(WORKTREE_MARKER)[0];
      if (parent && folders.has(parent)) {
        edges.push({
          id: `${folder.id}->folder:${parent}`,
          source: folder.id,
          target: `folder:${parent}`,
          kind: 'worktree',
        });
      }
    }
  }

  // Archived sessions (graph.history, rendered by Search's archived rows): a
  // frozen snapshot from the mapping, recoverable via Resume. Kept lightweight
  // (no transcript reads).
  const history = (sessionManager?.archivedEntries?.() || []).map((e) => {
    const parentFields = deriveParentSession(e);
    return {
      sessionId: e.sessionId,
      agent: e.agent || 'claude',
      name: e.name || null,
      intent: e.intent || '',
      // Same label chain as live sessions, minus summary — history is transcript-free
      // by design — so a resumed archive reads its intent, not the "(resumed)" placeholder.
      label: sessionLabel({ names: [e.name, e.lastLabel], intent: e.intent, cwd: e.cwd, fallback: e.sessionId.slice(0, 8) }),
      cwd: e.cwd || null,
      archivedAt: e.archivedAt,
      createdAt: e.createdAt || null,
      model: e.model || null,
      task: e.task || null,
      viaTaskArchive: e.viaTaskArchive || null,
      worktree: e.worktree ? { path: e.worktree.path, branch: e.worktree.branch } : null,
      // The autopilot run linkage, mirroring how board nodes carry `workflow` +
      // `parentSession` (same legacy `workflow.parent` fallback as the board — see
      // deriveParentSession). An orchestrator record carries issue/phase; a child
      // (workflow worker or otherwise) carries `parentSession` pointing at its
      // parent's card id. Search's archived rows fold runs off this, same as the board.
      workflow: parentFields.workflow ? { issue: parentFields.workflow.issue ?? null, phase: parentFields.workflow.phase ?? null } : null,
      parentSession: parentFields.parentSession,
      spawnedBy: parentFields.spawnedBy,
    };
  });

  return { nodes, edges, sessions: sessionList, history, generatedAt: Date.now() };
}

// Watch the state files and emit "change" (debounced) when anything moves.
// Scope is deliberately narrow: ROSTER (one file) and SESSIONS_DIR (the flat
// `<pid>.json` Claude status files, one per live session) — small, bounded sets
// whose changes drive live status flips and so are worth sub-4s latency.
// **`~/.codex/sessions` is deliberately NOT watched.** chokidar 4 has no fsevents, so
// it opens one fd per watched entry; `~/.codex/sessions` is a deep tree with one
// rollout `.jsonl` per Codex CLI run (hundreds, growing forever — including runs
// that never touched the wrangler), so watching it recursively blows past the
// process fd limit → EMFILE on every terminal attach and a crash-loop under
// launchd (same fd-per-entry trap documented for the memory watcher). Codex
// freshness is instead carried by the 4 s `rebuild` poll in index.js — good
// enough, since Codex status is pane-scraped and its cost is a `~` estimate, so
// neither reads these files for correctness. `depth: 0` keeps SESSIONS_DIR from
// ever descending into (and opening fds for) an accidental subtree.
export function createWatcher() {
  const emitter = new EventEmitter();
  let timer = null;
  const ping = () => {
    clearTimeout(timer);
    timer = setTimeout(() => emitter.emit('change'), 150);
  };
  const watcher = chokidar.watch([ROSTER, SESSIONS_DIR], {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 },
  });
  watcher.on('all', ping);
  emitter.close = () => watcher.close();
  return emitter;
}

export { CLAUDE_DIR, liveState, sessionLabel, withForkMark, readBranch, deriveParentSession };
