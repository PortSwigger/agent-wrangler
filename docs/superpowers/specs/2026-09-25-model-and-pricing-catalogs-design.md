# Source-agnostic model and pricing catalogs

**Status:** proposed
**Date:** 2026-09-25
**Scope:** replace the hand-copied model lists and USD/1M-token tables in
`server/agents/claude.js`, `server/agents/codex.js` and `server/pricing.js` with
two catalogs that are explicitly separate — model AVAILABILITY/CAPABILITIES, and
PRICING — each sourced from the most authoritative place that actually exists
for it, never invented at a fallback. This also removes `rateFor`/`openaiRateFor`
defaulting an unrecognised model to Opus / the first OpenAI row, a real bug on
`main` today, not just something PR #197 introduced.

Builds on #197 (open, not merged, not commented on here) for one idea — Codex
CLI-based discovery — and rejects three of its mechanisms: fetching LiteLLM's
`main` branch at runtime, deriving Claude's own labels from the price catalog,
and pricing an unknown model as its "newest sibling". Each rejection is argued
from evidence gathered against this machine's real Codex install, real
transcripts and a real LiteLLM commit — see Evidence below and inline.

## Problem

`server/pricing.js`'s `rateFor`/`openaiRateFor` default an unmatched model to
`opus`/`OPENAI_TABLE[0]` — a fabricated price, not a real one, and it is on
`main` today independent of #197. `server/agents/claude.js`'s model list is a
hand-maintained array that already carries a stale label (`'Fable 5 · 1M
context'`; the alias actually resolves to `claude-fable-5-1`, confirmed from
this machine's own transcripts — see Evidence). `server/agents/codex.js`'s
model list is hand-copied from OpenAI's release notes and drifts every time a
model ships or is retired; `gpt-5.4`/`gpt-5.4-mini` are still listed there today
but are absent from this machine's live Codex catalog (superseded by the 5.6/6
families). Both hand-lists conflate two different questions — "can this model
be launched, and what does the CLI call it" versus "what does a token of it
cost" — into one array, which is exactly why a price update (`c22ced4`) and an
availability update (`4709fde`) are separate commits touching the same lines.

## The required split

**Availability/capabilities** (aliases, labels, reasoning efforts, context
windows — everything `modelError`/`launchTargetError`/`modelPillFor`/
`maxContextWindowFor` in `server/agents/index.js` need) is a property of the
**agent CLI**: what values it accepts, what it calls them, what it can do.
**Pricing** is a property of the **provider's billing**, sourced independently.
A model can exist and launch with no known price (a brand-new release); a price
can exist for a model neither CLI currently accepts (a retired one, still owed
correct historical billing for transcripts that used it). Collapsing the two, as
both hand-lists and #197 do, is what produces "unknown model prices as Opus" and
its subtler #197 replacement "unknown model prices as its newest same-family
sibling" — both invent a number. The fix is that neither catalog may borrow from
the other to fill a gap in itself.

## Codex discovery: read the account's own cache, not a subprocess

`server/agents/codex-rollout.js` already reads `~/.codex/models_cache.json`
(`loadCodexModelsCache`, self-invalidating on the file's mtime) for
`codexContextWindow` — Codex's **own**, account-scoped, CLI-refreshed model
metadata, "never hand-copied here, unlike Claude's model list which this
codebase owns directly" (the file's own comment, already correct). #197 instead
adds `codex-catalog.js`, which shells out to `codex debug models` on an hourly
`setInterval`, in-process, forever.

**Evidence.** On this machine (Codex CLI 0.157.0, real account login):

- `~/.codex/models_cache.json` holds 8 models (`gpt-6-sol`, `gpt-6-luna`,
  `gpt-5.6-sol/terra/luna`, `gpt-5.5`, plus the hidden `gpt-reserve` and
  `codex-auto-review`), `fetched_at` a few minutes old.
- `codex debug models` (no flag) ran in **0.07s**, returned the **identical 8
  slugs**, and touched neither `models_cache.json`'s mtime nor the debug
  output's own shape (no `fetched_at`/`etag` — the debug command doesn't even
  echo the cache's provenance fields). It is not doing a fresh network fetch; it
  is dumping the CLI's already-loaded state, which came from the same file the
  wrangler can already read directly.
- `codex debug models --bundled` returned **11** models, led by `gpt-6-astra`
  (`available_access_programs.cyber` gated — this account doesn't have it),
  which the account's live cache never lists. `--bundled` is the binary's
  shipped catalog, decoupled from any account; it is *not* "what this session
  can launch".

**Decision.** At runtime, read `~/.codex/models_cache.json` directly — extend
the existing reader to also carry `display_name`, `description`, `visibility`,
`default_reasoning_level` and `supported_reasoning_levels`, not just
`context_window`. No subprocess, no interval, no new dependency on an
undocumented `debug` CLI surface at runtime: the wrangler asks a file Codex
itself already keeps current, the same way it already does for context window.
`visibility !== 'list'` rows (`gpt-reserve`, `codex-auto-review`) are filtered
out everywhere a model list is rendered or offered.

Reused from #197: `codex debug models --bundled` **is** the right tool, but
only to *generate* the checked-in fallback snapshot (below), run by a human
with the CLI installed — never by the running server. `--bundled`'s
account-independence is a feature there (a reproducible, versioned artifact)
and a liability at runtime (it would offer entitlement-gated models this
account can't actually launch).

**Fallback tier**, for a machine with no `~/.codex/models_cache.json` yet (a
fresh Codex install that has never run, or a Claude-only machine where `~/.codex`
doesn't exist at all): `server/agents/codex-models.snapshot.json`, checked in,
regenerated by a human running `codex debug models --bundled` locally and
committing the diff — this repo's CI has no Codex binary and no Codex account
(confirmed: `.github/workflows/test.yml` runs on bare `ubuntu-latest`, installs
only `tmux`), so this snapshot **cannot** be CI-generated the way the pricing
snapshot is (below); it stays a manual, reviewed commit, same discipline as
today's hand-edited `codex.js` model array, just sourced from the CLI's own
dump instead of typed by hand from release notes.

## Claude discovery: there is none — the list stays hand-authored, on purpose

**Evidence.** `claude --help` documents `--model <model>` as accepting "an
alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full
name" — no enumeration, and the help text itself doesn't even name `haiku`,
`opusplan` or `sonnet[1m]`. There is no `claude debug models`, `claude models`,
or any cached catalog file under `~/.claude/` or `~/.claude.json` (checked
directly). Nothing on this machine's Claude Code install exposes a queryable
model list.

**Decision.** Claude's availability/capabilities table stays exactly what it is
today: a hand-maintained array in `server/agents/claude.js`, updated by a human
in the same commit that adds a model — because there is nothing to discover it
from. This is a real constraint, not a choice deferred for later: #197's
alternative (derive the *label*'s version suffix from the price catalog's
newest same-family model) is rejected because it makes Claude's own displayed
identity depend on whether a *pricing* file happens to have heard of the model
yet, and because it doesn't even fix the problem it targets — see below.

**Why label-from-pricing is rejected, concretely.** This machine's own
transcripts (`~/.claude/projects/*/*.jsonl`) show `fable` currently resolves to
`claude-fable-5-1`, while `claude.js`'s hand-written label says `'Fable 5 · 1M
context'` — genuinely stale, real evidence the label needs fixing. But
`newestClaudeName('fable')` doesn't fix this by discovering Claude's truth; it
fixes it by delegating to whatever LiteLLM happens to have added for the
`claude-fable-` family, which is a **third party's transcription of Anthropic's
release notes**, not Claude Code's own report of itself. A gap or lag in
LiteLLM's coverage (their file is community-maintained, updated by a bot PR
process with its own latency) now silently mislabels a model Claude Code
already launches correctly. The correct fix for the stale label is the
boring one: a human updates the string when they update the alias's target, in
the same PR — exactly the discipline `codex.js`'s own comment on its `efforts`
list ("Codex's own `supported_reasoning_levels`, per its model catalog")
already expects, just without a discovery source to check against. This design
doc does not
itself fix the current stale label; that is a one-line correction in the
implementation PR, using the CLI's own printed alias-to-full-name mapping
(`--help`'s examples plus a spot-check launch) as the source, not a pricing
file.

## Pricing: is LiteLLM even the right source?

Not on its own authority — the providers' own pricing pages are, and LiteLLM
is only worth using to the extent it faithfully mirrors them. Checked directly
rather than assumed: the pinned commit's own JSON carries a **per-row
`source` field**, and for `claude-opus-5-5`, `claude-fable-5-1`,
`claude-opus-4-8`, `gpt-6-sol` and `gpt-5.5` alike it reads
`https://platform.claude.com/docs/en/about-claude/pricing` or
`https://developers.openai.com/api/docs/pricing` — the **same OpenAI URL**
`server/pricing.js`'s own current comment already cites as its hand-transcribed
source. Counted across every Anthropic/OpenAI `chat`/`responses` row in the
pinned file: **113 of 133** carry that per-row source; the other 20 are almost
all dated legacy ids from before LiteLLM started annotating rows
(`claude-opus-4-5-20251101`, old `gpt-4`/`gpt-3.5-turbo` variants,
fine-tune ids) rather than anything currently priced. One of those 20,
`claude-haiku-4-5-20251001` — the exact dated id this machine's own Claude
Code transcripts emit — has no `source` field but matches its sourced sibling
`claude-haiku-4-5` exactly ($1/$5/1M), which reads as an unannotated carry-over
rather than a wrong number, though that is inference, not proof the way the
113 sourced rows are.

So: **LiteLLM is not the source of truth, and this design does not treat it as
one.** It is the best available *structured, versioned, CI-consumable* proxy
for the actual source of truth (the providers' own pages), and for the large
majority of rows this catalog needs, it is transparently just that proxy —
each row says which official page it mirrors, so a reviewer isn't asked to
trust LiteLLM blind. The realistic alternative to LiteLLM is not "go straight
to the authoritative source" — that source is an HTML marketing page with no
stable schema, no commit history and nothing for `npm test` to reproduce
against — it is either the current manual hand-transcription (correct, but the
unscalable status quo this whole design exists to replace) or writing and
maintaining a second, in-house scraper against those same pages, which is
strictly worse engineering than consuming a scrape pipeline that already runs,
already versions its output in git, and already tells you per row when it's
mirroring the official page versus carrying an older, unannotated value.

**Decision, revised from the plain "keep #197's provenance block" idea below:**
provenance is **row-level**, not just file-level. The generated snapshot keeps
each row's own `source` (when LiteLLM provides one) alongside the reduced
rate, and the generator's CI validation (below) **warns, but does not
block**, on any row in the reduced output that lacks one — surfaced in the PR
description as "N of M changed rows are official-page-sourced" so a human
reviewer can tell an official-page-mirrored price change apart from a legacy
carry-over before approving it. This is strictly more honest than #197's
single blanket `"source": LITELLM_URL` (kept below only as the *file-level*
fallback attribution, for the minority of rows with none of their own).

#197's `price-catalog.js` fetches
`https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
— `main`, a mutable ref — from inside the running server, every 12 hours,
forever, and adopts whatever it gets back if it merely has enough rows
(`MIN_ROWS = 10`). This is rejected outright, for reasons independent of
whether LiteLLM's data is currently good:

- **No review gate.** A price change ships into every running wrangler within
  12 hours of landing on someone else's `main`, with no diff a human ever saw.
  Contrast the existing precedent this repo already has for exactly this kind of
  update: `c22ced4` ("Price Opus 5.5, Sonnet 5 and Fable 5.1 at their own
  rates") is a normal, reviewed commit. The live-fetch design removes the
  review step that commit went through.
- **Runtime network dependency for a number that changes on the order of
  weeks.** The server now depends on GitHub's raw-content CDN and a
  third-party repo's continued availability/shape to price a session — a new
  failure mode and a new egress requirement for something that doesn't need to
  be live.
- **A mutable ref is not a provenance record.** "Fetched at 2026-09-25 from
  `main`" tells you nothing reproducible: `main`'s HEAD at that instant is
  already gone by the time anyone asks what the server actually saw.

**Decision.** Pricing is a **checked-in, generated JSON snapshot**
(`server/price-catalog.snapshot.json`, keeping #197's filename and shape:
`{anthropic: {id: rate}, openai: {id: rate}}`), regenerated by a script that:

1. Resolves the **current HEAD commit SHA** of
   `BerriAI/litellm`'s `model_prices_and_context_window.json` via the GitHub API
   (`gh api 'repos/BerriAI/litellm/commits?path=model_prices_and_context_window.json&per_page=1'`
   — this is the *only* place a mutable ref is touched, and only to name a
   candidate commit, never to fetch content by it).
2. Fetches the file **by that exact SHA** (an immutable, content-addressed URL:
   `raw.githubusercontent.com/BerriAI/litellm/<sha>/model_prices_and_context_window.json`).
   Verified today: SHA `e106dbd8ba9b22317cac4d7d3fb6036777a70cd7`, 2,919,147
   bytes, sha256
   `e1ed31bbf608a61c1929f19f0f41395959785bc4fde07fbc2f8284df4396d669`. A
   real, checkable example, not an invented one.
3. Reduces it with #197's `reduceLitellm`/`reduceEntry` logic (kept — the
   per-token→per-1M conversion and the anthropic/openai `chat`/`responses`
   filter are sound), **except** the parts that synthesize a number for a
   missing field (rejected below), and **carrying each row's own `source`
   field through** when LiteLLM provides one.
4. Writes the snapshot with a **file-level provenance block plus per-row
   provenance**:
   ```json
   {
     "source": "https://github.com/BerriAI/litellm",
     "path": "model_prices_and_context_window.json",
     "commit": "e106dbd8ba9b22317cac4d7d3fb6036777a70cd7",
     "retrievedAt": "2026-09-25T16:40:00Z",
     "transformVersion": 1,
     "anthropic": {
       "claude-opus-5-5": { "input": 4, "output": 20, "...": "...",
         "rowSource": "https://platform.claude.com/docs/en/about-claude/pricing" },
       "claude-opus-4-5-20251101": { "input": "...", "...": "...", "rowSource": null }
     },
     "openai": { "...": "..." }
   }
   ```
   The file-level block is the fallback attribution for a row with no
   `rowSource` of its own; `transformVersion` bumps whenever `reduceLitellm`'s
   shape or rules change, so a stale snapshot generated by an older transform
   is a detectable mismatch, not a silent drift.
5. Diffs against the previous snapshot and opens a **reviewable PR** — a human
   reads the price changes before they ship, same review this repo already
   gives every other pricing commit.

**Spot-check, not assumed.** Every rate this doc's author pulled from the
pinned commit above matched the hand tables exactly: `claude-opus-5-5` → input
$4, output $20, cache-read $0.20/1M; `claude-fable-5-1` → $10/$50/$0.25;
`gpt-6-sol` → $2/$10/$0.20 — all equal to today's `server/pricing.js`.
Critically, **`claude-opus-4-8`** (a historical id, seen in this machine's own
transcripts, no longer launchable) priced at $5/$25/$0.50 — the *old* generic
"opus" row, distinct from current `opus-5-5`'s $4/$20/$0.20. LiteLLM keys prices
by **exact model id**, which is what makes "historical models stay priceable"
true for free: a catalog keyed by exact id (as #197's `reduceLitellm` already
does) prices `claude-opus-4-8` correctly forever, where `main`'s substring
`.includes('opus')` match prices it at *whatever today's generic-opus row is* —
right by coincidence today, wrong the moment a third "opus" tier ships. No
discrepancy was found between LiteLLM and the hand tables, so this design does
**not** add a hand-authored override layer on top of the generated snapshot —
that would be unjustified complexity against zero observed need. If a real
discrepancy is ever found, it becomes a `transformVersion` bump or an
explicit, reviewed row-level correction committed alongside the snapshot, not a
silent runtime override.

### Why "unlisted sibling" and "$0" pricing are also rejected

#197's `lookup()` step 3 prices a model the catalog has never heard of (a brand
new `claude-opus-6`, say) as **"the newest model sharing its family stem"** —
smarter than main's plain substring match, but still inventing a number: it is
"price as Opus" wearing a version-aware disguise. #197's `rateFor` then falls
further back to a hard-coded `UNPRICED = {input: 0, ...}` for a model with no
family match at all — pricing it at **exactly $0**, which is indistinguishable
from a real free tier and will silently under-report real spend the moment such
a model appears. Both substitute a rate that does not exist. The rule this
design commits to: **a model absent from the catalog has an unknown price,
full stop — never $0, never Opus, never a sibling's rate.**

## Rendering "unknown", concretely

`rateFor`/`openaiRateFor` return `null` for a model absent from the catalog —
no fallback row at all. `costUsd`/`codexCostUsd` (`server/pricing.js`) change
shape to `{ usd, unpriced: { models: string[], tokens: {...} } }`: `usd` sums
only the models that priced, and `unpriced` names what didn't, so a session that
is 99% Opus and 1% a brand-new unpriced preview model still shows a real, useful
total rather than going dark or silently dropping the unpriced 1%. A model with
zero tokens never marks a total unpriced — it just never appears in `unpriced`.
`<synthetic>` (a real value seen in this machine's transcripts, emitted by
Claude Code for non-billable turns) carries no token counts and is excluded
from pricing lookups entirely, same as today — it must never appear in
`unpriced` either.

This is a breaking shape change for every caller currently treating `costUsd(...)`
as a bare number — `server/usage-report.js` (`usd: costUsd(totals)`, summed with
`+=` throughout its rollups), `server/transcript-reader.js` (already has a
`usd: a.usage ? costUsd(t) : null` precedent — this design generalises that
existing "no data → null" convention to "no price → still a number, plus a
named gap" rather than reusing bare `null`, because `null` can't survive a
`+=` rollup the way the existing code does it) and `host.usage.byCard()`
(`server/host-api/v1.js`, a published extension capability — bump
`HOST_API_VERSION`'s minor version alongside this change, additive only). The
render points are `public/cards.js` (`typeof s.usd === 'number' ? s.usd :
0`) and `public/usage.js`/`public/usage-data.js` (`fmtUsd`) — **not**
`public/app.js`, which has no `usd` reference despite the task naming it; this
doc uses the real files. Each gets an "unknown" affordance (an `≈`-style marker
plus a tooltip naming the unpriced model(s)) rather than silently rendering
`$0.00` or omitting the gap. `costUsd`'s cost-cache signatures (wherever a
memoised total already folds in a cache-invalidation key, e.g. `codex-rollout.js`'s
`modelsCacheMtime`) additionally fold in the price catalog's own version/commit,
the same pattern `codexContextWindow` already uses for its mtime-keyed cache —
so a catalog regeneration invalidates cached totals without a restart.

**Estimate vs. real spend stays distinct, and neither claim widens.** Codex
already marks every dollar figure `estimatedUsd` (Codex usually bills through a
ChatGPT plan, not the API) with a `~` in the UI. Claude's `usd` is currently
treated as exact (`estimatedUsd: 0` throughout `usage-report.js`), which is only
true on API-key billing — a subscription-plan Claude login is *also* an
API-equivalent estimate, not real metered spend. This design does not attempt
to detect a session's auth mode (no reliable signal for it exists in what the
adapters currently expose) and therefore does not change Claude's
`estimatedUsd: 0` today — flagged here as a known gap this catalog split does
not close, rather than silently pretending it does.

## Trust boundaries

- **LiteLLM's JSON is untrusted third-party data**, never executed, consumed
  only as numeric fields through the existing `reduceEntry`/`perM` validation
  (type + finite + non-negative). A malformed or truncated fetch is rejected by
  the generator script (`MIN_ROWS`-style sanity check) and never adopted — but
  now the check runs once, in a human-reviewable CI/generation step, not every
  12 hours in the process billing live sessions.
- **The running server makes zero outbound network calls for pricing.** The
  fetch happens only in the generation script (CI or a human's machine); the
  deployed wrangler reads a file it shipped with. This removes the runtime
  supply-chain surface #197 introduces — a compromised or hijacked `main` on a
  third-party repo would otherwise be one 12-hour tick away from every running
  wrangler.
- **`codex debug models`/`--bundled` runs the CLI already installed and
  trusted to run agent sessions on this machine** — a fundamentally different
  trust level than deserializing arbitrary remote JSON. Its output still isn't
  free-floating trusted, though: `display_name`/`description` render into the
  dispatch dialog and must go through the same escaping every other
  third-party-sourced string in this codebase gets (`textContent`, not
  `innerHTML` — the Extensions API doc's own rule for exactly this kind of
  string), and a model **slug** that reaches `-m <slug>` or
  `-c model_reasoning_effort=<effort>` (both `commonFlags` in `codex.js`, the
  effort interpolated **unquoted** into a TOML override today) must be
  validated against a strict character set (`^[a-z0-9.-]+$` for a slug,
  `^[a-z]+$` for an effort) before it reaches either, not merely relied on to
  come from a trusted-looking file — the file is trusted to exist and be
  Codex's own, not trusted to survive unchecked into a shell/TOML context.
- **Claude has no discovery source, so nothing changes here**: its model list
  stays a same-trust-level-as-any-other-source-file hand-authored array, which
  is itself the point — a compromised or merely-lagging price catalog can never
  add, remove or relabel what Claude Code can be launched with, because the two
  are sourced from unrelated places entirely.
- **Both catalog modules stay leaf-compatible** (the Extensions API's leaf rule:
  no import of `session-manager`/`state-reader`/`tmux-scraper`/`index.js`), the
  same constraint `codex-rollout.js` and `claude.js` already satisfy — they are
  imported by the agent adapters, which the leaf rule already covers.

## `list_models` MCP tool

Backed by exactly the same source `modelError`/`launchTargetError`
(`server/agents/index.js`) already validate against — `ALL.map(a =>
({id: a.id, models: a.models, efforts: a.efforts}))` — never a second catalog.
Each model row additionally carries a `priced: boolean` (from `priceFor`/
`rateFor` returning non-null) so an agent choosing a model can see, in the same
call, whether its cost is currently known — joining the two catalogs at read
time, never merging them into one stored structure. Read-only, same shape as
`list_sessions`/`get_session_cost` (`server/mcp/tools/`). This is also what
launch validation already reads, so a model the tool lists is guaranteed
launchable — no second list to drift from the first, the same principle
`modelChoicesText`'s own comment already states for the spawn-session skill.

The generated `agent-skills/skills/spawn-session/SKILL.md` model table
continues to render from the adapters' live in-process `.models`/`.efforts` at
generation time (`scripts/gen-skill-models.mjs`, unchanged in spirit) — **not**
from runtime discovery, and **not** re-run against a live Codex install inside
CI (CI has neither the binary nor an account). The skill's own text should
point an agent at `list_models` for the authoritative live list, exactly as
#197's SKILL.md diff already added the line "The running wrangler's lists can
be newer than this table" — that framing is correct and is kept.

## CI mechanics: why generation, not a bot PR that self-validates

`gh api repos/PortSwigger/agent-wrangler/actions/permissions/workflow` →
`{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}`.
A workflow can still request `contents: write`/`pull-requests: write` for
itself and open a PR with the default `GITHUB_TOKEN` — but GitHub does not run
further workflows off events a `GITHUB_TOKEN`-authored push/PR produces
(the documented loop-prevention rule), so `.github/workflows/test.yml`
(`pull_request: [opened, synchronize, reopened]`) would **not** fire on that
PR regardless of what permissions the opening workflow was granted. A separate
PAT or GitHub App installation would fix this but requires provisioning a
credential this task does not have and should not invent — flagged as a real,
unresolved gap, not silently worked around.

**Decision.** The pricing snapshot is generated by a plain `npm run
gen:pricing`-style script (network access to GitHub only, no server
involvement), run **locally by a human** (or a Wrangler session acting as one,
opening the PR under its own identity the normal way, exactly how any other
commit in this repo is made) — never by an Actions bot. What runs **in CI** on
the resulting PR is reproducibility validation, added to the existing `npm
test` suite: fetch the raw file at the snapshot's own recorded `commit` (an
immutable URL — safe and deterministic to fetch in CI, unlike `main`), verify
its sha256 against a value recorded at generation time, re-run
`reduceLitellm` at the recorded `transformVersion`, and assert the result
equals the checked-in JSON byte-for-byte; separately, count what fraction of
the *changed* rows carry their own `rowSource` and post that count into the
generation script's own log (not a hard gate — a legacy row genuinely can lack
one, per the `claude-haiku-4-5-20251001` case above — but a reviewer should
see "12/12 changed rows are official-page-sourced" or "3/12" before approving,
not have to go compute it by hand). This is a real CI check with a real
failure mode (a snapshot that was hand-edited, or generated with a stale
transform, or whose commit no longer serves the same bytes) — not the
self-referential "CI validated its own PR" #197's shape would have implied
even if the trigger problem didn't exist. The Codex snapshot has no equivalent
CI check today (no Codex binary in CI to reproduce against) and stays
reviewed by inspection only — noted as an accepted gap, not solved here.

## No Jira ticket

The last 100 commits on this repo carry no Jira ticket keys, and
`searchJiraIssuesUsingJql` against this task returned `403` — "app not
installed". Per this session's global instructions, a Jira-tracked task should
be assigned and sprint-scheduled; that could not be done here. **Flagging for
James**: the Atlassian MCP connection for this project needs the Jira app
installed/reconnected before this or related follow-up work can be ticketed.

## Deferred

- A hand-authored per-row price override file. Not needed today (zero
  discrepancies found against a real pinned LiteLLM commit); add one only if a
  future spot-check finds LiteLLM actually wrong for a model this repo bills.
- CI-side generation/validation of the Codex snapshot. Blocked on a CI runner
  with the Codex CLI installed and an authenticated account, neither of which
  exists today; the snapshot stays a manual, reviewed commit.
- Detecting Claude's or Codex's auth mode (API key vs. subscription) to decide
  whether a `usd` figure is real spend or an API-equivalent estimate. No
  reliable signal for this exists in what the adapters currently expose;
  Claude's `estimatedUsd: 0` stays as-is, a known-inexact figure on a
  subscription login.
- A PAT/GitHub-App credential that would let a generated pricing PR trigger
  `test.yml` automatically. Provisioning a new credential is outside this
  design's scope; until it exists, a human merges the pricing PR after reading
  its CI-run reproducibility check (which runs regardless, as part of the
  generation script's own job) rather than relying on `test.yml`.
- Fixing `claude.js`'s currently-stale `'Fable 5 · 1M context'` label. Real bug,
  confirmed against this machine's own transcripts, but a one-line hand
  correction in the implementation PR, not a mechanism this design needs to
  build.
