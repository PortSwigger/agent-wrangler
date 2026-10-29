import { codexPolicyArgs } from '../extensions/codex-policy.js';

const policies = { locked: undefined, auto: { approveForMe: true }, full: { bypass: true } };

export const CODEX_LAUNCH_MODES = {
  label: 'Sandbox', field: 'sandboxMode', overridable: true,
  modes: [
    { id: 'locked', name: 'Locked to worktree', hint: 'Writes stay inside the worktree and Also writable folders. Network access is enabled.', icon: 'lock', default: true, folders: true },
    { id: 'auto', name: 'Auto-approve', hint: 'A reviewer model can approve stepping outside the sandbox when the task needs it.', icon: 'shield', folders: true },
    { id: 'full', name: 'Full access', hint: 'No sandbox or approval checks. The agent can access the host.', icon: 'unlock', folders: false },
  ].map((mode) => ({ ...mode, flags: codexPolicyArgs(policies[mode.id]) })),
};

export const CLAUDE_LAUNCH_MODES = {
  label: 'Permissions', field: 'permissionMode',
  modes: [
    { id: 'auto', name: 'Auto', hint: 'Claude checks actions automatically. These permission checks are not an OS sandbox.', icon: 'shield', default: true, folders: true },
    { id: 'acceptEdits', name: 'Accept edits', hint: 'Claude accepts file edits and checks other actions. This is not an OS sandbox.', icon: 'edit', folders: true },
    { id: 'bypassPermissions', name: 'Bypass', hint: 'Skips Claude permission checks. This does not provide an OS sandbox.', icon: 'unlock', folders: false },
  ].map((mode) => ({ ...mode, flags: ['--permission-mode', mode.id] })),
};

export function codexModePolicy(mode = 'locked') {
  if (!Object.hasOwn(policies, mode)) throw new Error(`Invalid sandbox mode "${mode}". Valid values: locked, auto, full.`);
  return policies[mode] ? { ...policies[mode] } : undefined;
}

export function dispatchModeError({ agent = 'claude', permissionMode, sandboxMode } = {}) {
  if (sandboxMode != null) {
    if (agent !== 'codex') return 'Sandbox mode is only supported for Codex.';
    try { codexModePolicy(sandboxMode); } catch (err) { return err.message; }
  }
  if (permissionMode != null && (agent !== 'claude' || !CLAUDE_LAUNCH_MODES.modes.some((m) => m.id === permissionMode))) {
    return 'Dispatch permissions must be Auto, Accept edits or Bypass for Claude; other permission_mode values are spawn_session-only.';
  }
  return null;
}
