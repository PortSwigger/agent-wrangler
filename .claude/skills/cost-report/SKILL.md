---
name: cost-report
description: Use when asked to report, audit, or break down agent-wrangler token/cost spend — per calendar month, by task, by model, or to find the most expensive sessions. Recomputes from on-disk transcripts, not the board's cached numbers.
---

# Agent-wrangler cost report

## Overview

`scripts/cost-report.mjs` recomputes spend straight from the on-disk Claude and
Codex transcripts under `~/.claude/projects` (and `~/.codex/sessions`), so the
numbers are correct regardless of the board's cached state. It cross-references
`~/.agent-wrangler/mappings.json` (sessions) and `tasks.json` (task assignments)
to attribute each session to a task, and prices tokens via the repo's
`server/pricing.js` — the single source of truth — so a price change there flows
through automatically.

## Usage

```bash
node scripts/cost-report.mjs              # current month, table, top 15 sessions
node scripts/cost-report.mjs 2026-06      # a specific month (YYYY-MM)
node scripts/cost-report.mjs 2026-06 --top 25
node scripts/cost-report.mjs 2026-06 --json > june.json   # machine-readable
```

Output sections: headline total + per-session averages; **by task** (cost,
sessions, avg/session, tokens); **by model** (cost, sessions, token breakdown:
input / output / cache-write / cache-read); **by token type** (the dollar cost
split across input / output / cache-write / cache-read, each as a share of total
— Claude only; estimated Codex spend is excluded and noted); and the **top-N
most expensive sessions**. `--json` emits the same data as a structured object
for further processing (including a `byType` block).

## How it works (so the numbers are trustworthy)

- **Month attribution is per transcript line.** Usage is counted only for lines
  whose `timestamp` falls in `[monthStart, monthEnd)` (UTC), so a session that
  spans a month boundary is split correctly — it is *not* a whole-session total
  stamped to `createdAt`. (Codex rollouts are the exception: they're attributed
  whole to their `createdAt` month, with estimated ChatGPT-plan pricing, marked
  `~`.)
- **Transcript resolution mirrors the board, plus a fallback.** Agent-wrangler's
  card id is decoupled from Claude's conversation uuid, so the transcript is
  found by `entry.liveSessionId` first, then the card id (legacy, when they
  coincide), then — if neither file exists — the lone `.jsonl` in the launch
  cwd's project bucket. A bucket with multiple transcripts (a shared repo dir) is
  left unresolved rather than guessed.
- **De-duplicated by transcript.** A resume can re-point a fresh card id at an
  existing conversation, so two card ids resolve to one transcript. Each
  transcript is counted once (the true owner / assigned card wins); the report
  prints how many cards were merged.
- **Honest gaps.** Sessions whose transcript is genuinely gone (cleaned up, or an
  ambiguous shared bucket) are reported as an uncounted tally, never silently
  dropped into a total.
- **Sub-agent spend is included.** A session's cost is its own turns PLUS every
  sub-agent it dispatched (a sub-agent's turns are billed too). Modern async
  sub-agents are costed from their own `subagents/agent-*.jsonl` transcripts,
  summed per-turn (month-gated) like any other; a legacy sub-agent falls back to
  its parent tool_result's aggregate (a lower bound). The folded portion is shown
  as `(includes $X spent by dispatched sub-agents…)` and, in `--json`, as
  `totals.subAgentCostIncluded` plus a per-session `subAgentUsd`. It flows into
  every section, so **by model** now shows the sub-agents' (often cheaper) model.

## Caveats

- A session reassigned between tasks contributes its **whole** month cost to its
  *current* task (cost follows the session, not split by time).
- The `(unassigned)` row is sessions with no task (or `adhoc`).
- UTC month boundaries; pass an explicit `YYYY-MM` to avoid ambiguity near month
  ends in other timezones.
