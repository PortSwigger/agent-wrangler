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
  collapsing a workflow box grow the tile instead of shrinking it. **TODO data is
  the one exception to "carried via `buildGraph`"** — it's task-scoped, not
  session-scoped, so it rides
  `taskStore.snapshot()` directly; don't go looking for it in `buildGraph`.
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
- **tmux needs a UTF-8 locale** or it renders Unicode (`⏺`, box-drawing) as `_`.
  launchd doesn't inherit the login locale, so `scripts/wrangler-start.sh` pins
  `LANG`/`LC_CTYPE`. If terminals show `_`, check the server env (`ps eww`).
- **Mandatory skills need an always-on nudge — discovery isn't reliable.** Meta-skills
  (`server/agent-skills.js`) are resolved install-relative so they're cwd-independent.
  A skill that MUST run at session start (task-memory) opts into a sidecar `WRANGLER.md`
  whose text is force-injected (`--append-system-prompt` / Codex `developer_instructions`);
  a plain discoverable skill does not reliably self-invoke. Most skills should have none.
- **The chat view's read path must not apply the fork bound and must not price anything.**
  A fork replaying parent history is correct for *reading*; `usageSince` bounds spend only.
  Three cost scanners already have to agree on `iterations[]`/advisor/fork rules — the chat
  path deliberately shows model only so it never becomes a fourth (no tokens are produced or
  rendered anywhere on this path). `subagent.usd`
  is forwarded from `transcript-reader.js`, not recomputed (`server/chat-events.js`).
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
- **The chat view cannot stream a partial turn, and no indicator should imply it
  does.** Claude Code writes whole messages to the transcript — there is no
  partial or delta line to tail — so between the start of a turn and the message
  landing there is genuinely nothing to render. The live row (`.chat-live`, last
  child of the stream, `chat-view.js`) is the honest substitute: presence gated
  on the session's real status, decorated with the pending tool name when there
  is one, plus the elapsed clock above. Don't replace it with something that
  looks like text arriving.

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
  (Claude re-resolves it per file access, so a running session follows a mid-flight
  repoint). Injected at **dispatch/resume/fork, keyed on card id — keep the three in
  sync.** `memory-store` rejects non-segment ids (path-traversal guard).
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
