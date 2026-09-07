import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './data-dir.js';
import { generateSocketName } from './tmux-socket.js';
import { writeJsonAtomic } from './atomic-json.js';

// Persistent per-install settings (the tmux socket this data dir is bound to,
// and later the migration-complete flag). Distinct from the ephemeral
// runtime.json (port/pid/startedAt). One JSON file rather than a dot-file per
// flag, so new settings just add a key.
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

export function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  writeJsonAtomic(CONFIG_FILE, next, { trailingNewline: true });
  return next;
}

// This install's tmux socket — generated and persisted on first run, stable
// thereafter. New sessions launch here; legacy sessions stay on the default
// socket until drained. AW_TMUX_SOCKET forces a name (handy for a known dev
// socket); otherwise one is generated.
// Whether to auto-open the board in a browser on startup. Default OFF — opt in
// with AW_OPEN_BROWSER=1. The legacy AW_NO_OPEN flag (truthy) still suppresses and
// takes precedence, so pre-existing plists keep working without changes.
export function shouldOpenBrowser(env = process.env) {
  const truthy = (v) => v != null && !['', '0', 'false', 'no'].includes(String(v).toLowerCase());
  if (truthy(env.AW_NO_OPEN)) return false;
  return truthy(env.AW_OPEN_BROWSER);
}

export function resolveInstanceSocket() {
  const cfg = readConfig();
  if (cfg.tmuxSocket) return cfg.tmuxSocket;
  const socket = process.env.AW_TMUX_SOCKET || generateSocketName();
  writeConfig({ tmuxSocket: socket });
  return socket;
}

// Jira URL prefix a bare key appends to. No org is assumed by default — a
// public build must not point at any one company's Jira. AW_JIRA_BASE_URL in
// the launch environment sets an org-wide default (e.g. a company's own
// deployment); config.json `jiraBaseUrl` overrides that per-install, including
// explicitly opting out with '' even when AW_JIRA_BASE_URL is set. Trailing
// slash is intentional — a bare key is appended directly.
export function jiraBaseUrl(env = process.env) {
  const v = readConfig().jiraBaseUrl;
  if (typeof v === 'string') return v;
  return env.AW_JIRA_BASE_URL || '';
}

// How often (seconds) the server re-polls GitHub PR check status for every PR
// link on the board. Defaults to 60; a positive-number override wins, anything
// else falls back to the default.
export function prStatusPollSeconds() {
  const v = readConfig().prStatusPollSeconds;
  return typeof v === 'number' && v > 0 ? v : 60;
}

// Whether the server auto-attaches a session's GitHub PR to its links when one
// is discovered (gh, in the session's cwd) on the PR-poll tick. Default on; set
// config.json `autoAttachPr: false` to disable.
export function autoAttachPrEnabled() {
  return readConfig().autoAttachPr !== false;
}

// Whether per-task memory/notes is surfaced at all: the tile's memory button and
// the always-on "read AW_TASK_MEMORY" instruction injected into agent launches.
// Default on; toggled from the board's settings modal (config.json
// `taskMemoryEnabled: false`). Off is deliberately shallow — memory files and the
// per-session symlink plumbing stay intact, so re-enabling restores everything.
// Takes cfg (like suspendEnabled) so tests never write the shared config.json —
// `node --test` runs files in parallel against the same real file.
export function taskMemoryEnabled(cfg = readConfig()) {
  return cfg.taskMemoryEnabled !== false;
}

// Whether a session's sub-agents zone (board card + panel) starts expanded or
// collapsed for cards the user hasn't explicitly toggled either way. Default off
// (collapsed) to preserve today's behaviour; toggled from the board's settings
// modal (config.json `subagentsExpandedByDefault: true`). Takes cfg (like
// taskMemoryEnabled) so tests never write the shared config.json.
export function subagentsExpandedByDefault(cfg = readConfig()) {
  return cfg.subagentsExpandedByDefault === true;
}

// Whether archiving a Claude session spawns a headless `claude -p --model
// haiku` review of its transcript, appending a short learnings note to its
// task's memory.md (server/archive-review-runner.js). Default OFF — this
// spends real (if small) money per archive and grows the task's memory file
// unbounded, so it's opt-in rather than a silent new cost; toggled from the
// board's settings modal (config.json `archiveReviewEnabled: true`). Takes cfg
// (like subagentsExpandedByDefault) so tests never write the shared
// config.json.
export function archiveReviewEnabled(cfg = readConfig()) {
  return cfg.archiveReviewEnabled === true;
}

// Whether a Codex launch/resume/fork marks that invocation's cwd trusted
// (`-c projects."<cwd>".trust_level="trusted"`), skipping Codex's own
// trust-folder prompt — Agent Wrangler already sandboxes the session
// (workspace-write + no approval), so the prompt is pure friction. Default on;
// toggled from the board's settings modal (config.json
// `trustCodexLaunchCwd: false` restores Codex's normal prompt). Takes cfg (like
// taskMemoryEnabled) so tests never write the shared config.json.
export function trustCodexLaunchCwd(cfg = readConfig()) {
  return cfg.trustCodexLaunchCwd !== false;
}

// Whether a newly-nested CHILD session (parentSession set — a workflow worker or
// any other nested child, never a merely-`spawnedBy` top-level session) starts
// rendered as a full card (like a top-level session) instead of the default
// compact `.worker-row`. Default off (compact), matching today's behaviour;
// toggled from the board's settings modal (config.json
// `childFullViewByDefault: true`). This is a CREATION-time default, not a live
// rule: "new child sessions show full view by default" means new —
// session-manager's attachSession/dispatch read this value ONCE and stamp it
// onto `entry.childFullView` at the moment a session becomes a child, so
// flipping the setting later never retroactively changes an already-nested
// child (see the client's isChildFullView, which deliberately does NOT fall
// back to this setting per-render — an unstamped child reads as compact,
// matching what it already rendered as, not whatever this setting is now).
// An explicit per-child override (the card menu's "Full view" toggle) is just
// the same stamp applied again later by hand. Takes cfg (like
// subagentsExpandedByDefault) so tests never write the shared config.json.
export function childFullViewByDefault(cfg = readConfig()) {
  return cfg.childFullViewByDefault === true;
}

// The fallback for a session's `autoFixPrChecks` (the PR check-failure and
// merge-conflict pane nudge) when that session has no explicit choice of its
// own — the per-card toggle always wins over this, so flipping the default
// never overrides a card someone has already set by hand. Default on, which is
// exactly the behaviour before the setting existed; toggled from the board's
// settings modal (config.json `autoFixPrChecksDefault: false` leaves
// new/untouched sessions unnudged). Takes cfg (like taskMemoryEnabled) so tests
// never write the shared config.json.
export function autoFixPrChecksDefault(cfg = readConfig()) {
  return cfg.autoFixPrChecksDefault !== false;
}

// Which view a session's sidebar opens in for cards the user hasn't explicitly
// toggled either way. Default off (terminal) to preserve today's behaviour;
// toggled from the board's settings modal (config.json `chatViewDefault: true`).
// Takes cfg (like subagentsExpandedByDefault) so tests never write the shared
// config.json — `node --test` runs files in parallel against the same real file.
export function chatViewDefault(cfg = readConfig()) {
  return cfg.chatViewDefault === true;
}

// Whether the per-session checklist exists at all: the four MCP tools
// (registration AND the launch --allowedTools grant), the always-on nudge
// pointing at the `checklist` skill, and the board's Checklist panel. Default
// ON — a feature nobody discovers might as well not exist, and the panel is
// the whole point (see the design spec's Optionality section). Off is
// deliberately shallow: checklists.json and every stored item stay intact, so
// re-enabling restores every list. Takes cfg (like taskMemoryEnabled) so tests
// never write the shared config.json.
export function checklistEnabled(cfg = readConfig()) {
  return cfg.checklistEnabled !== false;
}
