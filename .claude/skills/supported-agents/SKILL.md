---
name: supported-agents
description: Use when implementing any agent-facing feature, adding launch flags, asking what agents this codebase supports, or checking whether a new capability needs to cover multiple agents.
---

# Supported agents

## Overview

The wrangler supports two agents — **Claude** and **Codex** — behind a shared adapter registry
(`server/agents/index.js`). Each agent has its own adapter file (`server/agents/claude.js`,
`server/agents/codex.js`) that owns command-building, process detection, live-state reading,
and cost parsing. The shared machinery (graph reconciliation, card-id handling, tmux, `classify()`)
is agent-agnostic and imports *from* the agents layer, never the reverse.

When adding an agent-facing feature, check both adapter files. If the feature needs
agent-specific wiring, implement it in both before the work is done. Capabilities that are
truly agent-agnostic belong in the shared layer and don't need adapter changes.

## Capability differences

These are stable conceptual differences. For current mechanisms, read the adapter files directly.

| Capability | Claude | Codex |
|---|---|---|
| Hooks | PostToolUse/Bash hooks injected at launch | None — status is pane-scraped (working/idle only; no needs-you) |
| Session ID | Preset before launch; wrangler knows it immediately | Discovered post-launch by polling the Codex sessions directory |
| MCP identity | Can send a custom header per request | Cannot set arbitrary headers; uses a bearer token from an env var |
| System prompt injection | Dedicated CLI flag | Config key injected as a developer-role message |
| Skills delivery | Per-launch plugin dir (cwd-independent) | Text catalog injected at launch; skill files read on demand via absolute path |
| Slash-command plugins | Yes | No — MCP tools are the parity layer |

## Three launch sites

Both adapters implement `buildLaunch`, `buildResume`, and `buildFork`. A feature wired in
one must be wired in all three — omitting resume or fork is the most common gap.

## Key files

- `server/agents/claude.js`, `server/agents/codex.js` — the two adapters
- `server/agents/index.js` — registry; `adapterFor(entry.agent)` selects by the mapping field (`absent → claude`)
- `server/mcp/client-config.js` — MCP config helpers for both agents; `ALLOWED_TOOLS` list
- `server/memory-store.js` — prompt constants and path helpers shared by both adapters

## Red flags — STOP

- A new feature only touches one adapter file
- "Codex doesn't support X" used to skip the Codex side without documenting the gap or providing an MCP-tool alternative
- Feature wired in `buildLaunch` but not in `buildResume` or `buildFork`
