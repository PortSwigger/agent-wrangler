import path from 'node:path';
import { INSTALL_ROOT } from './install-root.js';

// The hook commands a launch on a runtime with `statusEvents: true` carries, so
// the agent posts its status changes to the session API (server/status-events.js)
// instead of the board reading its status files. One self-contained script; each
// hook runs it with the state that event means.
export const STATUS_HOOK_PATH = path.join(INSTALL_ROOT, 'scripts', 'status-event-hook.mjs');

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// [event, matcher, state]. Claude: PermissionRequest fires as a permission
// dialog opens (its permission_prompt Notification follows seconds later, and
// stays as a fallback); an MCP elicitation is a Notification; AskUserQuestion is
// a tool call that waits on the human; any finished tool means the turn is under
// way again (after a permission was granted, too); Stop ends the turn.
export const CLAUDE_STATUS_HOOKS = [
  ['SessionStart', null, 'idle'],
  ['UserPromptSubmit', null, 'working'],
  ['PreToolUse', 'AskUserQuestion', 'waiting-input'],
  ['PermissionRequest', '*', 'waiting-permission'],
  ['PostToolUse', '*', 'working'],
  ['Notification', 'permission_prompt', 'waiting-permission'],
  ['Notification', 'elicitation_dialog', 'waiting-input'],
  ['Stop', null, 'idle'],
];

// Codex has no notification hook; an approval request is PermissionRequest too.
export const CODEX_STATUS_HOOKS = [
  ['SessionStart', null, 'idle'],
  ['UserPromptSubmit', null, 'working'],
  ['PermissionRequest', null, 'waiting-permission'],
  ['PostToolUse', null, 'working'],
  ['Stop', null, 'idle'],
];

// Claude's `--settings` hook groups, by event. The script is run by its shebang,
// as the PR-attach hook is.
export function claudeStatusHookGroups(script = STATUS_HOOK_PATH) {
  const out = {};
  for (const [event, matcher, state] of CLAUDE_STATUS_HOOKS) {
    const group = { hooks: [{ type: 'command', command: `${quote(script)} ${state}` }] };
    if (matcher) group.matcher = matcher;
    (out[event] ||= []).push(group);
  }
  return out;
}

// Codex hooks as `{ event, matcher?, command }` for codexHookOverrides. `node`
// is the interpreter path, as the PR footer hook is run.
export function codexStatusHooks(node = process.execPath, script = STATUS_HOOK_PATH) {
  return CODEX_STATUS_HOOKS.map(([event, matcher, state]) => ({ event, ...(matcher ? { matcher } : {}), command: `${quote(node)} ${quote(script)} ${state}` }));
}
