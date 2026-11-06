// The vocabulary of a `codexPolicy` answer and the argv it turns into, in one
// module so the validator and the flag builder can never disagree about what a
// policy means. A leaf under server/extensions/**, so it imports nothing (the
// same rule as setting-constraints.js; index.test.js asserts the direction).

export const CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
export const CODEX_APPROVALS = ['on-request', 'never'];

const FIELDS = {
  sandbox: (v) => CODEX_SANDBOXES.includes(v),
  approval: (v) => CODEX_APPROVALS.includes(v),
  approveForMe: (v) => typeof v === 'boolean',
  bypass: (v) => typeof v === 'boolean',
};

// Combinations Codex itself refuses, each resolved by dropping one named field.
// Verified against codex-cli 0.158.0 (codex, `codex resume` and `codex fork`
// alike): clap rejects `--approve-for-me` alongside ANY `--sandbox` or
// `--ask-for-approval` ("the argument '--sandbox <SANDBOX_MODE>' cannot be used
// with '--approve-for-me'"), because the flag is itself sugar for
// sandbox_mode="workspace-write" + approval_policy="on-request" +
// approvals_reviewer="auto_review". So an explicit sandbox or approval that
// CONTRADICTS that pairing wins and approve-for-me is dropped; one that merely
// restates it is compatible, and codexPolicyArgs then emits `--approve-for-me`
// alone. Bypass is absent here on purpose: it is not a conflict, it wins
// outright and the other fields are ignored without a log (codex likewise
// refuses `--ask-for-approval` / `--approve-for-me` next to it).
export const INCOMPATIBLE = [
  { when: (p) => p.approveForMe && p.sandbox && p.sandbox !== 'workspace-write', drop: 'approveForMe', why: 'approve-for-me implies sandbox workspace-write' },
  { when: (p) => p.approveForMe && p.approval && p.approval !== 'on-request', drop: 'approveForMe', why: 'approve-for-me implies approval on-request' },
];

// Returns `{ sandbox?, approval?, approveForMe?, bypass? }`, or undefined when
// nothing usable was answered (core defaults then apply). Each field is judged
// on its own: a bad one is dropped and logged and the rest still applies.
export function normalizeCodexPolicy(raw, { extId = '?', onError = () => {} } = {}) {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw) || typeof raw.then === 'function') {
    onError(`[ext:${extId}] codexPolicy: answer must be a plain object (a Promise is not awaited)`);
    return undefined;
  }
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (FIELDS[k] && FIELDS[k](v)) out[k] = v;
    else onError(`[ext:${extId}] codexPolicy: dropped ${k}=${JSON.stringify(v)}`);
  }
  for (const k of ['approveForMe', 'bypass']) if (out[k] === false) delete out[k];
  if (out.bypass) return { bypass: true };
  for (const row of INCOMPATIBLE) {
    if (row.when(out)) {
      onError(`[ext:${extId}] codexPolicy: dropped ${row.drop}=${JSON.stringify(out[row.drop])} (${row.why})`);
      delete out[row.drop];
    }
  }
  return Object.keys(out).length ? out : undefined;
}

// Core's own sandbox/approval choice (Settings defaults, the dispatch dialog's
// Advanced options, the per-session copy on the mapping entry): the same
// vocabulary as an extension's answer, but quiet. An empty select ('') and an
// unticked box mean "unset", a stray field is dropped without a log, and the
// result is undefined when nothing is left. Unlike an extension's answer, a
// ticked approve-for-me REPLACES the sandbox and approval choices rather than
// losing to them: Settings and the dialog both say it overrides them, and the
// dialog greys them out while it is ticked. Bypass replaces everything.
export function cleanCodexPolicy(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const picked = {};
  for (const k of Object.keys(FIELDS)) if (raw[k] !== '' && raw[k] != null && FIELDS[k](raw[k])) picked[k] = raw[k];
  if (picked.bypass) return { bypass: true };
  if (picked.approveForMe) return { approveForMe: true };
  return normalizeCodexPolicy(picked);
}

// Whether a launch under this policy may carry `--add-dir` grants. Verified on
// codex-cli 0.166.0: under `--sandbox read-only` Codex refuses to start at all
// ("Ignoring --add-dir (...) because the effective permissions do not allow
// additional writable roots", exit 1), and read-only already reads everywhere,
// so the grants are left out rather than the launch failing.
export function codexPolicyAllowsAddDirs(policy) {
  return policy?.sandbox !== 'read-only' || Boolean(policy?.bypass || policy?.approveForMe);
}

const NETWORK_GRANT = ['-c', 'sandbox_workspace_write.network_access=true'];

// The policy half of Codex's launch argv. `undefined` is core's default:
// workspace-write with on-request approvals, so a command the sandbox would
// block stops at Codex's approval prompt and the card shows needs-you
// (tmux-scraper.js) rather than Codex carrying on unseen. The network grant is emitted only when the effective
// sandbox is workspace-write: verified on 0.158.0 that it changes nothing under
// read-only (network stays restricted) or danger-full-access (already enabled).
export function codexPolicyArgs(policy) {
  if (policy?.bypass) return ['--dangerously-bypass-approvals-and-sandbox'];
  if (policy?.approveForMe) return ['--approve-for-me', ...NETWORK_GRANT];
  const sandbox = policy?.sandbox ?? 'workspace-write';
  const args = ['--sandbox', sandbox, '--ask-for-approval', policy?.approval ?? 'on-request'];
  if (sandbox === 'workspace-write') args.push(...NETWORK_GRANT);
  return args;
}
