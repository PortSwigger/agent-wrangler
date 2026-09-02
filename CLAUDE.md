# CLAUDE.md

Developer notes for the wrangler's internals. The README is the user-facing
overview; this file is **only the non-obvious, durable things you'd get wrong
without being told** — invariants, footguns, gotchas, commands. If a fact is
easily recovered by reading the code, it does not belong here. Point to the code;
don't re-derive it.

## Mental model

- `~/.agent-wrangler/mappings.json` keys each session by its **card id** (a stable
  board handle — also the `sessionId` variable and map key) and stores the real
  conversation id separately as `entry.liveSessionId`. **The card id is never a
  conversation id — never `--resume` it.** Nearly every per-session field (snooze,
  workflow, PR toggles, …) is **keyed on the card id, never the live id.**
- `buildGraph` (`server/state-reader.js`) is the single source of truth for what's
  attachable. **A mapped tmux is attachable only with a live pane** — `remain-on-exit`
  keeps exited panes around so failures stay readable, but a dead pane re-offers
  Resume rather than trapping the session on a corpse. Two WebSockets
  (`server/index.js`): `/ws` (control) and `/pty` (one per terminal, a `node-pty`
  running `tmux attach`). Closing a `/pty` detaches that one client only — it never
  kills the tmux session, so switching/co-attaching is cheap and safe.

## Invariants & footguns

- **Agents are adapters, and the import direction is one-way.** `server/agents/*`
  (`claude.js`, `codex.js`, behind `index.js`'s registry) is a **leaf** — it must
  never import `session-manager`/`state-reader`/`tmux-scraper`/`index` (those import
  *from* it). It may import the `mcp/client-config` leaf, never the MCP *server*.
- **Resume is `--resume <liveSessionId>` and fails OPEN — guard it.** `claude
  --resume <id>` only finds the conversation from the project bucket of its *launch*
  cwd; given an id not bucketed there it **silently starts a fresh empty session**
  (looks like a "cleared" card; transcript is fine on disk, just orphaned). So
  resolve the launch dir by the **live id** (`resolveResumeDir`), and if the
  transcript is missing everywhere **refuse** rather than replace a lost session with
  a blank one. Codex has no preset id — its `liveSessionId` is *discovered*
  post-launch (recency under `~/.codex/sessions/`) and isn't cwd-bucketed, so it's
  skipped by the guard. Legacy pre-split entries have no `liveSessionId`; keep the
  card-id fallback.
- **Codex specifics.** Pane-scraped status (working/idle only, no needs-you), `cx_`
  tmux prefix (Claude `cc_`), cost is an *estimate* shown with `~`, offered only when
  the `codex` binary is on PATH.
- **Codex's "trust this directory" dialog cannot be silenced with a `-c` flag —
  verified against the installed binary.** `-c projects."<path>".trust_level="trusted"`
  is silently ignored by the interactive dialog, whichever path it's keyed on; only an
  entry already *persisted* in `~/.codex/config.toml` at process start suppresses it.
  For a linked git worktree, Codex resolves trust to the worktree's MAIN checkout (git
  commondir), so `ensureCodexTrust` (`server/codex-trust.js`) — called from
  `session-manager.js` dispatch/resume/fork via the `this._ensureCodexTrust` seam,
  only when `agent === 'codex'` and `trustCodexLaunchCwd()` is on — persists trust for
  `worktree.repoRoot` (not the worktree path) so one write covers every worktree of
  that repo. **TOML forbids two `[table]` headers for the same key — a duplicate
  `[projects."X"]` block makes Codex refuse to load config.toml AT ALL**, breaking
  every Codex session on the machine (wrangler-launched or not) until a human edits the
  file by hand — verified live. So the writer is idempotent (no-ops if already
  trusted, checked synchronously with no `await` before the append, so two calls from
  this process can't interleave — same technique as `mailbox-store.js`), append-only
  (never rewrites existing bytes, so it can't clobber a concurrent external writer's
  unrelated change), and re-scans the whole file after writing; if it finds a
  duplicate (a lost race against some other process, e.g. a manual `codex` run
  accepting its own prompt at the same path), it surgically removes exactly the bytes
  it just appended, leaves a forensic `config.toml.wrangler-broken-<ts>` copy, and
  throws so the launch fails loudly rather than leaving a broken config on disk.
  **Never call `ensureCodexTrust` directly in a test** — `server/test-setup.js`
  (loaded via `node --test --import`, see `package.json`'s `test` script) redirects
  `CODEX_HOME` to a per-process temp dir for exactly this reason: a
  `dispatch/resume/fork` test with `agent: 'codex'` and no `_ensureCodexTrust` stub
  once genuinely wrote "trust `os.tmpdir()`" into this developer's real
  `~/.codex/config.toml`. The `this._ensureCodexTrust` instance seam (parallel to
  `_newSession`/`_save`) exists so a test can also assert the wiring without touching
  any filesystem at all.
- **A session's cost includes its dispatched sub-agents. Never trust the inline
  `toolUseResult.usage` when a `subagents/*.jsonl` transcript exists** — it reflects a
  single settle, not every turn, and undercounts a multi-turn sub-agent ~5–25×. Cost
  the background transcript per-turn (`transcript-reader.js`); the inline usage is a
  last-resort lower bound only. `scripts/cost-report.mjs` deliberately duplicates this
  so the report and live board agree.
- **A turn's real API calls live in `message.usage.iterations[]`, not the top-level
  `usage` fields — the native advisor tool (`advisorModel` in `~/.claude/settings.json`)
  is invisible if you stop at top-level.** A turn that calls the advisor tool bundles
  an extra `"advisor_message"` iteration alongside its `"message"` one(s), sharing the
  parent's `session_id`/timestamp but carrying its **own `model`** and never using
  prompt caching (full price, every call — a disproportionate, easy-to-miss cost
  driver, ~19% of spend in one measured sample). **Top-level `input_tokens`/
  `output_tokens`/`cache_*` are NOT reliably the sum of the `"message"`-type
  iterations** — that held in the transcript that first motivated this fix, but a
  frozen-snapshot audit found 121 real turns (68 sessions, one month) where the
  top-level fields under-reported the ordinary `"message"` iterations too — in the
  worst case by 636k `cache_read` tokens on one turn alone — whenever an
  `"advisor_message"` iteration happened to be bundled into the same turn. So
  iterations[] must be walked for correctness even ignoring the advisor tool entirely;
  don't reason about this from the top-level fields at all once `iterations` exists.
  All three scanners walk `iterations[]` and price an advisor iteration at its own
  model, folding its tokens into the normal totals ("of which", not additive) while
  also breaking them out as `advisorUsd` — a session's `usd` already includes it,
  `advisorUsd` is the slice. **Not disjoint from `subAgentUsd`** — a sub-agent that
  itself consults the advisor counts in both; the CLI/dashboard say so, don't silently
  add the two together. **Bucketed under `` `${model} (advisor)` ``, never the bare
  model id** — even when the advisor happens to be the same model the parent turn
  used, its spend must stay a visibly separate row in the Model dimension
  (`usage-report.js` `byModelOf`, `cost-report.mjs` `byModel`), never silently merged
  into ordinary usage of that model. `pricing.js`'s substring match still resolves the
  suffixed key to the right rate, so this costs nothing extra. `usage-report.js`'s
  per-file cache additionally gates its live-file cache hit on
  `cached.result.advisor` existing, so a file cached before this field existed forces
  one rescan instead of serving a total that silently excludes advisor spend forever
  — but that check is presence-only, not shape-aware: it cannot detect a LATER change
  to how `.daily`'s keys are formed (like the model-key split above). Any future
  reshape of what lives under `.daily`/`.advisor` needs its own gate, or an
  already-migrated cache entry will pass this check and serve stale-shaped data until
  its file next changes.
- **A fork's transcript REPLAYS the parent's whole history — bound every cost scan by
  `usageSince(entry)`.** `--fork-session` copies every parent line into the fork's own
  jsonl (same uuids, `message.id`s and timestamps; only the per-line `sessionId` is
  rewritten), so **there is no on-disk marker for a copied line** and costing from byte
  0 bills the parent twice (was ~14% of all spend). The cut is the fork's `createdAt` —
  every copied line predates it. Dedup does NOT save you: per-`message.id` is per-file
  and a fork IS a new file. **Three scanners must agree** — `transcript-reader.js`,
  `usage-report.js`, `scripts/cost-report.mjs`. Bounds *spend only*: summary/
  lastActivity stay inherited (the `[FORK]` label leans on them). Background
  sub-agents are never copied (their dir is keyed on the fork's own id) so the bound
  must not touch them; the inline `Agent`/`Task` pairs *are* copied, so it must.
  Plain `--resume` grows the file in place — only a deliberate fork replays. Codex is
  exempt: its rollout has only a *cumulative* total, so a time bound can't work.
- **The usage cache IS the long-term spend record — Claude Code deletes transcripts
  past ~30 days (`cleanupPeriodDays`).** So `usage-scan-cache.json` outlives its
  sources: `resolveClaudeTranscript` (`usage-report.js`) falls back to the *computed*
  transcript path — no directory listing — **solely to keep the cache key stable** once
  the file is gone, so the entry survives `scanAllDaily`'s eviction loop (a key not in
  `seenClaudeFiles` is deleted, which is how a whole month of real spend was lost).
  **Don't reduce it back to listing-only, and keep the fallback LAST** (ahead of the
  single-file-in-bucket heuristic it would displace a live file and evict *its* entry).
  The fallback is deliberately gated on already holding a cache entry — nothing cached
  means nothing to recover, and a phantom path would just inflate `failedFiles`. An
  unref'd ~daily `scanAllDaily` sweep in `main()` (with a first run minutes after
  startup, since restarts reset the interval) is what guarantees a session gets cached
  inside the window even if the panel is never opened. `scripts/cost-report.mjs` has no
  cache, so it still can't see deleted history.
- **Because it's the record, the cache's resolution is a one-way door: raw tokens per
  model, per UTC *hour*.** Never pre-cost to `$` (rates change; history must stay
  re-priceable) and never coarsen to days — both throw away detail that no longer exists
  anywhere else. `dayOfKey` collapses hour→day at read time, so `rollup` is unaffected.
  **A cache-version bump must keep READING old versions** (`READABLE_CACHE_VERSIONS`), not
  just mismatch-and-discard: for a deleted transcript, discarding the blob *is* deleting
  the spend record. v2's bare day keys survive precisely because `dayOfKey` treats them
  as their own day.
- **One instance per `DATA_DIR` — enforced.** Two servers sharing a `DATA_DIR`
  clobber each other's `mappings.json`/`tasks.json` (whole-snapshot writes). **A
  different `PORT` does NOT isolate — only `AW_DATA_DIR` does.** `main()` takes a
  per-dir lock (`server/instance-lock.js`); a duplicate refuses to start.
- **Stripped launch env.** Every launch is prefixed with `env -u CLAUDECODE` *and
  every inherited `CLAUDE_CODE_*`* (`withCleanClaudeEnv`), or a wrangler started from
  inside a Claude session makes its spawned sessions look nested and **silently drops
  their transcripts → unresumable.**
- **`node-pty` is pinned EXACTLY to `1.2.0-beta.14` — do NOT "upgrade" to `1.1.0`
  stable.** 1.1.0 leaks ~3 fds per `tmux attach` teardown on macOS; the beta (PR #931)
  is the fix and is node-pty's de-facto release channel.
- **The memory watcher MUST stay scoped to `tasks/*/memory.md`** (`watchIgnored`).
  chokidar 4 opens one fd per watched file; widening the watch leaked fds unboundedly
  until **`posix_spawnp failed` on every terminal attach** (only a restart clears it).
  Don't widen the watch without widening the filter.
- **The fd-leak canary is `server/fd-watchdog.js`, not a low `ulimit`.** Don't re-add
  a low `ulimit` as a canary: Node self-raises its soft limit to the hard limit at
  startup, so a low ceiling is really a whole-tree hard cap and **kills innocent child
  MCP servers** that need a brief fd burst (`chrome-devtools-mcp` opens ~270 at start).
  The `ulimit -n ${AW_MAX_FILES:-16384}` is just a blast-radius backstop.
- **CSRF/origin gate — the request-acceptance control (distinct from MCP's *advisory*
  identity).** Every browser-reachable surface routes through `server/origin-check.js`:
  the WS upgrade + `POST /mcp` must pass `isAllowedOrigin`, and the sensitive GET
  `/file` must pass `isAllowedHost` (a *separate* DNS-rebinding defense). **A new
  browser-reachable endpoint must be wired into this gate** or it's an open RCE/exfil
  surface. Deliberate asymmetry: **absent `Origin` is ALLOWED** (non-browser callers
  send none; a browser always sends it) but **absent `Host` is REJECTED**. Caller
  *identity* (the MCP `X-AW-Session` header / Codex Bearer token, `extractCaller`) is
  **advisory only, not auth** — this gate, not the identity, is what accepts a request.
- **A new MCP tool is invisible to launched agents until it's in TWO places.**
  `server/mcp/tools/index.js`'s `TOOLS` registers it on the server; separately,
  `server/mcp/client-config.js`'s `ALLOWED_TOOLS` is what a launched session's
  `--allowedTools` grants without a per-call permission prompt (a non-interactive
  agent that never gets a prompt answered effectively can't use a tool missing from
  it). Registering without allow-listing ships a tool that works in tests and dies
  silently in a real launch. `read_mail`/`list_mail` are the current example
  (`client-config.test.js` asserts the pair) — and because `--allowedTools` is
  baked into a session's launch argv, a session already running when this
  shipped has neither until it's resumed/relaunched: `entry.mailCapable`
  (stamped at dispatch/resume/fork, `session-manager.js`) tracks which
  recipients can be routed through the mailbox at all; an unstamped one falls
  back to `send_message`'s old direct-push behavior.
- **A child's "Full view" setting (`entry.childFullView`) is a CREATION-time
  stamp, not a live read of `childFullViewByDefault` — and it must be stamped
  at every site that sets `parentSession` on a session for the first time.**
  Today that's `attachSession` and `dispatch`'s entry construction
  (`session-manager.js`) — both read `childFullViewByDefault()` once and write
  the boolean onto `entry.childFullView`, but ONLY when it's still `undefined`
  (a session re-attached after detach, or moved to a different parent, already
  carries a stamp and keeps it). A third path that starts setting
  `parentSession` without adding the same stamp would silently produce a
  permanently-compact child no later default flip can reach — the client's
  `isChildFullView` (`public/app.js`) deliberately does NOT fall back to
  `childFullViewByDefault` per-render (an earlier draft did; a reviewing peer
  caught that it inverted the setting's own "new child sessions" label —
  flipping the setting would have changed every already-nested, untouched
  child instead of only future ones) — so an unstamped child reads as compact,
  full stop, not "whatever the setting is now."
- **The mailbox ("you've got mail", Phase 1) is a peer-only channel with its own
  two independently-keyed guards — do not unify them.** The settle window
  (`mailbox-store.js`) keys on the **recipient alone**, which is what makes
  fan-in from several senders batch into one notification; the loop-backstop
  rate limit (`mcp/message-throttle.js`) keys on the **unordered `{from,to}`
  pair**, which is what catches a reply loop. Collapsing them to one key breaks
  fan-in batching, the design's main win. **`server/control/handlers/message.js`
  (a human typing into a card) still pushes directly and is deliberately
  unchanged** — only the MCP `send_message` path (peer-to-peer) routes through
  the mailbox; the two paths are meant to diverge now, not stay unified.
  **`mailbox-delivery.js` reimplements, not imports, `message-delivery.js`'s
  dormant-resume guard** (`resolveResumeDir` by the live id, memory bind, then a
  synchronous commit block with no `await` between the fresh `archivedAt`
  re-check and `resume()`) — peer mail no longer flows through `deliverMessage`,
  so nothing carries that guarantee over for free. The store itself
  (`mailbox-store.js`) is a `schedule-store.js`-style object with **synchronous**
  mutators, not load-mutate-save via `atomic-json` — four independent writers
  touch one box (send, drain, the settle sweeper, eviction) and an `await`
  between a read and its write is where two of them would clobber each other.
- **Call it `mail`, never `unread` — the name is already taken.** `public/app.js`
  has an unrelated per-browser `unread` bookmark feature (`wrangler.unread`,
  "Mark unread") that owns `barWord()` and rewrites `cardState()` to the cyan
  `just-finished` alarm. The mailbox's `s.mail = {unread, notifiedAt, amber,
  senders}` (carried on `buildGraph`, keyed on card id) must never touch either
  — a card can legitimately be human-bookmarked *and* hold unread mail at once,
  and mixing the two concepts into one signal was the exact bug this naming
  rule prevents.
- **Three lists exist and none of them is the other: the task **TODO**
  (task-scoped, human-only, `task-store.js`), the per-session **checklist**
  (`checklist-store.js`, human AND agent), and the agent's own **native plan**
  (`TaskCreate`/`TaskUpdate`, or Codex `update_plan`) which the wrangler never
  reads, mirrors or reconciles.** "todo" and "task" were both already taken (the
  latter by Claude's own tool *and* the board's `t_...` ids), which is why this
  one is "checklist" everywhere — and never the bare field name `checks`, which
  `pr-status.js`/`notifier.js` already own for PR check-run status. Surfacing the
  native plan instead was investigated and rejected: it's undocumented internal
  shape that already renamed once (`TodoWrite`→`TaskCreate`, which broke a stale
  reference in `archive-review-runner.js`), and the two lists serve different
  audiences on purpose.
- **The per-session checklist is keyed on the card id and its four MCP tools take
  NO `session` parameter — that omission is the access control.** Store is
  `checklist-store.js` (`checklists.json`), the same synchronous-mutator mould as
  `mailbox-store.js` and for the same reason: the human (control WS
  `checklist-add`/`-update`/`-remove`/`-reorder`, `control/handlers/checklist.js`)
  and the agent (MCP) both write from this one process, and an `await` between a
  read and its write is where one clobbers the other. `add_checklist_item`/
  `update_checklist_item`/`remove_checklist_item`/`list_checklist` resolve their
  target from `extractCaller` alone, so a session can only ever touch its own
  list — **adding a `session` argument would let a launched agent write into a
  sibling's checklist** off an id it hallucinated or read from `list_sessions`.
  They're granular per-item on purpose (no `set_checklist(items[])`): the human
  edits the same list live, and a whole-list replace would let a stale agent read
  silently wipe an edit made seconds earlier. Registered in BOTH places per the
  two-place rule, and the whole feature is flag-gated (`checklistEnabled`,
  default **true**) through **four** channels that must stay in step —
  `activeTools()` (registration), `allowedToolsArg({checklist})` (the launch
  grant, whose `CHECKLIST_TOOLS` name list lives in the `client-config.js` leaf so
  the registry imports from it and never the reverse), `agent-skills.js`'s
  `DISABLEABLE` map (the nudge + Codex catalog, same shape as `task-memory`), and
  `graph.checklistEnabled` (the panel). Lifecycle mirrors the mailbox exactly:
  resume keeps it, **archive keeps it** (set-aside, not end-of-life), a **fork
  starts EMPTY** (fresh card id, no copy — deliberate, don't add one), and only a
  purge (`control/handlers/remove.js`) calls `forget`. Item text is
  **agent-written**, so `public/checklist-dom.js` renders it via `textContent`
  only and the panel is patched in place rather than re-`innerHTML`'d — the ~4s
  graph poll would otherwise reset the list's scroll every tick, and
  `checklistDragActive`/`checklistEditing` (`app.js`) freeze the patch so a tick
  can't reorder rows mid-drag or eat a half-typed item. **Collapsed is the panel
  not rendered at all, and the collapsed form is a disclosure chip in `#panel`'s
  own meta row** — deliberately the sub-agents-zone idiom (`.checklist-pill`
  shares `.subagent-pill`'s two rules rather than forking a third pill style), so
  a collapsed checklist costs the terminal ZERO height. Per-session and persisted
  per browser in `wrangler.checklistOpen`, mirroring
  `panelSubagentShownOverrides` — but with **no server-side default to fall back
  to** (unlike `subagentsExpandedByDefault`): collapsed is the only default, and
  `parseChecklistOpen` fails towards collapsed for the same reason, since that's
  the direction that costs no height. The chip renders even for an EMPTY
  checklist (`checklistPillLabel`'s `0/0`, unlike `checklistCountLabel`'s `''`) —
  while collapsed it's the only thing telling a human the feature exists on this
  session. Caps (`MAX_ITEMS` 100,
  `MAX_TEXT_LENGTH` 500) are an addition the design spec didn't ask for: this is
  the first store an agent can grow with no human in the loop.
- **Diff-view text is untrusted.** The session diff view renders agent/repo-generated
  content (paths, hunk headers, line text) — it goes in via `textContent`/`dataset`,
  **never `innerHTML`** (`public/diff-dom.js`). Review drafts persist to localStorage
  keyed on the card id.
- **`tileSpan` (`public/layout.js`) takes THREE child counts and they must stay
  distinct** — `absorbedChildCount` (every folded-in session, structural) is what's
  subtracted to get the top-level active count; `childRowCount` (only rows currently
  *drawn*, as a compact `.worker-row`) feeds the lighter, CAPPED secondary weight;
  `childFullViewCount` (a child currently toggled "Full view" — per-session
  `entry.childFullView`, a creation-time stamp, never a live read of
  `childFullViewByDefault`, see the mailbox/child-full-view bullet elsewhere) is
  charged a FULL `CARD_STRIDE_PX` at `totalWeight` time (it renders a real
  `.session-card` via `cards.js` childRowHtml, not a `.worker-row`) but then moved
  to the UNCAPPED bucket alongside `topLevelActiveCount` — unlike every other
  secondary term, `Math.min(totalWeight - uncappedCount, perRow)` never clips it,
  because this function's own invariant ("a session rendered as its own card must
  stay fully visible") applies to it exactly as much as a real top-level card.
  Enough full-view children alone used to saturate the `perRow`-wide cap and clip
  a fully-drawn card into `.task-body` scroll before this was split out — verified
  against the live board (a task with 5 full-view children scrolled). Still
  excluded from `absorbedChildCount`/top-level itself (it never becomes its own
  top-level card). A full-view child can also show its OWN sub-agent zone (it
  renders via `sessionCardHtml` same as a top-level card) — `app.js
  childRowCounts`' `subagentRowCount`/`subagentZoneCount` loop must charge it too,
  not just non-absorbed sessions, or the tile comes out short and silently
  scrolls. Defaulting `absorbedChildCount` to `childRowCount` previously made
  collapsing a workflow box grow the tile instead of shrinking it. **TODO and
  checklist data are the two exceptions to "carried via `buildGraph`"** — both
  ride their store's `snapshot()` on the graph directly (`taskStore.snapshot()`,
  `checklistStore.snapshot()`), so don't go looking for either in `buildGraph`.
  TODO because it's task-scoped rather than session-scoped; the checklist
  *is* session-scoped but its only consumer is the ONE selected session's
  sidebar panel, so there's nothing to enrich per card.
- **A wrapped card's drag unit is the OUTERMOST element — the nested card/box must
  be non-draggable, and four places must agree.** `.workflow-box`/`.child-group`
  (`public/cards.js`) carry `data-sid` + `draggable="true"` and stand in for
  whatever they wrap; the card/box nested inside is rendered `draggable="false"`
  (`wf`/`nested` in `sessionCardHtml`/`workflowBoxHtml`) so it never starts its
  own drag one DOM level too deep. `public/app.js` must match this at all four
  sites: the drag-source wiring selector, `dragAfterElement`'s `:scope >` hit-test
  list, the drop handler's `body.children` order-reconstruction walk, and
  `.dragging-hidden` in `styles.css`. Miss any one and a wrapped parent silently
  drops out of the reordered array (ranks `Infinity` in `orderSessions`, sinks to
  the bottom on every unrelated drag in its task) or throws on drop (`insertBefore`
  needs the hit-tested element to be a direct child of `.task-body`) — this was a
  live bug (a parent-with-children could never be dragged, and any drag in its
  task permanently dropped it from `sessionOrder`), not a "sessions with children
  sink last" feature.
- **Every paste into a pane goes out BRACKETED (`paste-buffer -p`) — dropping the
  `-p` silently splits one multi-line message into several turns.** `pasteBlock`
  (`tmux-scraper.js`) is the single chokepoint for the composer, peer mail, PR nudges
  and the snooze prefill. The paste *buffer* alone is not the fix: without `-p`, tmux
  puts a literal CR on the pty for every newline, so the TUI submits at the first one
  and queues each later line as its own prompt — measured against a real Claude pane, a
  three-line prompt landed in the transcript as TWO user messages, and with `-p` the
  same text landed as one with its newlines intact. Safe unconditionally because tmux
  only emits the `ESC[200~`/`ESC[201~` wrapper when the pane's app has enabled bracketed
  paste, so `-p` is byte-identical to the old behaviour against anything that hasn't
  (verified against a plain `cat`) — no per-agent branch needed. `sendText`'s trailing
  Enter stays a submit rather than a swallowed newline because the end marker precedes
  it on the same byte stream. The TUI's `[Pasted text #N +k lines]` collapse is
  DISPLAY-ONLY — a 31-line paste reached the transcript in full.
- **tmux needs a UTF-8 locale** or it renders Unicode (`⏺`, box-drawing) as `_`.
  launchd doesn't inherit the login locale, so `scripts/wrangler-start.sh` pins
  `LANG`/`LC_CTYPE`. If terminals show `_`, check the server env (`ps eww`).
- **Mandatory skills need an always-on nudge — discovery isn't reliable.** Meta-skills
  (`server/agent-skills.js`) are resolved install-relative so they're cwd-independent.
  A skill that MUST run at session start (task-memory) opts into a sidecar `WRANGLER.md`
  whose text is force-injected (`--append-system-prompt` / Codex `developer_instructions`);
  a plain discoverable skill does not reliably self-invoke. Most skills should have none.
- **Archive-time memory review's excerpt is HUMAN TURNS ONLY — never assistant
  text or tool output — and this is a deliberate trade-off with a real, verified
  failure mode.** `buildExcerpt` (`archive-review-runner.js`) keeps only
  `type: 'user'` entries. Rationale: assistant/tool content is the overwhelming
  majority of transcript bytes and carries almost none of the durable signal
  (stated preferences, corrections, decisions) this feature exists to capture —
  a user's own correction already carries the pitfall it's correcting. **But
  verified against a real transcript: when a decision is reversed via the
  ASSISTANT's investigation (not restated by the user afterward — e.g. "I
  checked, PR #93 already rejected this, 14+ import sites, don't reopen"), the
  human-turns-only excerpt has no way to see the reversal and reports the
  superseded original instruction as current.** This is not a bug to fix by
  widening the excerpt back to full-transcript (that reintroduces the diluted,
  narrative-heavy input the design deliberately avoids) — it's an accepted,
  documented accuracy risk, same category as "nothing removes a wrong bullet
  once written." Two independent real-transcript samples otherwise validated
  cleanly: specific, checkable facts (file paths, config keys, line numbers)
  that were genuinely present in the user's own words, not hallucinated.
- **Archive-time memory review (`server/archive-review-runner.js`) is opt-in
  (`archiveReviewEnabled`, default false) and MUST use `entry.liveSessionId`, never
  the card id — the card id is never a conversation id.** Hooked via a
  `this._archiveReview` seam on `SessionManager` (mirrors `_ensureCodexTrust`), a
  no-op by default so every existing archive test stays inert. Fired unawaited
  from the end of `archive()`, and only when the session wasn't ALREADY archived
  (`archive()` is "set aside", not end-of-life — `resume` clears `archivedAt`, so
  a naive hook would re-review the same growing transcript on every
  archive→resume→archive cycle). The excerpt sent to Haiku is bounded by
  `max(usageSince(entry), entry.archiveReviewedAt)`: the `usageSince` half matters
  independently of the not-again guard, because a **fork's transcript replays the
  parent's entire history with no on-disk marker** (same invariant as the cost
  scanners below) — without it, archiving a fork would write the parent's work
  into memory.md a second time.
- **The reviewer subprocess uses `--session-id <fresh uuid>`, never
  `--no-session-persistence`.** The uuid is pushed onto the archived card's
  `entry.priorLiveSessionIds`, so the review's own spend is picked up by the
  existing cost scanners (`usage-report.js`, `cost-report.mjs`) for free — that
  field is deliberately excluded from `cardForLive`, so nothing will ever try to
  resume it. `--bare` looked like the way to cut the CLI's ~16k-token system
  prompt but is **unusable**: verified against the real binary, it fails with
  `api_error` because it reads only `ANTHROPIC_API_KEY`, never OAuth/keychain.
- **Haiku sometimes ignores the "output NONE if nothing durable" instruction and
  emits confused prose instead — verified live, and only on a THIN excerpt.**
  A short (~200-char) transcript reliably (5/5 in testing) made Haiku respond
  "I don't see a transcript excerpt in your message..." rather than `NONE`,
  while a realistic (45KB) excerpt reliably produced correct bullets. The fix is
  output-side, not prompt-side: `looksLikeBullets()` requires the response's
  FIRST non-blank line to start with `-`/`*` — anything else (including the
  literal string `NONE`) is treated as "nothing to write" and never appended.
  **Never relax this to "contains a bullet somewhere" or remove it on the
  assumption the prompt alone is reliable enough** — it isn't, and this is the
  only thing standing between a bad model response and confused prose landing
  permanently in a human-and-agent-shared memory file.
- **`server/test-setup.js` redirects `AW_DATA_DIR` (not just `CODEX_HOME`) to a
  per-process temp dir.** Added alongside the archive-review feature: before this,
  `config-store.test.js` had to snapshot-and-restore the real
  `~/.agent-wrangler/config.json` for lack of any alternative (there is no path
  injection in `config-store.js`/`memory-store.js`) — and once `archiveReviewEnabled`
  is a real flag, a live install with it turned on would have made `npm test`
  spawn real billed `claude -p` subprocesses and append to real task memory. Same
  class of incident `CODEX_HOME`'s redirect exists for, with a bill attached. Runs
  before any `data-dir.js` import (via `node --test --import`), so the module's
  `DATA_DIR` const picks it up for the whole test run.
- **The chat view's read path must not apply the fork bound and must not price anything.**
  A fork replaying parent history is correct for *reading*; `usageSince` bounds spend only.
  Three cost scanners already have to agree on `iterations[]`/advisor/fork rules — the chat
  path deliberately shows model only so it never becomes a fourth (no tokens are produced or
  rendered anywhere on this path). `subagent.usd`
  is forwarded from `transcript-reader.js`, not recomputed (`server/chat-events.js`).
- **A Claude transcript is a TREE, not a log, and the abandoned branches are
  unmarked — so the chat view has to prune, and the pruning rule is NOT "the
  newest line and its ancestors".** Rewind ("backtrack", Esc-Esc) does not
  truncate the file: the new turn is appended with its `parentUuid` pointing back
  at the rewind target and the old turns stay put, line-for-line indistinguishable
  from live ones. Measured over 274 real transcripts, **160 (58%) carry at least
  one abandoned line**, and one recurring session showed 325 of 345 message lines
  dead — a flat scan rendered all of them, which is what "the chat view shows old
  versions of the conversation" was. **The obvious spine walk is wrong**: ordinary
  **parallel tool use branches the tree too** — a second `tool_use` line and the
  first call's `tool_result` are both written as children of the first `tool_use`
  — so ancestors-of-the-newest-line silently drops live tool results, in 153 of
  those 274 files. What actually marks a rewind is a branch point with **more than
  one child whose subtree contains a human prompt** (two alternative histories); a
  fan-out never has that, since one side is a bare tool result. At such a point
  every prompt-bearing child but the **last** dies with its whole subtree
  (`selectLive`, `server/chat-events.js`) — 1.7% of message lines across the
  corpus, never a line the spine would have kept. Three details are load-bearing:
  chain tracking must see **every** line, not just the ones `mightCarryChat` lets
  through (an `attachment` between a user turn and its reply is part of the parent
  chain, and a hole there orphans both sides), which is why the uuid pair is
  pulled off the raw line by `indexOf` and never `JSON.parse` — the lines it runs
  on include multi-megabyte tool results; `parentUuid: null` lines are grouped
  under one synthetic `ROOT` and compete like any siblings, because rewinding to
  before the very first prompt starts a whole **second root** (one scheduled
  session had eight); and a **`compact_boundary` root is exempt** — `/compact`
  also opens a new root but *continues* the conversation, and letting it compete
  hid **2104 pre-compact messages** of a real session. Past
  `MAX_TRACKED_LINES` the scanner stops tracking and prunes nothing: showing a
  dead branch is cosmetic, hiding a live turn is not.
- **A rewind is delivered to the client as a moved `epoch`, because the stream is
  append-only and cannot retract what it drew.** `selectLive` only works on a read
  that covers its range from the start, so the initial read prunes and a follow-up
  poll cannot — it holds only the newly appended lines. Instead the scanner reports
  `takeRewound()` (a new line's prompt hanging off an ancestor that already had a
  prompt-bearing child) and `chat.js` bumps a per-conversation `epoch`; the client
  mirrors it and, when it moves, **clears the stream, resets `offset` and re-reads
  the window** (`rebuildStream`, `public/chat-view.js`). Three things are subtle:
  `takeRewound()` is **read-and-clear and consumed on every read** — an initial
  read walks the historic branch points too, so a flag left set would rebuild a
  correctly-built stream every 2s forever; the rebuild **must bump `generation`**,
  since `offset` is back to `null` and the token gate is then the only thing
  stopping an already-in-flight reply from re-appending the branch that just died;
  and in-flight round trips are stamped with a **separate `requestEra`**, bumped only
  on mount/unmount, so a rebuild does not silently orphan an upload the reader just
  started. That counter is shared by every client→server round trip (an image upload
  and the interrupt's restore today) and is named for the round trip rather than for
  pastes for exactly that reason: anything added later must stamp itself with it and
  not with `generation`. The epoch counter lives **outside** the scanner cache because the
  rebuild's fresh read replaces the scanner. Codex is exempt throughout: a rollout
  is a flat list with no parent links and no rewind representation.
- **Codex `function_call` pairs on `call_id`, never `id`.** Both exist (`fc_…` and
  `call_id: call_…`); the output carries only `call_id`. Pairing on `id` does not throw —
  it silently renders a timeline with no tool outputs. Codex `reasoning` is `encrypted_content`
  with `summary: []`, so Codex thinking is a presence marker and can never have text.
- **`mightCarryChat`'s Claude gate is role-based, so any non-`message` line needs
  its own marker added or it is silently invisible.** The gate is a cheap substring
  test run before `JSON.parse`, and for Claude it looks for `"role":"user"` /
  `"role":"assistant"`. Claude Code's end-of-turn recap is a `type:'system'`,
  `subtype:'away_summary'` line with a bare `content` string and **no `message`
  object at all**, so it matches neither — `"away_summary"` had to go in the gate
  *and* be handled before `pushClaude`'s `entry.message` guard, which would
  otherwise drop it. Both halves are needed; adding either alone silently emits
  nothing. Same shape applies to the other system subtypes on disk
  (`turn_duration`, `stop_hook_summary`) if they are ever surfaced. The recap's
  stored `content` has no `※ recap:` prefix (the TUI adds that) but does carry a
  trailing `(disable recaps in /config)` — stripped by `recapOf`, because it tells
  the reader to type a slash command and slash commands stay in the pane by design.
  `recapOf` splits the "Next:" / "Next action:" sentence on the **last** marker:
  the summary half is free prose that can contain the word itself.
- **`server/chat-events.js` is a leaf and must stay one.** It deliberately duplicates
  `search/extract.js`'s *shape* while keeping the tool calls that module drops — opposite
  goals, do not merge them.
- **The chat view's whole type scale is `em`-relative to `#chat-wrap`'s own
  `font-size`, which is `var(--chat-font-size)`.** That one variable (set on
  `<html>` by `applyChatFontSize`, `public/app.js`, from the `cm-chat-fontsize`
  localStorage key via the `chat-font.js` leaf) is what the "Chat font size"
  setting moves, and it only works because *every* size in the pane — prose,
  chips, tool rows, the composer, the buttons — is a fraction of it. **A new
  chat rule that sets `font-size` in px silently opts that element out of the
  setting**, which is how the pane previously ended up with big prose beside
  unchanged 11px machinery. Two deliberate exceptions: `.chat-seg-btn` (the
  Chat/Terminal toggle lives in the panel header, outside the pane) and the
  `14px` fallback on `#chat-wrap` itself (the variable is JS-set, so the pane
  must still render if that never runs). Separate from the terminal's size on
  purpose — `term-font.js` and `chat-font.js` are sibling leaves with different
  presets and defaults, and `chat-font.test.js` asserts they have not converged.
- **Every `ctx.reply` in `server/control/handlers/chat.js` MUST echo `token`.** The chat view
  correlates each poll reply to the mount that requested it by an opaque token it sends and
  the handler echoes back (`token: msg.token ?? null`); the client drops any reply whose
  token does not match its current generation. There are five reply paths (missing transcript,
  failed stat, failed open, no-complete-line, success) and **a new reply path that omits the
  token makes the chat view silently stop updating for that session, forever** — the client
  cannot distinguish "token absent" from "stale era", and there is no retry. Nothing catches
  this automatically: no lint rule, and the replies are separate object literals rather than
  going through a shared builder. `chat.test.js` pins two of the five paths; a new path needs
  its own assertion. The token exists because `server/index.js`'s control-socket handler invokes
  `routeControlMessage` **without awaiting**, so concurrent requests interleave and the
  handler's async reads can complete out of order. An earlier attempt correlated replies with
  a FIFO queue and was provably inverted by that (it dropped the valid reply and applied the
  stale one) — so do not "simplify" the token back to positional correlation.
  The same all-paths rule now applies to **`lastTs`** (the newest transcript
  timestamp the scanner has consumed, `createChatScanner().lastTs()`): it is the
  chat view's elapsed clock for its live "working" row, so a reply path that
  omits it freezes that clock. It is deliberately server-sourced rather than
  measured from when the view mounted — mount-relative timing reports "3s" for a
  session that has already been grinding for five minutes. It reads `prevTs`,
  which `pushClaude` advances for **every** user and assistant entry, including
  an assistant message that is nothing but a `tool_use` and therefore emits no
  event at all: exactly the case the indicator exists to cover.
  It applies to **`suggestion`/`modelNow`** for the same reason, and to
  **`epoch`** (above) most sharply of all: an omitted `epoch` reads to the client
  as `0`, and against a conversation whose counter has already moved that
  rebuilds the whole stream on **every single poll**.
- **The needs-you handoff is a ROUND TRIP, and the return is inferred, not
  signalled.** `Terminal →` on the chat view's needs-you bar arms
  `chatHandoffFor` (a card id, `public/app.js`) and switches to the pane;
  `applyGraph` switches back once `shouldReturnToChat` (`public/chat-handoff.js`,
  four guards, unit-tested) says the session has left `needs-you` — nothing on
  the wire says "the prompt was answered", and leaving `needs-you` is what that
  looks like from outside the pane. Three things are load-bearing:
  **the disarm in the `.chat-seg-btn` handler must come BEFORE its no-op early
  return** (pressing `Terminal` while already in the handoff's terminal is
  exactly how someone says "I want to stay here", and that press changes no
  view, so a disarm placed after the return would ignore the one gesture that
  most needs honouring); **the check must run BEFORE `renderPanel`** in
  `applyGraph`, or the toggle renders a tick behind the pane it labels *and*
  the `openTerminal` branch below it still sees `terminal` and re-attaches into
  the hidden pane (the 80-column bug that branch's comment describes); and the
  armed id is **deliberately in-memory, never persisted** beside the view choice
  — it describes a trip in progress, so surviving a reload would drop someone
  into an automatic switch they cannot connect to anything they did.
- **The suggested next prompt is the ONE deliberate exception to "the chat view
  is transcript-sourced" — and it is scraped, because it exists nowhere else.**
  Verified against a live session while the suggestion was on screen: absent from
  the session jsonl (it lands only after acceptance, as an ordinary user message
  indistinguishable from typing), `atis-latch`'s `atis` field empty in all 181
  occurrences across 150 transcripts, no file written under `~/.claude` when it
  appears, and `history.jsonl` holds only submitted prompts. The rendered pane is
  its only external representation. So `parseGhostSuggestion`
  (`server/ghost-suggestion.js`, a leaf) reads it off `capturePaneStyled` —
  **`capture-pane -e`, which is why that is a SEPARATE helper from
  `capturePane`**: every existing caller feeds plain text to `stripAnsi`/
  `classify`, and the escapes are the entire basis of this parser, since the
  faint attribute (SGR 2) is the only thing distinguishing ghost text from what
  the human is typing. Governing rule is **hide on any doubt** — a missed
  suggestion is just the old behaviour, a wrong one echoes someone's own
  half-written draft back as the agent's idea — so it bails on typed text before
  the run, an unterminated run (a wrapped suggestion, where reporting line one
  would load a TRUNCATED prompt), trailing text, over-long text, and escape-
  stripped input. Read in the chat handler rather than `buildGraph`: one tmux
  exec for the one session being viewed instead of every card, at the 2s poll
  rather than the ~4s graph, and a dormant card has no pane anyway. **Claude
  only** — Codex's composer is a different TUI and guessing at it is exactly the
  failure this is built to avoid. Carried on every reply under the same all-paths
  rule as `token`/`lastTs`.
- **`/model <name>` is the ONE slash command the chat view is allowed to send,
  and `entry.model` must NOT be updated when it does.** The "slash commands stay
  in the pane" rule exists because a slash command's output is a TUI dialog this
  view cannot render (`/clear`, `/compact`, `/config`, …). `/model <name>` is the
  exception that proves it: it takes its argument inline and applies silently,
  with no dialog to miss. Its accepted alias list is
  `["sonnet","opus","haiku","fable","best","sonnet[1m]","opus[1m]","fable[1m]",
  "opusplan"]`, a superset of every value the Claude adapter offers, so
  `set-session-model.js` validates against the adapter's own list and no second
  model vocabulary exists. **`entry.model` stays the LAUNCH model** — it is what
  a resume re-launches with, so writing it would change what a later resume does
  on the strength of a runtime toggle.
  **`/model` is NOT session-scoped, despite a string in the binary saying it is
  — it writes `"model"` into `~/.claude/settings.json`.** Measured, not read:
  the file gained `"model": "sonnet"` the moment the handler sent
  `/model sonnet`. So a switch here changes the default for **every new Claude
  session on the machine**, wrangler-launched or not. That is `/model`'s own
  behaviour and matches what the feature was asked for, but it is surprising
  enough that the menu says so in a header rather than leaving it to be
  discovered. Don't restore the old value afterwards — that fights the tool and
  races the user's own settings edits.
  **A `/model` switch is invisible to the transcript**, so `modelPill` (built
  from the last assistant `message.model`) keeps naming the OLD model until the
  next turn runs — it is right for a dormant card and wrong for exactly the
  moment after a switch. The live source is the pane's status bar via
  `paneModelLabel` (`tmux-scraper.js`), carried on the chat reply as `modelNow`
  and preferred over the pill by the chip. Its label is SHORT ("Sonnet 5") and
  does not distinguish the 200K/1M variants, which is why `currentModelValue`
  (`public/model-menu.js`) decides the menu's tick over the whole set and ticks
  nothing when two rows are indistinguishable — a wrong tick is worse than none.
  **Slash-command plumbing must stay out of the stream:** the invocation
  (`<command-name>…`) and its output (`<local-command-stdout>`) arrive as
  ordinary user messages with no `isMeta`, so they are filtered by name in
  `chat-events.js`'s `SYNTHETIC_PREFIXES` — without that they render as raw tag
  soup in a user bubble. Three refusals are load-bearing and mirrored client-side by
  `canSwitchModel` (`public/app.js`) so the menu is only offered where it would
  be honoured: **Claude only** (Codex's model is a launch choice and its TUI is a
  different program), **idle only** (composer input during a turn is queued as
  the next PROMPT, so the session would answer "/model sonnet" as a question),
  and **pane composer confirmed empty** via `paneComposerIsEmpty`
  (`ghost-suggestion.js`) — the paste lands at the cursor, so a draft already
  there fuses with the command into one mangled prompt that the Enter submits.
  That guard is fail-safe: it returns false whenever emptiness cannot be
  confirmed.
- **An image pasted into the chat composer reaches the agent as a FILE PATH, and
  that path must arrive as its own isolated paste — measured, and the rule is
  narrow.** Claude Code's own Cmd+V reads the HOST clipboard, which a browser
  cannot reach, so a file is the only bridge. The TUI rewrites a pasted image path
  into a real inline `[Image #N]` attachment (a genuine base64 `image` block in the
  transcript, no Read tool call, no permission prompt) **only when the pasted text
  is a SINGLE LINE ending with the path.** Verified against a live pane: `<path>`,
  `<path> `, `<path>\n` and `prose: <path>` all attach; `prose\n<path>` (multi-line,
  path last), `<path> more words` and `a\nb\n<path>` all stay literal text the model
  never sees. So `deliverMessage` pastes each path ALONE via `prefillPane` (no Enter)
  and only then `sendText`s the prose — the split IS the mechanism, and concatenating
  a path into `text` silently breaks every multi-line prompt.
  **Destination is `<memoryDir>/pastes/`, and that is what makes this need no launch
  change**: every Claude launch already passes `--add-dir addDirFor(sessionId)`, so a
  file underneath it is readable by an ALREADY-RUNNING session (unlike
  `entry.mailCapable`, which had to wait for a relaunch). `paste-store.js` owns the
  two path forms and they are not interchangeable — write and stat against the
  RESOLVED real dir (so nothing depends on the by-session link existing yet), but hand
  the agent the by-session **symlink** form for Claude, because that is literally the
  string `--add-dir` was given and the form verified live; Codex gets the real path
  since it rejects a symlinked writable root. Safe to create a subdir there because
  `watchIgnored` refuses anything that is not `tasks/<id>/memory.md` — widening that
  filter to see pastes would reintroduce the chokidar fd leak.
  **The composer sends back the server-minted NAME, never a path** (`isPasteFileName`
  + an existence check inside that session's own pastes dir), so a frame can never
  point the agent at an arbitrary file; a name that fails either check is dropped
  rather than failing the send. And the chat view's chip label is taken from the
  `[Image #N]` marker in the prose, **not** counted up from one: the TUI numbers
  attachments cumulatively per session, so a message's second-ever image is
  `[Image #10]` and a "Image #2" chip would contradict the text beside it. Deliberately
  no thumbnail — `GET /file` is markdown-only by design and widening it to serve
  arbitrary image paths would open a read surface for one decoration.
- **The chat composer is ONE textarea shared by every session, so mount/unmount must
  swap its VALUE — resetting the state variables around it is not enough.** This was a
  live cross-session leak, not a theoretical one: a prompt entered against one session
  was still in the box, with Send enabled, after opening a sibling session, so it could
  be delivered to the wrong agent. It also produced a confusing Esc symptom, because
  `interruptAndRestore` deliberately declines to overwrite a non-empty box — the
  carried-over draft masked the prompt the reader was trying to recover, which looked
  like "Esc restored the wrong session's prompt". Fixed with a per-card-id `drafts` Map
  (`public/chat-view.js`): `saveDraft(leaving)` then `loadDraft(id)`, **in that order**,
  or the incoming draft gets filed under the outgoing id. Per-session rather than simply
  cleared so switching away does not discard work in progress, and **in memory only, not
  localStorage** — an unsent prompt is a thing of the moment, and surviving a reload
  would put words in the composer the reader has forgotten writing (this is the opposite
  choice from the diff view's review drafts, which DO persist, because those are notes
  about a fixed artefact rather than a half-sent instruction). Attachments are stored
  and restored WITH the text: a pasted image's filename only means anything inside the
  session whose `pastes/` folder holds it, so it must follow its own prose and never
  cross to another card. Anything else added to the composer (a second field, a mode
  toggle) has to join the same save/load pair or it leaks the same way.
- **The Esc-restore is resolved SERVER-SIDE, from the pane when it can be read and
  a fresh transcript read otherwise — and the pane's own restore is unreliable, which
  is the fact the whole design turns on.** Interrupting a turn *sometimes* makes
  Claude Code restore the interrupted prompt into its own composer. Measured against a
  live pane (2.1.247), composer wiped between runs: a 64-character prompt never
  restored, a 212-character single-line one restored on one run and NOT on two later
  runs of the identical prompt, and NO multi-line prompt ever restored (5 and 13 lines
  tested). So absence is the common case and must never be read as "nothing was
  pending". Two consequences, both load-bearing:
  **`paneComposerDraft` (`ghost-suggestion.js`) hides on any doubt.** It locates the
  composer between the last two `─` rules (continuation lines carry no `❯`, so the
  mark alone cannot delimit them), takes the rule's own length as the wrap width — no
  extra tmux call — strips faint runs, and rejoins wrapped lines with ONE space, which
  is byte-exact when the wrap fell on a space (verified against a 212-character
  prompt). It returns null on a line that reaches the full pane width, because a token
  wider than the pane is hard-broken mid-word (verified: a 130-character path split as
  `…segment-s` / `gment-…`) and rejoining that silently corrupts it; also null on a
  `[Pasted text #N]` placeholder, on escape-stripped input, and over a length cap.
  **The transcript fallback WIDENS its read by result, never a flat byte tail.**
  `scanChatText` applies `selectLive`, so the read has to cover its range from a line
  boundary, and transcript bytes are mostly tool output rather than turns — a fixed
  window is no guarantee of holding a single prompt, and too small a window can prune
  away every prompt it does hold. Measured over 31 real transcripts larger than the
  first 256KB attempt, a flat 512KB tail returned NULL on one where widening found the
  prompt correctly; after the fix, zero of the 31 differ from a whole-file read. An
  empty or prompt-less window is therefore a reason to widen, NOT to give up — only
  reaching byte 0 or the 8MB ceiling ends the search — and a window that does not start
  at byte 0 must drop its partial first line, because `lineUuids` reads the parent/child
  pair straight off the raw line and a truncated one feeds a bogus link to `selectLive`.
  **The transcript is the fallback and is read FRESH in the handler** — the old client
  held `lastUserText`, updated only when a 2s poll happened to deliver a `user` event,
  which is why Esc handed back the PREVIOUS prompt when it beat the poll. `lastUserText`
  is now gone from `chat-view.js`; the client sends an era-stamped token on `interrupt`
  and loads whatever `interrupt-restore` echoes back, deciding "was a draft already
  there?" at KEY-PRESS time rather than when the reply lands.
  **`[Request interrupted by user]` is written by Claude Code as an ordinary `user`
  message with no `isMeta`, so it is the newest user entry at exactly the moment the
  restore is resolved.** Caught end-to-end, not reasoned about: the first version
  returned that 29-character marker instead of the real 212-character prompt.
  `restore-prompt.js` filters it and `[Request interrupted by user for tool use]`,
  anchored so a prompt quoting one still restores; across 150 real transcripts those
  are the only two forms. **Codex gets the interrupt but never a restore**, and that is
  a pre-existing gap rather than a new one: this handler resolves the transcript the way
  `chat.js` does, via `findTranscript` over `~/.claude/projects`, while Codex rollouts
  live under `~/.codex/sessions` behind `codex-rollout.js`'s `findRollout`. Codex
  degrades to no restore, never to a wrong one.
- **The chat view cannot stream a partial turn, and no indicator should imply it
  does.** Claude Code writes whole messages to the transcript — there is no
  partial or delta line to tail — so between the start of a turn and the message
  landing there is genuinely nothing to render. The live row (`.chat-live`, last
  child of the stream, `chat-view.js`) is the honest substitute: presence gated
  on the session's real status, decorated with the pending tool name when there
  is one, plus the elapsed clock above. Don't replace it with something that
  looks like text arriving.
- **What counts as a `.md` path has exactly ONE definition, and the chat view
  linkifies it through TWO code paths that must keep agreeing.**
  `markdownPathRegex`/`resolveTerminalPath` (`public/term-links.js`) is the
  matcher the terminal's xterm link provider has always used; `public/text-links.js`
  wraps it for the chat view and is the only new vocabulary — don't fork a second
  regex, or the same string linkifies in one view and not the other (the exact
  complaint the feature was raised for). The two paths are unavoidable because the
  two halves of the stream are different kinds of content: the **user bubble is
  plain text** (`chat-dom.js` `fillLinked` turns segments into text nodes and
  controls — still never innerHTML, so the module's rule stands), while
  **assistant prose is markdown** and goes through markdown-it renderer rules
  (`markdown-preview.js`). A change to what linkifies must land in both.
- **A markdown-file link is a href-LESS `<a role="button" tabindex="0"
  data-md-path>` — not a `<button>`, and never an `href`.** Nothing about "open
  the preview modal" is a URL, and the app hash-routes (`#session=`, `#view=`),
  so an `href="#"` that ever escaped its `preventDefault` would navigate the
  board. A real `<button>` was tried and **measured wrong**: Chrome coerces
  `display: inline` on one straight back to `inline-block` (verified live —
  `!important`, inline style and a `<span>` control all confirmed it is coercion,
  not a cascade miss), so a long path wrapping INSIDE the control pushes the text
  after it onto a fresh line. `role`/`tabindex` are what a bare href-less anchor
  lacks, and `chat-view.js` must wire **keydown as well as click** — with no href
  nothing activates it from the keyboard otherwise. Both go on ONE delegated
  `[data-md-path]` listener pair on `#chat-stream`, because the controls inside
  assistant prose are built by a renderer rule and never pass through
  `appendItems`, so per-node wiring cannot reach them.
- **`createRenderer`'s markdown-path rules are opt-in via `mdPathBase`, and three
  of their exclusions are deliberate.** No `mdPathBase` (the memory preview pane)
  installs no `text`/`code_inline` overrides at all, so that pane renders exactly
  as before. With it: **fenced blocks are NOT linkified** (content to copy
  verbatim, and an inline control fights a drag-select) though **inline code IS**
  (backticks are how an agent normally writes a path, and the terminal linkifies
  them); **URLs are not re-matched in prose** (`urls:false`) because markdown-it's
  own `linkify:true` already made them anchors and a second pass nests a link in a
  link; and `insideLink` stops a path in a link's own LABEL becoming a `<button>`
  inside an `<a>`. In the user bubble, URLs ARE matched — the bubble is not
  markdown, so nothing else would do it. Scheme-less hosts
  (`example.com/x`) are deliberately not linkified: in a human's prompt that is at
  least as likely to be prose, and a wrong link is worse than a missing one.

## How subsystems hang together (pointers, not mechanics)

- **Worktree dispatch adopts as well as creates.** `classifyWorktreeTarget` (asks `git
  worktree list`, not `fs`) → `new` / `existing-branch` / `adopt` / refusals
  `branch-in-use`|`folder-blocked`. Precedence is load-bearing: **adopt before
  branch-in-use.** `entry.worktree.repoRoot` is load-bearing — it's how the branch is
  found after the dir is deleted; cleanup is *offered, never automatic*, and deleting
  the dir doesn't break resume (transcript lives under `~/.claude`).
- **Branch naming = a placeholder + an agent rename.** `slugFromIntent` is the
  deterministic dispatch-time name; an autopilot run renames via the `name_branch` MCP
  tool once it understands the issue. **Branch only — the dir is NOT moved** (the live
  shell sits in it), which is inert because modern entries store `repoRoot`.
- **Per-task memory follows the session, not the launch.** Canonical file
  `~/.agent-wrangler/memory/tasks/<taskId>/memory.md`; the agent reads a fixed
  `AW_TASK_MEMORY` per-session **symlink** the server repoints on every reassignment
  when running Claude (Claude re-resolves it per file access, so a running Claude
  session follows a mid-flight repoint). **Codex 0.149+ rejects symlinked writable
  roots**, so Codex receives the resolved real task/scratch directory at each
  dispatch/resume/fork; a running Codex session therefore picks up a reassignment
  only on its next relaunch. Keep those three launch paths in sync. `memory-store`
  rejects non-segment ids (path-traversal guard).
- **Suspend reclaims RAM by reusing the dormant state.** Idle ≥ `suspendIdleHours`
  (default 8, on) tears down tmux but keeps the entry (one-click resumable); never
  touches working/needs-you/attached. `config.json suspendEnabled:false` is the global
  kill switch. **Footgun: a background process started *outside* the agent's tracking
  is killed when the timer fires** (a Bash-tool `run_in_background` shell is exempted).
- **A live background shell blocks silent teardown.** Killing a pane kills live jobs
  outright (Claude then shows an ambiguous "No completion record" on next resume).
  Auto-suspend *prevents* (excludes `hasBackgroundShell` sessions); manual archive
  *warns* (3-way dialog: kill jobs / archive anyway / cancel); the `archive_session`
  MCP tool takes the safe kill-jobs-first path unconditionally.
- **PR watching.** Auto-attach is a launch-injected Claude hook (not polled;
  only catches agent-run `gh pr create`). The 60 s poll auto-removes merged/closed
  links and drives a check-watch. **`checkStatus` is mergeability-gated
  (`mergeStateStatus == CLEAN`), NOT rollup-derived** — an all-green rollup can still
  be unmergeable, so never report "passing" off the rollup alone. `autoFixPrChecks`
  (default on) gates the pane nudge; `autoMergeOnPass` (default **off**) squash-merges
  on a passing transition. All `gh` invocation stays in the `pr-status.js` leaf.
  **`diffUnresolvedComments` (notifier.js) deliberately has NO `seeded` flag,
  unlike `diffCheckStatus`/`diffDirty` — do not "fix" this for consistency.**
  Unresolved review-thread count is an unbounded counter that's already nonzero
  on almost every established PR, so firing on first sight (like the other two
  diffs do for their small enum/bool state spaces) would spam every newly-linked
  PR. Instead a key is baselined silently the first time its count is a REAL
  number; a link whose count is still `undefined` (never yet fetched
  successfully) is skipped entirely rather than baselined at 0 — baselining at 0
  would misread the PR's first successful fetch (which may return an
  already-nonzero count) as a spurious increase. Forward-only like `diffDirty`:
  only an increase emits, never a decrease (including down to zero) — a
  "cleared" direction was deliberately rejected, since resolving the last thread
  on a repo enforcing conversation-resolution flips `mergeStateStatus`
  BLOCKED→CLEAN in the same poll tick that already fires the checkStatus
  pending→passing nudge, so it would double-notify the same real-world moment.
- **Autopilot workflows = a skill + a thin tracking layer.** The whole issue→PR arc
  lives in the in-repo `issue-to-pr` skill (loaded via `--plugin-dir` only when the
  `workflow` flag is set — through `buildLaunch`/`buildResume`, **not** `buildFork`).
  The wrangler only stamps `entry.workflow` and exposes the `workflow_phase` MCP tool;
  **resume must carry the flag** or a long run loses the skill.
- **Child sessions = a generic `parentSession` (card id) link.** Nesting is **opt-in**
  (`spawn_session` `nest:true`, or later `attach_session`/`detach_session`), never
  inferred from the caller's state. A workflow worker is just a child whose parent is
  an orchestrator. On the board a worker renders in a violet `.workflow-box`, any
  other child in a plain child-spine; **nesting is one level deep** (a grandchild
  whose parent is absorbed is promoted, never dropped). **`parentSession` (board
  nesting) and `spawnedBy` (who actually called spawn_session/spawn_workflow) are
  separate, independently-nullable fields** — a `nest:true` spawn sets both to the
  same id, but a board-dispatched session later `attach_session`'d under something
  has a real `parentSession` and a null `spawnedBy`. `AW_SPAWNER_SESSION_ID` (env,
  set at launch) and `get_session_info`/`list_sessions` (MCP) surface both — see the
  `session-hierarchy` skill; never conflate the two into one "parent" concept.
- **Sub-agents are read-only artifacts read off disk, never sessions** (no tmux, no
  card id). Discriminator: a `subagents/` dir ⇒ emit from the files; no dir ⇒ emit the
  parent's `tool_use` pairs — **never both, or every modern sub-agent double-counts.**
- **`transcript-reader.js`'s `analyze()` must never run concurrently for the same
  sessionId — it reads AND mutates a shared per-session `state` object (module-level
  `cache` Map) in place, so two overlapping callers race on it.** A slower caller's
  own (now-stale) `stat.size` can compare as smaller than the `state.offset` a
  faster, already-finished caller advanced past, tripping the "file
  truncated/rotated" branch and wiping every `subFiles` tracker — resetting
  `quietPolls` to 0 for sub-agents that finished long ago, so they ALL flash
  `'running'` again for a poll or two (the live bug this fixed: every sub-agent
  under a task briefly flashing running then reverting). `analyze()` is a plain
  (non-async) function that coalesces concurrent callers for the same
  `` `${projectsDir}\0${sessionId}\0${since}` `` into one shared in-flight promise
  rather than trying to make the truncation check itself safe under concurrent
  mutation — kept non-async so coalesced callers get the exact same promise
  reference (an `async` wrapper would still coalesce correctly, just without that
  identity). `server/index.js`'s `rebuild()` is the main source of overlap (a 4s
  interval, an 80ms-debounced file watcher, and ~15 direct handler calls with no
  serialization between them) and is now wrapped in `createRebuildCoalescer`
  (`rebuild-coalescer.js`) for the same reason — but deliberately with
  TRAILING-coalescing semantics, not `createFullSweepGuard`'s silent skip: several
  callers do `await rebuild()` right after a mutation (rename, dispatch, fork,
  attach) and rely on the resulting broadcast reflecting their change, so an
  overlapping call must queue one fresh trailing run rather than being dropped.
  Today every path to `analyze()` funnels through `rebuildOnce` (verified: no other
  caller reaches it outside `buildGraph`, and `buildGraph`'s own three enrichment
  loops each `await` sequentially, never in parallel), so `rebuild()`'s guard alone
  already prevents the race — `analyze()`'s own coalescing is defense-in-depth for
  the day a future direct caller (a control handler, an MCP tool) bypasses it.
- **Archive cascade.** Archiving a session with live descendants (transitive
  `parentSession` closure) offers to cascade in one handler call; the `archive_session`
  MCP `archive_children` defaults true. The worktree-deletion offer is withheld while
  another tracked session still points at the same cwd.
- **Schedules = a saved action + a when; the `DATA_DIR` lock makes one scheduler**, so
  no double-fire. Two action kinds: `dispatch` (new session) and `session` (act on an
  existing card id, branching on liveness). `markFired` advances a cron to the next
  occurrence **strictly after now**, so a slot missed during downtime fires **once — no
  backlog**. Recurring + worktree forces `worktreeAuto` (else the 2nd fire hits
  `branch-in-use`).

## Ops & conventions

- launchd service `net.portswigger.agent-wrangler` needs `~/.local/bin` on `PATH`
  (else dispatch/resume exit 127). Restart:
  `launchctl kickstart -k gui/$(id -u)/net.portswigger.agent-wrangler`.
- **Devcontainer sessions (ops).** A `runtime:'devcontainer'` session needs three
  things the host path doesn't: **`AW_BIND_HOST=0.0.0.0`** (the default `127.0.0.1`
  bind is unreachable from the container, so the in-container agent can't reach `/mcp`
  — widens exposure on a shared machine); **`@devcontainers/cli`** on PATH (a
  `package.json` dep; `wrangler-start.sh` puts `node_modules/.bin` on the launchd PATH
  so panes resolve `devcontainer`); and the container's **claude pinned / auto-update
  disabled** (`DISABLE_AUTOUPDATER=1`) or a mid-life self-update breaks its own
  `bin/claude` symlink (dead pane, exit 127). Per-repo template concern; the wrangler
  injects nothing.
- **Deps auto-reconcile on startup** (`scripts/sync-deps.sh` runs `npm ci` when
  `package-lock.json`'s hash changed). So a dep change needs a **restart** to take
  effect; `node server/index.js` directly skips this.
- **No hardcoded hex in markup/JS** — front-end colour goes through the semantic CSS
  variables in `public/styles.css` and must work in dark *and* light. The terminal is
  themed via `--term-*` vars read by a JS helper. See `docs/superpowers/specs/`.
- **Isolated dev instance:** use the `run-dev` skill. Load-bearing: a fresh
  `AW_DATA_DIR` never scans the default socket (your live board is safe), and **never
  name a shell var `TMUX`** (it breaks `tmux ls`).
- No unnecessary code comments; match the existing dense "explain *why*" style.
  `npm test` runs `node --test`.
