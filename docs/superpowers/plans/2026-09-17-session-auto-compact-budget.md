# Per-session Auto-compaction Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an immutable, optional per-session auto-compaction threshold to Agent Wrangler.

**Architecture:** Validate one provider-neutral token threshold at the dispatch boundary and persist it on mapping entries. Reapply that entry value at every provider launch, resume, and fork; only add provider flags when a value was selected.

**Tech Stack:** Node.js ESM, node:test, Zod, browser DOM.

**Spec:** `docs/superpowers/specs/2026-09-17-session-auto-compact-budget-design.md`

## Global Constraints

- `autoCompactTokens` is an optional integer in the inclusive range 100000–1000000.
- Omission must leave existing commands and session behavior unchanged.
- A session's value is immutable after dispatch; forks inherit and resumes retain it.
- Claude receives `--autocompact <tokens>` and Codex receives `-c model_auto_compact_token_limit=<tokens>`.

---

### Task 1: Validate and carry the threshold through session launch state

**Files:**
- Modify: `server/session-manager.js`, `server/dispatch-runner.js`, `server/mcp/tools/spawn-common.js`, `server/mcp/tools/spawn-session.js`
- Test: `server/session-manager.test.js`, `server/dispatch-runner.test.js`, `server/mcp/tools/spawn-session.test.js`

**Interfaces:**
- Produces: `validateAutoCompactTokens(value)` and dispatch options carrying `autoCompactTokens`.
- Consumes: `spawn_session.auto_compact_tokens` and WebSocket dispatch payloads.

- [ ] Write failing tests for valid dispatch/spawn values, invalid bounds/types, omitted defaults, mapping persistence, and fork inheritance.
- [ ] Run the focused tests and confirm each new assertion fails because the setting is not accepted or persisted.
- [ ] Implement one shared validator, apply it before launch, persist valid values, and map the MCP snake-case field into the internal camel-case field.
- [ ] Run the focused tests and confirm they pass.
- [ ] Commit the completed task.

### Task 2: Add provider command mappings and lifecycle reapplication

**Files:**
- Modify: `server/agents/claude.js`, `server/agents/codex.js`, `server/session-manager.js`
- Test: `server/agents/claude.test.js`, `server/agents/codex.test.js`, `server/session-manager.test.js`

**Interfaces:**
- Consumes: adapter `buildLaunch`, `buildResume`, and `buildFork` option `autoCompactTokens`.
- Produces: conditional Claude and Codex command arguments.

- [ ] Write failing adapter tests asserting the exact provider mappings on launch/resume/fork and their absence when unset; write lifecycle tests proving resume reapplies and fork copies the entry value.
- [ ] Run the focused tests and confirm they fail because commands omit the new flags.
- [ ] Pass the persisted setting through all session-manager launch paths and append only the documented provider flags.
- [ ] Run the focused tests and confirm they pass.
- [ ] Commit the completed task.

### Task 3: Expose the optional advanced control and document it

**Files:**
- Modify: `public/index.html`, `public/app.js`, `public/dispatch-modal.test.js`, `README.md`, `agent-skills/skills/spawn-session/SKILL.md`
- Test: `public/dispatch-modal.test.js`

**Interfaces:**
- Produces: optional `autoCompactTokens` dispatch payload from the advanced dialog.
- Consumes: user-entered token threshold and server validation errors.

- [ ] Write failing UI fixture/assertion tests for the new advanced control and dispatch payload.
- [ ] Run the focused UI test and confirm it fails because the field is absent.
- [ ] Add a compact numeric control with a 100k–1M hint, include it in dispatch reads only when populated, and update human/agent-facing help for the MCP option.
- [ ] Run the focused UI and relevant server tests and confirm they pass.
- [ ] Commit the completed task.

### Task 4: Verify and submit the change

**Files:**
- Verify: all files above

- [ ] Run the complete test suite and regenerate catalogues only if a changed generated source requires it.
- [ ] Inspect the final diff and verify a mutation removing each provider flag or persistence carry-forward would fail a focused test.
- [ ] Commit the finished feature, push the branch, and open a PR.
- [ ] Request the required opposite-provider adversarial PR review; implement justified findings and request re-review until clean or document a reasoned disagreement.
