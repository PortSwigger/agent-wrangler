---
name: brainstorm
description: Clarification-only adaptation of the personal brainstorm skill, bundled with the issue-to-pr autopilot and READ as a guide (not invoked as a standalone skill). Use when an issue is too vague to know WHAT to build — ask the human focused questions until the 'what' is concrete, then hand straight back to the autopilot arc. It deliberately omits brainstorm's approach-comparison, design write-up, plan-mode, reviewer, and visual-companion stages — the autopilot owns those.
---

# Clarifying the 'what' (for the issue → PR autopilot)

This is the front half of the brainstorm skill, trimmed for autopilot use. You read
it when an issue doesn't say **what** to build. Your only job here is to make the
'what' concrete enough to build responsibly — then stop and let the autopilot's own
plan → build → verify → PR arc take over.

You are **not** designing the solution and **not** entering plan mode. The autopilot
decides the *how* (approach, structure, naming, libraries) autonomously; you only pin
down the *what* (intent, scope, success criteria) with the human.

## When to use this

Only when you genuinely can't tell what to build from the issue. A Jira/GitHub issue
with a clear summary and acceptance criteria does **not** need this — proceed. Reach
for it for bare, underspecified free-text ("improve the dashboard", "make login
nicer") where guessing would risk a whole run on the wrong thing.

## The flow

1. **Explore project context first.** Read the relevant files, docs, and recent
   commits so your questions are informed and you never ask what the repo already
   answers.
2. **Check scope.** If the request is really several independent pieces (e.g. "add
   chat, billing, and analytics"), say so and agree with the human which **one**
   piece this run delivers — one issue → one PR. Don't try to squeeze a mega-issue
   into a single run.
3. **Ask clarifying questions — one at a time.** Prefer multiple-choice; open-ended
   is fine. One question per message. Focus on **purpose, constraints, and success
   criteria**: what problem this solves, what "done" looks like, what's explicitly
   out of scope. Keep going until you could write a one-line spec of the change.
   - These questions are how the autopilot stops for the human: each one puts the
     card in **needs-you** and the run waits. Keep your phase chip on `plan`.
   - Ask only what you **can't responsibly assume**. Don't ask about the *how*
     (architecture, file layout, which library, naming) — pick sensible defaults for
     those and keep moving; the autopilot is meant to be autonomous.
4. **Confirm the 'what'.** Once it's clear, play it back in a sentence or two — what
   you'll build and how you'll know it's right — and get a yes (or a correction).
5. **Hand back.** With the 'what' confirmed, drop this guide and continue the
   autopilot arc from branch discipline (§2 of the parent skill) onward. No design
   write-up, no plan mode, no review loop, no `/clear`.

## Principles

- **One question at a time** — don't overwhelm with a wall of questions.
- **Multiple choice preferred** — easier to answer than open-ended.
- **YAGNI** — clarify the change that's actually needed, not a bigger system.
- **Ask only what you can't assume** — default everything else and keep moving.
- **Be flexible** — if an answer reframes the task, adjust and re-ask as needed.
