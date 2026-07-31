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
