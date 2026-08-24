import { shellQuote, withCleanClaudeEnv } from '../agents/claude.js';
import { CLOUD_TMUX_PREFIX } from '../agents/index.js';
import { cloudPreflight } from '../cloud-preflight.js';

// The `cloud` runtime: the agent process runs in a Claude-hosted (or self-hosted
// runner) VM, and the local tmux pane holds only the `claude` client that created
// it. Everything here is pure command building + log parsing so the whole runtime
// is unit-testable with no network, no git and no tmux.
//
// TWO PERMANENT GAPS, not TODOs — a reader looking for the missing plumbing should
// stop here:
//
//  1. NO TRANSCRIPT ⇒ NO COST, ANYWHERE. The conversation lives in the VM and is
//     never written under `~/.claude/projects`, so a cloud card has nothing to
//     cost. That means its spend is absent from the live board, from
//     `usage-scan-cache.json` (which per CLAUDE.md *is* the long-term spend
//     record), from every rollup built on it, and from `scripts/cost-report.mjs`.
//     Because the cache is the record, that spend is permanently invisible — it
//     cannot be back-filled later. Do NOT invent an estimate to fill the hole: a
//     fabricated number would poison rollups that are otherwise transcript-exact.
//     `analyze` below returns null explicitly for exactly this reason.
//  2. NO STATUS SIGNAL BEYOND "running in cloud". There is no hook status file, no
//     pane to scrape once the create client exits, and no API poll — so a cloud
//     card can never report working/idle/needs-you. The client renders a dedicated
//     `cloud` state instead of guessing one.
//
// Out of scope for v1 (deliberately, so nobody goes looking): adopting a cloud
// session started on web/mobile by pasting its id, schedules targeting cloud, any
// PR-matching progress heuristic, any diff before Teleport, and any attach
// behaviour beyond the single `cloud-attach.js` gate.

// Re-exported so the runtime's own consumers have one import for it. It is DECLARED
// in `agents/index.js` (the owned-prefix registry) because `agents/*` must never
// import `runtimes/*`.
export { CLOUD_TMUX_PREFIX };

// The id shape the CLI hands back and we store on `entry.cloud.sessionId` — a THIRD
// id namespace alongside the card id and `liveSessionId`. Never `--resume` it. Kept
// identical to the scrape regex in `parseCloudLaunchLog` so an id that can be
// parsed is always an id that can be re-used, and vice versa.
const CLOUD_SESSION_ID_RE = /^session_[A-Za-z0-9]+$/;

// `env_…` = an Anthropic-hosted environment, `ccpool_…` = a self-hosted runner
// pool, empty = the account default (which is Anthropic-hosted). Anything else
// THROWS rather than picking a launch form: the two forms are different `claude`
// invocations, so a typo'd id silently landing on the wrong one would either fail
// opaquely in the pane or create a session in the wrong place.
export function classifyEnvironmentId(id) {
  const v = String(id ?? '').trim();
  if (!v) return 'default';
  if (v.startsWith('env_')) return 'anthropic';
  if (v.startsWith('ccpool_')) return 'self-hosted';
  throw new Error(`Unrecognised cloud environment id "${v}" — expected an env_… (Anthropic-hosted) or ccpool_… (self-hosted) id.`);
}

// Collapse every single-quoted span so flag detection can't be fooled by flag-like
// text INSIDE a quoted argument (an intent of "retry with -p set" must not read as
// a `-p` flag). `shellQuote` escapes an embedded apostrophe as `'\''`, which ENDS
// one quoted span and starts another — so the escapes must be removed BEFORE the
// collapse, or an intent like `don't use -p here` leaves ` -p ` sitting outside any
// span and the guard refuses a launch over a footgun that isn't there.
const stripQuoted = (cmd) => String(cmd || '').split(`'\\''`).join('').replace(/'[^']*'/g, "''");

// Every `--cloud <token>` value in a command, unquoted. Read off the RAW string
// (not `stripQuoted`) because the value we care about is itself quoted.
function cloudFlagValues(cmd) {
  const out = [];
  const re = /--cloud(?:=|\s+)(?:'([^']*)'|(\S+))/g;
  let m;
  while ((m = re.exec(String(cmd || '')))) out.push(m[1] ?? m[2] ?? '');
  return out;
}

// The footgun guard. `-p` (or `--print`) combined with `--cloud '<description>'`
// — i.e. `--cloud` given a free-text intent rather than an existing `session_…` id
// — either errors out or SILENTLY RUNS THE PROMPT LOCALLY. The silent local run is
// the dangerous outcome: the pane looks busy, work happens on this Mac against the
// real checkout, and the board shows a card that claims to be running in the cloud
// and is not. Anthropic-hosted creates are therefore interactive-only (no `-p`),
// and `-p` belongs solely to the self-hosted `--environment` form and to steering
// an EXISTING session by id. `buildCloudCreateCommand` runs this on its own output
// before returning, so a future edit to either branch cannot bypass it.
export function assertNoPromptWithCloudDescription(cmd) {
  const bare = stripQuoted(cmd);
  const hasPrint = /(?:^|\s)(?:-p|--print)(?:[=\s]|$)/.test(bare);
  if (!hasPrint) return;
  const description = cloudFlagValues(cmd).find((v) => !CLOUD_SESSION_ID_RE.test(v));
  if (description === undefined) return;
  throw new Error(`Refusing to build a cloud command that combines -p/--print with --cloud "${description}": that either errors or silently runs the prompt LOCALLY, producing a card that claims to be cloud and is not.`);
}

// The command the tmux pane runs to CREATE a cloud session. Two forms, picked by
// the environment id's prefix (see classifyEnvironmentId):
//   anthropic/default — `claude --cloud '<intent>'`, plus the inline
//     `--settings {"remote":{"defaultEnvironmentId":"env_…"}}` when a specific
//     Anthropic environment was chosen. Interactive: it needs a TTY, which is
//     exactly why this runs in a real pane and never with `-p`.
//   self-hosted — `claude -p '<intent>' --environment ccpool_… [--ref <branch>]
//     --output-format json`.
// `--ref` is emitted ONLY on the self-hosted form: the live CLI probe established
// it there and nowhere else, and a flag the Anthropic form may not accept would
// dead-pane the launch.
export function buildCloudCreateCommand({ intent, environmentId = '', ref = '' } = {}) {
  const text = String(intent ?? '').trim();
  if (!text) throw new Error('A cloud session needs an intent — it is the prompt the cloud agent starts from.');
  const id = String(environmentId ?? '').trim();
  const kind = classifyEnvironmentId(id);
  const branch = String(ref ?? '').trim();
  let cmd;
  if (kind === 'self-hosted') {
    cmd = withCleanClaudeEnv(`claude -p ${shellQuote(text)} --environment ${shellQuote(id)}`
      + (branch ? ` --ref ${shellQuote(branch)}` : '')
      + ' --output-format json');
  } else {
    cmd = withCleanClaudeEnv(`claude --cloud ${shellQuote(text)}`
      + (kind === 'anthropic' ? ` --settings ${shellQuote(JSON.stringify({ remote: { defaultEnvironmentId: id } }))}` : ''));
  }
  assertNoPromptWithCloudDescription(cmd);
  return cmd;
}

// Attach a local pane to an EXISTING cloud session. Only reachable when
// `cloudAttachSupported()` is true (server/cloud-attach.js) — there is no
// fallback, no retry and no other speculative attach path.
export function buildCloudAttachCommand({ cloudSessionId } = {}) {
  return withCleanClaudeEnv(`claude --cloud ${shellQuote(assertCloudSessionId(cloudSessionId, 'attach to'))}`);
}

// Pull a cloud session down into a local checkout — the one-way conversion that
// gives a card back transcript, cost, diff, mail and PR watching.
//
// `--session-id <uuid>` is REQUIRED, and it is what makes the conversion possible
// at all: a teleported session writes NOTHING under `~/.claude/projects` until its
// first human message (verified live against claude 2.1.241 — "Session resumed" in
// the pane, empty project bucket on disk), so there is no transcript to *discover*
// the local conversation id from at launch time. Presetting it means the id is
// known by construction, exactly as an ordinary local dispatch does with
// `adapter.presetsSessionId`. The uuid is a THIRD-namespace-safe value: it is the
// card's future `liveSessionId`, never the `session_…` id next to it.
export function buildTeleportCommand({ cloudSessionId, liveSessionId } = {}) {
  return withCleanClaudeEnv(`claude --teleport ${shellQuote(assertCloudSessionId(cloudSessionId, 'teleport'))}`
    + ` --session-id ${shellQuote(assertLiveSessionId(liveSessionId))}`);
}

// The preset local conversation id. `claude` rejects a non-uuid outright, so a
// caller that hands over a card id (`s-…`) or, worse, the `session_…` id would
// dead-pane the teleport — check the shape here where the error can still name the
// three namespaces.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertLiveSessionId(id) {
  const v = String(id ?? '').trim();
  if (!UUID_RE.test(v)) {
    throw new Error(`Cannot teleport without a uuid to preset as the local conversation id (got ${v ? `"${v}"` : 'nothing'}) — a card id or a session_… id is not one.`);
  }
  return v;
}

// Guards against the three-namespace confusion: handing a card id or a
// `liveSessionId` uuid to `--cloud`/`--teleport` would target nothing (or, worse,
// be read as a description — see assertNoPromptWithCloudDescription).
function assertCloudSessionId(id, verb) {
  const v = String(id ?? '').trim();
  if (!CLOUD_SESSION_ID_RE.test(v)) {
    throw new Error(`Cannot ${verb} a cloud session without a session_… id (got ${v ? `"${v}"` : 'nothing'}) — a card id or liveSessionId is not one.`);
  }
  return v;
}

// tmux pipe-pane hands us raw bytes, so the log carries the client's cursor/colour
// escapes. Strip CSI sequences and carriage returns before matching; OSC sequences
// are left alone because an OSC-8 hyperlink carries the URL we want inside itself.
const stripAnsi = (s) => String(s || '').replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '\n');

// A URL only counts if it is an `https://claude.ai/…` one: it ends up as an `href`
// in a card chip, so it goes through the same "agent-provided text is untrusted"
// treatment as a PR link. Host match is exact — a lookalike subdomain is not the
// board's business to link to.
function claudeAiUrl(candidate) {
  const s = String(candidate || '').trim().replace(/[)\].,;:'"]+$/, '');
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.hostname !== 'claude.ai') return null;
    return s;
  } catch {
    return null;
  }
}

const URL_IN_TEXT = /https:\/\/[^\s'"<>)\]\x07\x1B]+/;

// One parser for both launch forms, run over the piped pane log (and, as a
// fallback, a `capture-pane` dump) by the launch watcher.
//   cloudSessionId — the self-hosted `--output-format json` line's `session_id`
//     first (a structured field beats scraping), then the first `session_…` token
//     anywhere, which is what the interactive form's `Created cloud session` /
//     `View:` / `Resume with:` block gives us.
//   url — the `View:` line's URL, validated as above. Falls back to the JSON
//     line's `url`, then to any claude.ai URL in the text (a narrow pane can wrap
//     the `View:` label away from its URL).
//   attachRefused — the CLI's literal refusal string. This is the ONLY producer of
//     the attach-gate auto-detect signal (see cloud-attach.js).
//   sawCreated — distinguishes "created, but the id never made it into the log"
//     from "nothing happened at all", which the watcher needs to decide whether to
//     keep polling or give up quietly.
//   createError — the CLI's own reason the CREATE failed outright (e.g. "no
//     GitHub remote was detected" for a BYOC pool with no parseable git source —
//     see the CLAUDE.md cloud bullets). Preferred source is the self-hosted
//     `--output-format json` line's `error` field (`{"ok":false,"error":"…"}`); a
//     bare `Error: …` line (the interactive form's own stderr-to-pane text) is the
//     fallback. Deliberately null whenever `cloudSessionId` is set OR
//     `attachRefused` is true — a successful create or an attach refusal are
//     their own distinct outcomes, and must never also read as a create error.
export function parseCloudLaunchLog(text) {
  const raw = stripAnsi(text);
  const lines = raw.split('\n');
  let cloudSessionId = null;
  let jsonUrl = null;
  let jsonError = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const id = obj?.session_id ?? obj?.sessionId;
    if (typeof id === 'string' && CLOUD_SESSION_ID_RE.test(id.trim())) {
      cloudSessionId = id.trim();
      jsonUrl = claudeAiUrl(obj?.url);
      break;
    }
    if (!jsonError && obj?.ok === false && typeof obj?.error === 'string' && obj.error.trim()) {
      jsonError = obj.error.trim();
    }
  }
  if (!cloudSessionId) {
    const m = raw.match(/session_[A-Za-z0-9]+/);
    if (m) cloudSessionId = m[0];
  }
  let url = null;
  const viewLine = lines.find((l) => /(?:^|\s)View:/.test(l));
  if (viewLine) url = claudeAiUrl(viewLine.match(URL_IN_TEXT)?.[0]);
  if (!url) url = jsonUrl;
  if (!url) url = claudeAiUrl(raw.match(/https:\/\/claude\.ai\/[^\s'"<>)\]\x07\x1B]+/)?.[0]);
  const attachRefused = raw.includes('Attaching to an existing cloud session is not enabled');
  const errorLine = raw.match(/^Error: (.+)$/m)?.[1]?.trim() || null;
  const createError = cloudSessionId || attachRefused ? null : (jsonError || errorLine);
  return {
    cloudSessionId,
    url,
    attachRefused,
    sawCreated: raw.includes('Created cloud session'),
    createError,
  };
}

export const cloud = {
  id: 'cloud',
  // There is no host transcript to guard: `--resume` never enters a cloud card's
  // life, so the resume-dir/transcript guard has nothing to check and would refuse
  // a perfectly valid attach.
  skipsHostResumeGuard: true,
  // Identity: `buildLaunch` below already produced the entire command, so there is
  // nothing left to decorate. Kept so the two-stage build shape stays uniform for
  // local/devcontainer.
  async wrapLaunch({ inner }) {
    return inner;
  },
  // REPLACES the agent adapter's buildLaunch/buildResume rather than decorating it
  // — a cloud launch is a different `claude` invocation, not a wrapper around the
  // local one (no --session-id, no --mcp-config, no memory injection: none of it
  // can reach the VM).
  buildLaunch({ mode, intent = '', entry, cloud: cloudOpts } = {}) {
    if (mode === 'resume') return buildCloudAttachCommand({ cloudSessionId: entry?.cloud?.sessionId });
    if (mode === 'dispatch') {
      return buildCloudCreateCommand({
        intent,
        environmentId: cloudOpts?.environmentId || '',
        ref: cloudOpts?.ref || '',
      });
    }
    // Fail loud on anything else (notably 'fork'): a mode this module doesn't know
    // must never fall through to the create form, which would silently spend money
    // starting a brand-new cloud session.
    throw new Error(`cloud runtime cannot build a "${mode}" launch — only dispatch (create) and resume (attach).`);
  },
  // Returns the FIRST refusal message, or null — the contract's string-or-null
  // shape, so dispatch's throw-to-toast path is unchanged and schedules/MCP
  // dispatches are gated by the same rules as the dialog without ever touching it.
  // Warnings (dirty tree, unpushed commits) are dropped here: there is nothing to
  // render at dispatch time, and they must not block. The dialog gets both from the
  // `cloud-preflight` control message, which calls the same leaf.
  async preflight({ cwd, agent, workflow, cloud: cloudOpts } = {}) {
    const { refusals } = await cloudPreflight({
      cwd,
      agent,
      workflow,
      environmentId: cloudOpts?.environmentId || '',
      ref: cloudOpts?.ref || '',
    });
    return refusals?.[0]?.message || null;
  },
  // Returns the EMPTY-ANALYSIS shape, not `null` — and that distinction is the
  // whole point. state-reader's two enrichment sites read
  // `(runtime.analyze ? await runtime.analyze(…) : null) || <host transcript scan>`,
  // where the `||` is deliberate for devcontainer (whose analyze returns null when
  // the container is down and MUST fall back to the host). A cloud runtime handing
  // back `null` therefore doesn't suppress the host scan at all: it falls through
  // to `enrich(entry.liveSessionId || sid)`, and a cloud entry has no live id — so
  // the board would cost a transcript under the CARD id, or pick up the local
  // `--cloud` CLIENT's own conversation and render its spend as this card's. A real
  // object short-circuits the `||`, which is what actually keeps the `$` pill off a
  // cloud card (there is nothing to cost, so nothing renders in its place — see
  // cloudChips in cards.js). Same shape `transcript-reader.js`'s `analyze` returns
  // for a transcript that doesn't exist.
  async analyze() {
    return { usd: null, subAgentUsd: 0, advisorUsd: 0, tokens: null, subAgents: [] };
  },
  // NO readLive on purpose. During the create window the pane scrape is the right
  // signal (the local client IS the only observable thing), and after it exits
  // there is nothing to read at all — see the "no status signal" gap at the top.
};
