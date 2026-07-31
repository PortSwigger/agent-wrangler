---
name: wrangler-verify-ui
description: Use when about to merge, review, or verify changes to public/ or to session lifecycle code (dispatch, fork, resume, archive, suspend, snooze, worktree handling, PR/check watching) in this repo.
---

# Verify UI and behavioural changes in a dev instance

`npm test` does not exercise the board UI or live tmux/session behaviour. For changes to `public/` or session lifecycle, stand up an **isolated dev instance** and confirm the change works before merging — never verify against the live board (you risk its real sessions).

Use the `run-dev` skill for the full launch/drive/teardown recipe. A fresh `AW_DATA_DIR` isolates the instance completely; it cannot see or touch the live board's sessions.

## Viewport sizing

The board layout is responsive — tile and card span maths are measured in px. Test at multiple sizes via DevTools, not by dragging the OS window:
- chrome-devtools MCP: `resize_page` or `emulate`
- Browser device toolbar

This gives exact, repeatable pixel dimensions and leaves your actual window untouched.

## Verifying visual changes — delegate to a subagent, never screenshot from the main thread

Screenshots are expensive to carry in context: once one lands in the main
conversation it never leaves, and it gets re-billed on every later turn for
the rest of the session. A styling-iteration loop that takes 20 screenshots
directly in the main thread can add tens of dollars to a session's cost —
most of it recurring tax, not the screenshots themselves.

**Never call chrome-devtools navigation/screenshot tools directly from the
main thread to verify a visual change.** Delegate to a `general-purpose`
subagent instead:

1. Spawn a subagent (foreground) with: the dev instance URL, a description
   of the expected visual outcome, which breakpoints to check, and an
   explicit instruction that it must only observe and report — never edit
   files, and never return more than a short pass/fail + issue verdict.
2. For further checks on the *same* issue, continue that subagent via
   `SendMessage` to its `agentId`, briefing it only with what changed since
   the last check.
3. **After 5 checks against one subagent instance, retire it and spawn a
   fresh one** for check #6 onward, even if the issue is still unresolved.
   Brief the fresh instance with just the current expectation + a one-line
   summary of the latest change.
4. Never ask a subagent to return a screenshot inline. If a verdict is
   ambiguous, have it save the screenshot to disk and report the path —
   pull it up yourself only if truly necessary.

## Red flags — STOP

- "`npm test` passed" used as proof a UI change works → tests don't cover the board
- Verifying against the live board instead of an isolated dev instance
- Dragging the OS browser window to test responsive layout → use DevTools viewport sizing
