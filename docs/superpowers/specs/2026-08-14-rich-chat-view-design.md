# Rich chat view — a second way to read and drive a session

**Status:** design, approved in brainstorm; no implementation yet
**Date:** 2026-08-14
**Scope:** a new sidebar view that renders a session's conversation from its
transcript, plus a composer that sends through the *existing* human message path,
plus a preference to switch between it and the terminal. Both agents.
**Explicitly out of scope:** changing how sessions are launched, resumed or forked
(this feature adds no launch flags); the board card; the mailbox; cost accounting;
anything that requires driving the agent's interactive TUI.

## Problem

The only way to read a session today is `tmux attach` in an xterm. That is exactly
right when you are *driving* an agent, and a poor fit for the wrangler's actual
premise — that you were **not** watching. Terminal scrollback gives every byte equal
weight: a 400-line `npm test` dump and the one paragraph explaining what the agent
concluded are the same size, in the same font, in the same colour. Catching up on a
session you left an hour ago means scrolling past machine output hunting for prose.

The conversation is already structured on disk. This design renders it.

## Approaches considered

Recorded because the rejected options are the ones a future reader will re-propose.

| approach | what it gives | why not |
|---|---|---|
| **Transcript-sourced** (chosen) | Full conversation, tool calls, thinking, sub-agents, per-turn usage. Zero new dependencies; two existing readers already parse these files. | Cannot see a *pending* interactive prompt — it exists only in the pane. Accepted; see *The needs-you handoff*. |
| **AG-UI protocol** | A standard event vocabulary for agent→frontend streaming. | It standardises *transport*, it does not *produce* events. Neither agent speaks it, so we would still need the transcript reader, plus a translation layer, plus a dependency — to feed a single-user local board that already has its own `/ws` control channel and graph broadcast. Its event vocabulary is worth borrowing as a mental model; the protocol is not. |
| **Agent SDK control protocol** (`--print --output-format stream-json --input-format stream-json`, `--permission-prompt-tool`) | Genuine full fidelity: streaming, interrupts, and permission requests routed to the app instead of a TUI dialog. | Replaces the interactive TUI. It is a third agent adapter, not a view: co-attach, `remain-on-exit`, suspend, pane nudges, scraped status and the shell pane all need a parallel path, and "switch back to the terminal" becomes meaningless for such sessions. A separate project. |

**The chosen path does not foreclose the SDK one.** If an SDK runtime ever lands it
arrives as an agent adapter emitting the same normalised events defined below, and
reuses this view unchanged. That is the main reason the event model is defined as an
agent-agnostic middle layer rather than as "Claude transcript lines with a nicer CSS".

## What this view is, and is not

- **It is** a reading surface first, with a composer for the ordinary case (typing a
  fresh prompt) and an interrupt for the common emergency.
- **It is not** a terminal replacement. Permission prompts, plan-mode approvals and
  slash commands stay in the pane. The design's job is to be *honest and one click
  away* about that boundary, not to hide it.
- **It works where the terminal cannot.** The transcript is on disk regardless of
  tmux, so dormant and archived sessions render fully. This is a real capability gain
  for nearly no extra work, and it is the strongest argument for the view existing.

## Turn anatomy — direction C, "prose with an activity spine"

Chosen over a prose-faithful rendering (too lossy about what the agent *did*) and a
full event timeline (that density is what the terminal already gives you — a prettier
scrollback is not worth switching views for).

The rule: **prose reads first; machinery collapses.**

- Assistant prose renders as markdown at full weight.
- Thinking collapses to a `Thought for Ns` disclosure.
- **A run of consecutive tool events with no assistant prose between them collapses
  into one activity group**, labelled by verb — `Read 2 files, 1 search`,
  `Edited 2 files`, `Ran 3 commands` — expandable to the individual calls.
- An `Edited …` group carries `+N −M` and opens the **existing diff panel**; it does
  not render its own diff.
- Sub-agents render as their own group, and rows open the **existing** sub-agent modal.
- A per-turn footer shows model and tokens.

Grouping is the one new concept this design introduces, which is why it lives in a
pure, separately tested module.

## Server design

### `server/chat-events.js` — a new leaf

Pure `transcript line → normalised chat event`. Deliberately mirrors
`server/search/extract.js`'s shape (per-agent extractor, cheap substring gate before
`JSON.parse`, doc-meta merged as it is seen) but **keeps the tool calls that
`extract.js` drops on purpose** — the two modules have opposite goals and must not be
merged.

**Leaf discipline applies** (`CLAUDE.md`, agents layer): it must not import
`session-manager` / `state-reader` / `tmux-scraper` / `index`. Consequence: it unit-tests
from a jsonl string with no DOM and no server.

### The normalised event model

Agent-agnostic. This is the seam an SDK runtime would later target.

| event | fields | notes |
|---|---|---|
| `user` | `text`, `ts` | synthetic/injected turns dropped |
| `assistant` | `text` (markdown), `ts`, `model` | |
| `thinking` | `ts`, `durationMs?`, `text?` | `text` absent for Codex — see gaps |
| `tool` | `name`, `target`, `input`, `output`, `ok`, `ts`, `truncated?` | one event per completed call |
| `subagent` | `id`, `name`, `status`, `calls`, `usd?` | drill-down reuses the existing modal |
| `notice` | `kind`, `text`, `ts` | a *resolved* permission/denial |

`durationMs` is derived from the timestamps of adjacent transcript lines, which is the
only place the information exists — neither agent records a thinking duration directly.
When it cannot be derived the disclosure reads `Thinking` with no duration rather than
guessing; the field is optional for exactly that reason.

`subagent.usd` is **passed through** from the sub-agent analysis
`transcript-reader.js` already performs, never recomputed here. That is not a
contradiction of the no-cost rule below: this path introduces no new pricing
arithmetic, it forwards a number the existing scanner produced.

### Per-agent mapping

**Claude.** `message.content` blocks → `text` / `thinking` / `tool_use` / `tool_result`.
A `tool_result` pairs to its `tool_use` by `tool_use_id`. Sub-agents keep the existing
discriminator from `transcript-reader.js`: a `subagents/` dir ⇒ emit from those files;
no dir ⇒ emit the parent's `tool_use` pairs; **never both**, or every modern sub-agent
double-counts.

**Codex.** Verified against a real rollout
(`~/.codex/sessions/2026/07/16/rollout-…-019f6a55-….jsonl`), not assumed:

- `response_item/message` is the conversation. **Filter `role: "developer"`** — Codex
  injects permissions/instructions text under that role — in addition to the
  synthetic-prefix turns `extract.js` already documents.
- `response_item/function_call` → `response_item/function_call_output`.
  **Pair on `call_id`, never `id`.** A `function_call` carries *both*: `id` is
  `fc_…` and `call_id` is `call_…`, while the output carries only `call_id`.
  Pairing on `id` silently orphans every tool result — it does not throw, it just
  renders a timeline with no outputs.
- `response_item/reasoning` has **`summary: []` and `encrypted_content`**. There is no
  readable thinking text for Codex, only the fact that thinking happened. Emit
  `thinking` with no `text`.
- `event_msg/agent_message` is **skipped** as a duplicate of
  `response_item/message` — the same de-duplication rule `extract.js` already states.
- `response_item/tool_search_call` / `tool_search_output` map to `tool` like any other
  call.

### Delivery — a `chat` control handler

Request/reply **to the requesting client only**, following the
`subagent-detail` / `get-memory` pattern. Never broadcast: only the reader of one
session needs its conversation, and broadcasting a transcript to every connected
browser on a 2-second cadence would be absurd.

- Client sends `{ type: 'chat', sessionId, sinceOffset }`.
- Server replies `{ type: 'chat', sessionId, events, offset, more }`.

**Two payload bounds, both load-bearing — a naive implementation ships megabytes.**

1. **Per-event truncation.** A single `Read` of a large file, or a `npm test` dump,
   puts the whole thing in one `tool_result`. Tool `input` and `output` are truncated
   server-side to a fixed cap with `truncated: true` set, and the view shows a "view
   full output" affordance rather than inlining it. Without this cap, one file read
   pushes a multi-megabyte frame over the WS, and the *expanded* view of a collapsed
   activity chip is exactly where that content is least wanted by default.
2. **An initial window, not the whole file.** A months-old session's transcript is
   large, and `sinceOffset` only bounds the *tail*. The first request for a session
   returns the most recent window of events and sets `more: true` when older ones
   exist; the view renders a "load earlier" affordance at the top that requests
   backwards from the window's start. Opening a long-running session must not block on
   parsing and shipping its entire history.
- **Card id → `liveSessionId` resolves off the graph**, exactly as
  `subagent-detail.js` does it, with the legacy card-id fallback for pre-split
  entries. The card id is never a conversation id.
- The client polls ~2s while the chat view is open for that session, and stops when it
  is not.

**No `fs.watch` / chokidar.** A single-file watcher for the selected session would be
bounded at 1 fd and is therefore *defensible* — but the polled offset tail costs
nothing, and the fd-leak that `watchIgnored` exists to prevent ended in
`posix_spawnp failed` on every terminal attach, clearable only by restart. Not worth
re-opening that door for a 2-second latency improvement.

The incremental read reuses the `offset` + `leftover` shape `transcript-reader.js`'s
cache already uses, so a half-written trailing line (normal for a live session) is
carried to the next poll rather than dropped or double-emitted.

### Two invariants that deliberately do NOT apply here

Stated explicitly because both look like bugs to a reader who knows `CLAUDE.md` and
would "fix" them.

1. **The fork bound must not be applied.** A fork's transcript replays the parent's
   entire history, and `usageSince(entry)` exists to stop that history being *billed
   twice*. It bounds **spend only** — summary and `lastActivity` stay inherited. For
   *reading*, the replayed history is the conversation and showing it is correct.
   Do not add a `createdAt` cut to this path.
2. **This path computes no cost.** The turn footer shows model and tokens, nothing in
   dollars. Three scanners (`transcript-reader.js`, `usage-report.js`,
   `scripts/cost-report.mjs`) must already agree on the `iterations[]` walk, the
   advisor-model bucketing and the fork bound. A chat view that priced its own turns
   would be a fourth place to get that wrong. Session-level cost stays on the existing
   panel chips, which already do it correctly.

## Client design

Three files, split on the line this repo already draws between pure logic and DOM.

**`public/chat-group.js` — pure.** Normalised events → render model. No DOM, no
`window`, so it unit-tests like `search-browse.js` / `layout.js` / `diff.js`. Owns the
activity-grouping rules, the verb labels and the `+/−` roll-up. This is the module most
worth testing, because grouping *is* the design.

**`public/chat-dom.js` — node construction.** Agent- and repo-generated text is
untrusted: paths, tool targets, tool output and command text go in via
`textContent` / `dataset`, **never `innerHTML`** — the rule `diff-dom.js` states for the
same class of content.

The single exception is assistant prose, which renders through the existing
`createRenderer(window.markdownit)` from `markdown-preview.js`. That renderer is
already vendored and already the safe-by-default choice (`html:false` escapes raw HTML
rather than passing it through; `validateLink` drops `javascript:` / `vbscript:` /
`data:`), so its output needs no separate sanitiser pass — the same argument that
already justifies it for the task-memory preview. No new dependency.

**`public/chat-view.js` — the controller.** Mounts into the `#term-wrap` slot, owns the
poll loop, scroll anchoring and composer wiring.

### Rendering behaviour

- **Append, never re-render.** Each poll appends nodes for new events only.
  `renderPanel` already documents why reassigning `innerHTML` is a trap — it restarts
  the CSS throb mid-cycle and resets scroll position. On a 2-second cadence a full
  re-render would fight the reader continuously.
- **Scroll**: pinned to the bottom while already at the bottom; otherwise position is
  preserved and a "jump to latest" affordance appears.
- **Collapsed by default**: thinking, activity groups, sub-agent detail.
- **Colour goes through the semantic CSS variables** in `styles.css` and must work in
  both dark and light. No hardcoded hex in markup or JS.

## Chrome, and the preference

**The toggle** is a segmented `Chat / Terminal` control in the `#panel` header — the
same idiom the diff panel already uses for `Uncommitted / Full branch`, which is the
same job (two views of one thing). Everything around it is unchanged: the session
header, Actions menu, diff panel, rename-on-double-click and the existing
fullscreen/maximize key all keep working in both views.

**The default** is one entry in the `SETTINGS` registry in `public/settings.js`:

- `id: 'chatViewDefault'`, `scope: 'server'`, with its own small control handler
  (`server/control/handlers/chat-view-default.js`).
- This mirrors `subagentsExpandedByDefault` deliberately — it is the same shape of
  setting ("what a per-session toggle defaults to"), so it follows the same pattern
  instead of inventing a second one. Per the registry's own contract, the panel row,
  persistence and `getSetting()` all derive from that one entry.
- **It defaults to terminal.** The terminal is current behaviour and silently changing
  what the board does on upgrade is intrusive. A one-word change if that proves wrong.

**The per-session override** is keyed on **card id** — never the live id, per the rule
that nearly every per-session field is card-keyed — and persisted to `localStorage`,
following the precedent already set by diff review drafts. A session flipped by hand
keeps its own choice regardless of the default, matching the wording
`subagentsExpandedByDefault`'s help text already uses.

## Composer and interrupt

**Sending changes nothing about how messages are delivered.** The composer calls the
existing `message` control handler → `deliverMessage`, which already handles live
(paste into pane), dormant (wake, then deliver) and archived (refuse). Composer states
follow from that: dormant shows "sending will wake it", archived is read-only.

This is the **human** path, which `CLAUDE.md` notes is deliberately *not* routed
through the mailbox — the mailbox is peer-only, and the two paths are meant to diverge.
The composer must not change that.

Keys: `Enter` sends, `Shift+Enter` newline.

**Interrupt** is a small new handler over the already-exported
`sendKeys(name, ['Escape'], socket)` from `tmux-scraper.js` — no new primitive. If the
two TUIs ever diverge on the interrupt key, that belongs in the agent adapter, not in
the handler.

## The needs-you handoff

The hybrid, because the two halves answer different questions:

- **Live, blocked → a sticky bar** in fixed chrome directly above the composer, which
  also visibly dims. Cannot be scrolled past. This needs **no new detection**: it reads
  `status === 'needs-you'` off the graph the client already receives.
- **After the fact → a compact row in the stream** (`Approved: git push`). This comes
  from the transcript, as a `notice` event, because an approval or denial surfaces in
  the `tool_result` once answered.

So the blocked state is impossible to miss *now*, and still auditable *later*, without
the inline-only failure mode of scrolling away while a session sits blocked.

## Codex gaps — documented, not skipped

Per the `supported-agents` red flags, "Codex doesn't support X" is not a licence to skip
the Codex side silently. Both gaps are inherent to what Codex writes to disk:

| gap | consequence | mitigation |
|---|---|---|
| `reasoning` is encrypted with an empty summary | No thinking text, ever | Render the `Thought for Ns` marker with nothing to expand |
| Pane-scraped status has no needs-you | The sticky bar never appears for Codex | The `Terminal` toggle is one click away and always available; unchanged from today, where the terminal is the *only* option |

Neither gap needs an MCP-tool alternative: the terminal already covers both, and this
feature adds no capability that Codex sessions previously had.

**No adapter changes.** This feature adds no launch flags, so `buildLaunch` /
`buildResume` / `buildFork` are untouched in both adapters — the three-launch-site trap
does not apply. The per-agent work is entirely in the `chat-events.js` normaliser.

## Testing

- `server/chat-events.test.js` — per-agent mapping from jsonl-string fixtures.
  Must cover, as regression tests for the verified footguns: Codex pairing on `call_id`
  when `id` differs; `role: "developer"` filtered; `event_msg/agent_message` not
  double-emitted; Claude sub-agent dir-vs-inline discriminator not double-counting; a
  half-written trailing line carried, not dropped.
- `public/chat-group.test.js` — grouping, verb labels, `+/−` roll-up, boundaries
  (prose between tool runs splits a group; a lone call still groups).
- Payload bounds: an oversized tool output is truncated and flagged; a long transcript
  returns a bounded first window with `more: true`, and paging backwards from it
  neither duplicates nor drops events at the seam.
- `public/chat-dom.test.js` — asserts untrusted text never reaches `innerHTML`, as
  `diff-dom.test.js` does.
- `npm test` (`node --test`) must pass.
- Before merge, the repo mandates the **`wrangler-verify-ui`** skill for `public/` and
  session-lifecycle changes, and a real instance via **`run-dev`**.

## Out of scope, and why

- **Slash-command completion in the composer** — needs a per-agent source of truth for
  what commands exist, and Codex has no slash-command plugins at all. Revisit once the
  view is proven.
- **Image paste / attachments** — no demand yet.
- **The SDK runtime** — its own project; see *Approaches considered*.
- **Board card changes** — the card already carries status, cost and sub-agent counts.

## Files touched

New: `server/chat-events.js` (+ test), `server/control/handlers/chat.js`,
`server/control/handlers/chat-view-default.js`, `server/control/handlers/interrupt.js`,
`public/chat-view.js`, `public/chat-group.js` (+ test), `public/chat-dom.js` (+ test).

Modified: `server/control/handlers/index.js` (register), `public/index.html` (the chat
slot + composer shell), `public/app.js` (toggle wiring, per-session override, mount/
unmount), `public/settings.js` (one `SETTINGS` entry), `public/styles.css`,
`CLAUDE.md` (the two deliberately-not-applied invariants, and the Codex `call_id`
pairing rule).
