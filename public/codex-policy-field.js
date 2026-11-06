// The dispatch dialog's Codex sandbox/approval controls (Advanced options,
// #m-codex-policy-row), shown for a Codex draft only and prefilled from
// Settings › Sessions' Codex defaults (graph.codexPolicyDefaults). What the
// dialog sends is the whole policy, so an unticked box really is off for that
// dispatch even when Settings has it on. The server stores it on the session
// (session-manager.js _doDispatch); an extension's codexPolicy answer still
// wins over it at launch.

// The fallback when the graph has not carried Settings' defaults yet: core's
// historical flags, the same as server/config-store.js CODEX_POLICY_DEFAULTS.
export const CODEX_POLICY_FALLBACK = Object.freeze({ sandbox: 'workspace-write', approval: 'never', approveForMe: false, bypass: false });

// Approve-for-me stands alone (it implies workspace-write + on-request), and
// bypass overrides everything, so the controls they replace are greyed out.
export function codexPolicyControlState({ approveForMe = false, bypass = false } = {}) {
  return {
    approveForMeDisabled: bypass,
    sandboxDisabled: bypass || approveForMe,
    approvalDisabled: bypass || approveForMe,
    dangerHidden: !bypass,
  };
}

// The payload's `codexPolicy` from the controls' values: the greyed-out fields
// are left out, exactly as they would launch.
export function codexPolicyFromControls({ sandbox, approval, approveForMe, bypass }) {
  if (bypass) return { bypass: true };
  if (approveForMe) return { approveForMe: true };
  return { sandbox, approval, approveForMe: false, bypass: false };
}

function els(root) {
  const q = (id) => root.querySelector(`#${id}`);
  return { sandbox: q('m-codex-sandbox'), approval: q('m-codex-approval'), approveForMe: q('m-codex-approve-for-me'), bypass: q('m-codex-bypass'), danger: q('m-codex-danger') };
}

export function syncCodexPolicyControls(root) {
  const ui = els(root);
  const s = codexPolicyControlState({ approveForMe: ui.approveForMe.checked, bypass: ui.bypass.checked });
  ui.approveForMe.disabled = s.approveForMeDisabled;
  ui.sandbox.disabled = s.sandboxDisabled;
  ui.approval.disabled = s.approvalDisabled;
  ui.danger.hidden = s.dangerHidden;
}

export function fillCodexPolicyControls(root, policy) {
  const p = { ...CODEX_POLICY_FALLBACK, ...(policy && typeof policy === 'object' ? policy : {}) };
  const ui = els(root);
  ui.sandbox.value = p.sandbox;
  if (ui.sandbox.value !== p.sandbox) ui.sandbox.value = CODEX_POLICY_FALLBACK.sandbox;
  ui.approval.value = p.approval;
  if (ui.approval.value !== p.approval) ui.approval.value = CODEX_POLICY_FALLBACK.approval;
  ui.approveForMe.checked = p.approveForMe === true;
  ui.bypass.checked = p.bypass === true;
  syncCodexPolicyControls(root);
}

export function readCodexPolicyControls(root) {
  const ui = els(root);
  return codexPolicyFromControls({ sandbox: ui.sandbox.value, approval: ui.approval.value, approveForMe: ui.approveForMe.checked, bypass: ui.bypass.checked });
}
