# Archive-time memory review

**Status:** implemented, PR #65
**Date:** 2026-08-24
**Scope:** an opt-in server-side capture that turns an archived session's own
words into a short note in its task's shared memory. Consolidation/compaction
of accumulated memory.md content is explicitly out of scope — see *Explicitly
rejected*.

## Problem

Per-task memory (`~/.agent-wrangler/memory/tasks/<taskId>/memory.md`) only
accumulates content when an agent remembers to write to it (the `task-memory`
skill's own norm: "append a brief note... when adding context"). In practice
the hard-won context of a session — pitfalls hit, corrections the user made
mid-session, decisions and their reasons — evaporates when the session is
archived, and the next session under that task starts cold.

## Design

### Hook point

`SessionManager.archive()` (`server/session-manager.js`) is the single funnel
every archive passes through — the board's solo "Stop & archive", the cascade
("Archive all"), the `archive_session` MCP tool (shares the cascade path), and
`reconcileExitedSessions`'s auto-archive on a clean agent exit. A
`this._archiveReview` seam, mirroring the existing `_ensureCodexTrust` seam,
defaults to a no-op so every existing archive-path test stays inert; `server/
index.js` binds it to the real runner with `memoryStore` injected, keeping
`session-manager.js` free of that dependency. Fired **unawaited** — archive
never waits on it.

**Not-again guard.** `archive()` is "set aside", not end-of-life — `resume`
clears `archivedAt` — so a naive hook would re-review the same growing
transcript on every archive→resume→archive cycle. Two guards: skip entirely
if the session was already archived before this call; and bound the excerpt
sent to Haiku by `max(usageSince(entry), entry.archiveReviewedAt)`, so a
re-archive reviews only the turns added since the last review. The
`usageSince` half matters independently — a **fork's transcript replays the
parent's entire history with no on-disk marker** (the same invariant the cost
scanners rely on), so without it archiving a fork would write the parent's
work into memory.md a second time.

### The excerpt is human turns only, not the full transcript

`buildExcerpt` (`server/archive-review-runner.js`) keeps only `type: 'user'`
entries — no assistant text, no tool calls. The durable signal this feature
exists to capture (stated preferences, corrections, decisions and their
reasons, dead ends) lives almost entirely in what the user actually typed;
assistant/tool content is the overwhelming majority of transcript bytes and
carries almost none of that signal. Bounded per the guard above, truncated
per-turn (3000 chars) and capped in total (40000 chars, head+tail with an
elision marker over that) so a very active session can't blow the model's
context or run up cost.

### Invocation

A headless `claude -p --model haiku` subprocess (`execFile`, excerpt on
stdin so there's no argv length limit): `--strict-mcp-config
--setting-sources '' --disallowed-tools <all> --session-id <fresh uuid>
--output-format json`.

- **`--session-id <uuid>`, never `--no-session-persistence`.** The uuid is
  pushed onto the archived card's `entry.priorLiveSessionIds`, so the
  review's own spend is picked up by the existing cost scanners
  (`usage-report.js`, `cost-report.mjs`) for free — that field is
  deliberately excluded from `cardForLive`, so nothing will ever try to
  resume it.
- **`--bare` is unusable**, contrary to first appearance — it would cut the
  CLI's ~16k-token system-prompt floor, but verified against the real binary
  it fails with `api_error`: it reads only `ANTHROPIC_API_KEY`, never
  OAuth/keychain.
- Env stripped of `CLAUDECODE`/`CLAUDE_CODE_*` (`cleanClaudeEnv`, mirroring
  `withCleanClaudeEnv`) or the review looks nested and drops its own
  transcript.

### The extraction prompt

At most 5 markdown bullets, each a specific checkable fact, prioritised:
explicit user instructions/corrections/preferences; a pitfall or wrong
assumption the user's own words reveal; a decision and its stated reason;
cross-cutting constraints. Hard rules: no recap or narrative, nothing
recoverable from code/git history, nothing repo-specific (that belongs in
the repo's own `CLAUDE.md`), and — the one change that came out of adversarial
review — **"most sessions teach nothing durable... this is the expected,
common outcome, not a failure,"** so the model isn't implicitly pressured
into manufacturing five bullets out of a thin session.

### Output validation — `looksLikeBullets`

Found live, not theorised: against a genuinely thin (~200-char) excerpt,
Haiku reliably (5/5 in testing) responded with confused prose — *"I don't see
a transcript excerpt in your message..."* — instead of the instructed `NONE`.
That must never land in memory.md. The fix is output-side: only a response
whose first non-blank line starts with `-`/`*` is written; anything else
(`NONE` included) is treated as "nothing to write." Verified this doesn't
reject real output: two full-size real transcripts still produced clean
bullet lists.

### Writing to memory.md

`MemoryStore.append(taskId, md)` (new — the store previously had only
whole-file `write()`), implemented as a single synchronous `fs.appendFileSync`
call. This is what makes the concurrency story simple: `set-memory`
(a human editing the file) sends the whole document, so a read-modify-write
append racing that save — or another review — would lose data; two
concurrent `O_APPEND` writes both land intact regardless of interleaving. A
concurrency cap of 2 in-process reviews at a time (a cascade or
`reconcileExitedSessions` can archive many sessions at once) keeps a big
teardown from spawning a dozen `claude` processes together.

### Config

`archiveReviewEnabled` (`config-store.js`), default **false** — opt-in via
the Settings modal, wired exactly as `trustCodexLaunchCwd` is (a control
handler, a graph flag, a `SETTINGS` row, the client bridge).

## Evidence

Real numbers, not estimates, gathered before and during implementation:

| measurement | value |
|---|---|
| cost per review (45KB excerpt) | $0.059–$0.067 |
| CLI system-prompt floor's share of that | ~90% |
| `--disallowed-tools <all>` saving over the default tool list | ~30% off the prompt |
| real archive volume (30 days, this machine) | 30 archives → **~$2/month** |
| busiest task's memory.md today, zero automation, 18 sessions | 11.6KB (~650B/session) |

Output quality: run against three real archived transcripts (not the same
one resampled). Two produced specific, checkable bullets — file paths,
config keys, line numbers, PR numbers — genuinely present in the user's own
words, not hallucinated. One surfaced the accuracy risk recorded under
*Known limitations*.

## Testing

- `server/archive-review-runner.test.js` (17 tests, all deps injected, no
  real subprocess): every guard (flag off, non-Claude, no task, no
  transcript, empty excerpt) never spawns the subprocess; a `NONE` result and
  confused free-text prose both write nothing; a real bullet answer writes
  exactly one dated section and stamps `priorLiveSessionIds`; a reviewer
  error does **not** advance `archiveReviewedAt`; the excerpt is bounded by
  both `usageSince` and `archiveReviewedAt`; `buildExcerpt` excludes assistant
  content categorically, even a clean turn with nothing wrong with it; the
  size cap keeps head+tail with the elision marker.
- `server/config-store.test.js` — `archiveReviewEnabled` defaults false.
- `server/session-manager.test.js` — the seam is called once per fresh
  archive with the right `(sessionId, entry, task)`; a re-archive of an
  already-archived session does not call it again; `onStamp` records
  `priorLiveSessionIds` and only advances `archiveReviewedAt` on success; an
  unstubbed (default) seam is an inert no-op, so every pre-existing archive
  test is unaffected.
- **`server/test-setup.js` redirects `AW_DATA_DIR`** (not just `CODEX_HOME`)
  to a per-process temp dir — a real gap this feature exposed:
  `config-store.test.js` previously had to snapshot-and-restore the real
  `~/.agent-wrangler/config.json` for lack of any alternative, and once
  `archiveReviewEnabled` is a real flag, a live install with it turned on
  would have made `npm test` spawn real billed `claude -p` subprocesses and
  append to real task memory — the `~/.codex/config.toml` incident
  (`codex-trust.js`) again, with a bill attached.
- Manual: verified live against a real dev instance that
  `SessionManager.archive()` invokes the seam with the correct entry/task/
  `liveSessionId`, and separately verified the full pipeline (transcript →
  excerpt → Haiku → append) against real archived transcripts, both thin
  (correctly returns `none`) and rich (correct, specific bullets). A fully
  board-driven click-through (dispatch → archive over the live WS) was
  attempted but blocked by dispatch-timing flakiness on a busy dev machine,
  not by this code — the transcript-not-yet-written path it exercised is
  handled safely (`skipped`) by design.

## Review record

Two independent adversarial reviews were run before implementation: a
**prosecutor** (given full context, attacking cost/benefit and failure
modes) and a **blind architect** (given only the problem statement, not this
design, asked to design their own answer).

| finding | disposition |
|---|---|
| `npm test` could spawn real billed subprocesses against a live install's real config once the flag exists | **accepted, verified** — `test-setup.js` now redirects `AW_DATA_DIR` |
| Spend should be visible to the existing cost tooling, not just stamped inertly | **accepted** — `--session-id` + `priorLiveSessionIds` instead of `--no-session-persistence` |
| A re-archive (post-resume) would re-review the same growing transcript | **accepted** — `archiveReviewedAt` bound, not-again guard |
| A fork would double-review the parent's replayed history | **accepted** — `usageSince` bound |
| Full-transcript input dilutes the extraction with narrative that carries no signal | **accepted** — switched to human-turns-only (see *Known limitations* for the trade-off this creates) |
| memory.md will grow unboundedly under automated append, and is already at 11.6KB with zero automation | **heard, not adopted for v1** — see *Explicitly rejected* |
| A model asked for "durable knowledge" will manufacture bullets even from a thin session rather than say so | **accepted, verified live** — prompt now states "most sessions teach nothing durable... expected, common outcome"; output-side `looksLikeBullets` guard added after live testing still showed the model sometimes ignoring the instruction |

## Known limitations (accepted, not solved here)

- **Human-turns-only extraction can surface a superseded instruction.**
  Verified against a real transcript: a decision reversed via the
  *assistant's* investigation (not restated by the user afterward — e.g. "I
  checked, PR #93 already rejected this, 14+ import sites, don't reopen")
  is invisible to a human-turns-only view, so the original (now-wrong)
  instruction can be reported as current. This is a real, documented
  trade-off of the design, not a bug to fix by widening the excerpt back to
  the full transcript (that reintroduces the diluted, low-signal input the
  design deliberately avoids).
- **Nothing removes a wrong bullet once written.** An append-only file that
  every future session reads treats it as authoritative. Mitigated only by a
  human noticing and editing.
- **memory.md grows unbounded.** Sections accumulate; nothing dedupes or
  compacts them. Guards that keep it tolerable for now: a 5-bullet cap, `NONE`
  honoured, the flag off by default.
- **Claude only.** Codex's rollout format differs and isn't parsed; Codex
  archives are skipped.
- **Spend is a per-session record, not (yet) a report line.** `usage-report.js`
  and `cost-report.mjs` will fold this into a card's existing totals via
  `priorLiveSessionIds`, but neither report breaks it out as its own line
  item today.

## Explicitly rejected

- **A fenced auto-owned zone in memory.md with a hard bullet cap, each
  capture a merge (replace) rather than an append.** Raised independently by
  the blind-architect review, and the objection behind it is real: at
  ~650B/session with *zero* automation the busiest task's file is already
  11.6KB, and unattended append-only growth will eventually make it too long
  to be read properly. Not adopted for this iteration — a deliberate,
  explicit call to ship the simpler mechanism first (append, capped bullets,
  `NONE` honoured) and revisit growth if it proves to be a real problem in
  practice, rather than build the merge/fence machinery speculatively. This
  is the single largest open trade-off in this design and is recorded here
  precisely so it isn't lost.
- **Consolidating against existing memory.md content.** Haiku only ever sees
  the transcript excerpt, never the file it's appending to. Keeping the
  prompt to just the session's own input is what keeps a review both cheap
  and reliably on-topic; deduping/consolidating accumulated notes is a
  separate job.
- **Always-on (no config flag).** Rejected given the per-archive cost and
  the unbounded-growth trade-off above — this ships opt-in, off by default.
- **A raw Anthropic API call instead of the `claude -p` CLI.** Would need its
  own `ANTHROPIC_API_KEY` configured and billed separately from ordinary
  Claude Code usage; the CLI reuses existing auth for a small, accepted
  system-prompt tax.
