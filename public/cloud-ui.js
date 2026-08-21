// Pure decisions for the cloud-session UI. `public/app.js` is a DOM-bound ES
// module with no unit test, so every non-trivial cloud rule lives HERE — the
// dialog/menu code in app.js and the registry row in settings.js call these and
// only translate the answer into DOM. Nothing in this module touches `document`,
// so it is testable with plain `node --test` (see cloud-ui.test.js).
//
// Colour never appears here: the pill builders return CSS class NAMES only
// (`hint`/`warn`/`error`, already defined against semantic vars in styles.css),
// per CLAUDE.md's "no hardcoded hex in markup/JS".
//
// Deliberately out of scope for v1 (§13 of the plan) — a reader looking for these
// should find the decision, not the absence:
//  - adopting a cloud session started on web/mobile by pasting its id/URL (there
//    is no "paste a session_… id" field anywhere in the destination row);
//  - schedules targeting cloud (the destination row is hidden in schedule mode,
//    so a saved schedule can never carry runtime 'cloud');
//  - any PR-matching heuristic to guess a cloud session's progress (hence the
//    single `cloud` state/word — see cloudCardActions' comment);
//  - any diff before Teleport, and any attach behaviour beyond the gate — both
//    are expressed as the disabled-with-reason items below, not as fallbacks.

// Reasons rendered as an action item's hover title. Kept as exported constants so
// the menu copy and its test assert the same string, and so the resume/attach
// refusal toast can reuse the wording the server's CLOUD_ATTACH_UNSUPPORTED_MSG
// shortens.
export const NO_LOCAL_CHECKOUT_REASON = 'No local checkout until you Teleport.';
export const ATTACH_UNSUPPORTED_REASON = "Attaching to a cloud session isn't enabled for this account.";

// The single expression of the "all four touch points agree" rule (§11a). The
// destination row, the worktree box, the cloud fields and the Workflow mode card
// are four independent bits of DOM whose visibility is re-derived on every
// syncWorkflow/syncDestination/openModal pass — deriving them from one function
// is what stops them drifting apart the way a per-site `classList.toggle` would.
//
// `mode` is the dialog's job, not the dispatch mode: 'launch' | 'schedule-create'
// | 'schedule-edit' | 'subagent' | 'fork'. `dest` is the destination value
// (`local` | `devcontainer` | `cloud`), `agent` the selected model's agent.
// `dispatchMode` is 'standard' | 'workflow'; `reviewMode` is the peer-review
// dialog (which already hides the worktree box for its own reason).
export function destinationFieldVisibility({
  dest = 'local', agent = 'claude', mode = 'launch',
  dispatchMode = 'standard', reviewMode = false,
} = {}) {
  // Exactly the old <select>'s visibility: it lived inside #m-dispatch-fields, so
  // it showed for a launch AND for a schedule whose action is a dispatch (a
  // scheduled devcontainer run is a real, existing feature), and was hidden
  // wholesale for the schedule-session action, the read-only sub-agent view and
  // the separate fork dialog (which never contained it at all).
  const destRowVisible = mode !== 'subagent' && mode !== 'fork';
  // Both non-local destinations are Claude-only (devcontainer's status/cost hooks
  // read Claude paths; a cloud VM runs Claude Code), and a stale non-local
  // selection must not survive an agent swap — resolve it here rather than trusting
  // whatever the control still holds.
  const claude = agent === 'claude';
  // Cloud additionally requires launch mode: a SCHEDULE targeting cloud is
  // deliberately out of scope for v1, and the cheapest way to guarantee no saved
  // schedule can ever carry runtime 'cloud' is to make the card unpickable there.
  const cloudAllowed = claude && mode === 'launch';
  const stale = (dest === 'cloud' && !cloudAllowed) || (dest === 'devcontainer' && !claude);
  const effectiveDest = stale ? 'local' : dest;
  const cloud = effectiveDest === 'cloud';
  const wf = dispatchMode === 'workflow';
  return {
    destRowVisible,
    effectiveDest,
    // Cloud has no local checkout, so a worktree control would be a lie; workflow
    // mode and review mode already hide it for their own reasons.
    worktreeBox: !cloud && !wf && !reviewMode,
    cloudEnv: cloud,
    cloudRef: cloud,
    cloudMsg: cloud,
    // The issue-to-pr skill rides `--plugin-dir`, which never reaches a VM — so
    // Workflow is not merely hidden but disabled, with a reason, when cloud is
    // picked. (The mode CARD row itself stays visible; only workflow is dead.)
    workflowEnabled: !cloud,
    workflowDisabledReason: cloud
      ? 'Workflow mode needs a local plugin dir, which a cloud VM never sees.'
      : null,
    // Mirrors the old syncRuntimeToggle rule, widened from devcontainer to both
    // non-local destinations — plus cloud's extra launch-mode-only constraint.
    cloudCardEnabled: cloudAllowed,
    devcontainerCardEnabled: claude,
  };
}

// The preflight pill list for #m-cloud-msg. Refusals first (they gate Launch), then
// warnings — a red line above an amber one reads as "this is why you can't go" then
// "…and this is what you should know". `blocks` is what the caller ORs into #m-go's
// disabled state, kept on the pill rather than recomputed so the rendered pills and
// the gate can never disagree.
export function cloudPreflightPills({ refusals = [], warnings = [] } = {}) {
  const pills = [];
  for (const r of refusals || []) {
    const text = typeof r === 'string' ? r : r?.message;
    if (text) pills.push({ cls: 'error', text, blocks: true });
  }
  for (const w of warnings || []) {
    const text = typeof w === 'string' ? w : w?.message;
    // Amber (`warn`) is the "will work, but you should know" class the worktree
    // box already uses for reusing an existing branch — same meaning here.
    if (text) pills.push({ cls: 'warn', text, blocks: false });
  }
  return pills;
}

// Any refusal standing ⇒ Launch is disabled, exactly as the worktree refusal gate
// does. Separate from the pill list so a caller can gate without rendering.
export function cloudPreflightBlocks(result) {
  return cloudPreflightPills(result).some((p) => p.blocks);
}

// Dropdown/label text for an environment id. `null`/`''` is the account default —
// the wrangler deliberately keeps no API listing (§8), so an id with no registry
// row shows the raw id rather than pretending it doesn't exist.
export function cloudEnvLabel(environmentId, environments = []) {
  if (!environmentId) return 'Account default';
  const hit = (environments || []).find((e) => e && e.id === environmentId);
  return hit && hit.label ? hit.label : environmentId;
}

// The card/actions menu item list for a cloud card. Returned as data (label,
// disabled, title) so the disabled-with-reason rules are asserted without a DOM.
//
// Send message / Teleport / Archive are the only live actions. View diff and Open
// terminal are rendered DISABLED WITH A REASON rather than omitted, because their
// absence would read as a bug — the user knows those buttons exist on every other
// card. Fork, Restart and Peer review ARE omitted: each is a host-transcript or
// host-pane operation with no cloud meaning at all, so a greyed row would only
// invite the question.
export function cloudCardActions({ s = {}, attachSupported = false } = {}) {
  const archived = Boolean(s.cloud?.archivedAt);
  return [
    {
      id: 'send-message',
      label: 'Send message',
      disabled: archived,
      title: archived ? 'This cloud session is archived — it can no longer be steered.' : null,
    },
    { id: 'teleport', label: 'Teleport to a local worktree…', disabled: false, title: null },
    {
      id: 'view-diff',
      label: 'View diff',
      disabled: true,
      title: NO_LOCAL_CHECKOUT_REASON,
    },
    {
      id: 'open-terminal',
      label: 'Open terminal',
      // The one item the gate flips: when attach ships, the pane dispatch already
      // creates simply stays live and this becomes an ordinary terminal.
      disabled: !attachSupported,
      title: attachSupported ? null : ATTACH_UNSUPPORTED_REASON,
    },
    { id: 'archive', label: 'Archive', disabled: false, danger: true, title: null },
  ];
}

// True when a cloud card's click/Resume must NOT send `resume`. The panel's
// "Resume a copy" button is gated on the same answer — its copy
// (`claude --resume --fork-session`) is actively wrong for a cloud card, which has
// no host transcript to fork.
export function cloudResumeBlocked({ s = {}, attachSupported = false } = {}) {
  return s.runtime === 'cloud' && !attachSupported;
}

// Settings-row validation for the environment registry (§8). Same rule as the
// server's `cloudEnvironments(cfg)` accessor, applied client-side so a bad row is
// rejected in front of the user instead of silently vanishing on the next graph
// push. Returns the accepted rows AND the dropped ones (with a reason) so the
// panel can show visible feedback rather than losing a typo without a word.
export function sanitizeCloudEnvironments(rows = []) {
  const environments = [];
  const dropped = [];
  const seen = new Set();
  for (const row of rows || []) {
    const label = String(row?.label ?? '').trim();
    const id = String(row?.id ?? '').trim();
    if (!label && !id) continue; // a blank row is the empty add-form, not an error
    if (!label) { dropped.push({ label, id, reason: 'needs a label' }); continue; }
    // The prefix is what picks the launch form (env_ ⇒ Anthropic-hosted,
    // ccpool_ ⇒ self-hosted runner), so a mistyped id must never reach a launch.
    if (!/^(env_|ccpool_)/.test(id)) {
      dropped.push({ label, id, reason: 'id must start with env_ or ccpool_' });
      continue;
    }
    if (seen.has(id)) { dropped.push({ label, id, reason: 'duplicate id' }); continue; }
    seen.add(id);
    environments.push({ label, id });
  }
  return { environments, dropped };
}
