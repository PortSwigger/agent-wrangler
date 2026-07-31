---
name: session-activity
description: Use when asked "what did I actually work on on date X" (standup notes, a weekly summary, "what did I do yesterday") and Agent Wrangler sessions are in scope — how to call the get_session_activity MCP tool, the source of truth for wrangler activity, for precise transcript-backed per-day detail instead of hand-parsing mappings.json/transcripts.
---

# Session activity

Use the `get_session_activity` MCP tool to answer "what did I work on on date X"
for **Agent Wrangler sessions** — directly from the wrangler's own records, no
manual `mappings.json`/transcript spelunking required.

## Calling the tool

```
get_session_activity({ date: "2026-07-01" })
get_session_activity({ date: "2026-07-01", endDate: "2026-07-03" })
```

`date`/`endDate` are `YYYY-MM-DD`, inclusive, interpreted in this machine's local
timezone (the wrangler runs on your own Mac, so that's the timezone you mean).
For each session with any transcript activity in range it returns session id,
label, task, cwd, agent, whether it's archived, message count that day, and the
first/last activity timestamp. Sessions are sorted newest-activity-first.

This covers **live, suspended, and archived** sessions — the main gap versus
`list_sessions`, which only sees whatever's currently on the board and drops
archived sessions entirely. Both **Claude and Codex** sessions are included;
each is read via its own transcript format.

## Scope

This is the source of truth for **Agent Wrangler session activity only** — it
won't tell you about anything else that day (docs, Slack, unrelated coding).
For a full "what did I do" picture, other sources (e.g. browser history) still
matter for everything outside the wrangler.

If you're also looking at browser history for the same day, `localhost:<port>`
entries (`AW_PORT`, default `7878`) are wrangler board URLs
(`localhost:<port>/#session=<id>`) — they're already covered by this tool, so
there's no need to resolve them individually from history; for wrangler
sessions specifically this tool is also more complete than a browser tab ever
could be, since it captures headless/API-driven work and autopilot runs where
no tab was ever open.

## Why not just the session's lifetime window

A session's overall lifetime (`createdAt` → `archivedAt`/`suspendedAt`) can span
multiple days while only having real activity on one of them — e.g. a session
created late one day and suspended the next may have 150 messages on day one and
6 on day two. Don't infer "worked on X on both days" from the lifetime window
alone; this tool (and the underlying transcript scan) is what gives per-day
attribution.

## Known limitations

- **Fork chains aren't followed.** If a session was resumed/forked from another
  (`forkedFrom`), each is reported independently on its own transcript; activity
  isn't rolled up across the chain.

## Falling back to the raw files

If the tool is ever unavailable, the same data is readable directly:

1. `~/.agent-wrangler/mappings.json` — one entry per session ever created
   (including archived/suspended ones no longer on the board), keyed by card id.
   Relevant fields: `createdAt`, `suspendedAt`, `archivedAt`, `name`, `intent`,
   `task: {id, name}`, `cwd`, `liveSessionId`, `agent`, `worktree`, `forkedFrom`
   (all timestamps are epoch ms). Treat the field set as growing over time — a
   given entry may be missing any of these.
2. Each entry's `liveSessionId` (fall back to the card id itself for legacy
   entries with no `liveSessionId`) is the filename stem of a transcript
   somewhere under `~/.claude/projects/<encoded-cwd>/<liveSessionId>.jsonl`. The
   directory encoding replaces both `/` and `.` with `-`; the reliable way to
   find the file, though, is to scan every subdirectory of
   `~/.claude/projects/` for that filename rather than reconstruct the encoding
   yourself.
3. Transcript lines are JSON; a line carrying both a `message` field and a
   top-level `timestamp` (ISO 8601, UTC) is a real conversation turn — that's
   the ground truth for exactly when there was activity on a given day.
4. A Codex entry's `liveSessionId` is instead the rollout uuid embedded in a
   filename under `~/.codex/sessions/<year>/<month>/<day>/rollout-<ISO
   timestamp>-<uuid>.jsonl` — search recursively for that uuid rather than
   trusting the date-bucketed path. Every line carries a top-level `timestamp`;
   a real turn is an `event_msg` payload of type `user_message` or
   `agent_message` (a `response_item` with `role: "user"` can be a
   Codex-injected `<environment_context>` block rather than something the user
   actually typed, so don't count those).
