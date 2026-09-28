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

const NETWORK_GRANT = ['-c', 'sandbox_workspace_write.network_access=true'];

// The policy half of Codex's launch argv. `undefined` is byte-identical to the
// flags core always used. The network grant is emitted only when the effective
// sandbox is workspace-write: verified on 0.158.0 that it changes nothing under
// read-only (network stays restricted) or danger-full-access (already enabled).
export function codexPolicyArgs(policy) {
  if (policy?.bypass) return ['--dangerously-bypass-approvals-and-sandbox'];
  if (policy?.approveForMe) return ['--approve-for-me', ...NETWORK_GRANT];
  const sandbox = policy?.sandbox ?? 'workspace-write';
  const args = ['--sandbox', sandbox, '--ask-for-approval', policy?.approval ?? 'never'];
  if (sandbox === 'workspace-write') args.push(...NETWORK_GRANT);
  return args;
}
