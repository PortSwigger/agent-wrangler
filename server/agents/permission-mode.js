import { adapterFor, agentError } from './index.js';
export const CLAUDE_PERMISSION_MODES = ['auto', 'manual', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];

export function permissionModeError(value, agent = 'claude') {
  if (value == null) return null;
  const invalid = agentError(agent);
  if (invalid) return invalid;
  const adapter = adapterFor(agent);
  if (!CLAUDE_PERMISSION_MODES.includes(value)) {
    return `Invalid permission mode "${value}". Valid values: ${CLAUDE_PERMISSION_MODES.join(', ')}.`;
  }
  if (!adapter.controls.permissionModes.includes(value)) {
    return `Permission mode "${value}" is only supported for Claude. Omit permission_mode or use auto for ${agent}; its approval and sandbox policy is configured separately.`;
  }
  return null;
}

export function claudePermissionArgs(value) {
  const error = permissionModeError(value);
  if (error) throw new Error(error);
  return ['--permission-mode', value ?? 'auto'];
}

export function runtimePermissionModeError(value, runtime) {
  return value != null && value !== 'auto' && runtime?.buildLaunch
    ? `Permission mode "${value}" is not supported by runtime "${runtime.id}", which supplies its own launch command.`
    : null;
}
