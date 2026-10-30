---
name: supported-agents
description: Use when implementing any agent-facing feature, adding launch flags, asking what agents this codebase supports, or checking whether a new capability needs to cover multiple agents.
---

# Supported agents

## Overview

The wrangler supports **Claude**, **Codex** and opt-in **Antigravity** (`agy`) — behind a shared adapter registry
(`server/agents/index.js`). Each agent has its own adapter file (`server/agents/claude.js`,
`server/agents/codex.js`, `server/agents/agy.js`) that owns command-building, process detection, live-state reading,
and cost parsing. The shared machinery (graph reconciliation, card-id handling, tmux, `classify()`)
is agent-agnostic and imports *from* the agents layer, never the reverse.

When adding an agent-facing feature, check every adapter file. If the feature needs
agent-specific wiring, implement it for each supported provider before the work is done. Capabilities that are
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
| OS sandbox | None | `workspace-write` seatbelt: writes only to cwd, tmp, memory dir, each `--add-dir`; the launch cwd's git common dir is auto-granted (session-manager) |

The registry owns enumeration and validation. Only an absent historical provider defaults to
Claude; explicit unknown ids (including an empty string) are rejected before parsing or launching.
History scanners, file/chain discovery, search extraction and usage scans are adapter capabilities.
Browser labels, icons, cost estimates, model switching and compaction presets come from the same
metadata; unavailable providers can still label historical conversations. The registered providers
are Claude, Codex and Antigravity. Antigravity dispatch is gated by the off-by-default Manage agy integration setting and successful local plugin installation.

| Additional capability | Claude | Codex |
|---|---|---|
| History | Project transcripts with branch pruning | Validated rollout continuation chains |
| Active-turn mail | Cross-session socket; pane fallback waits for idle | Pane input with clear-composer and dialog guards |
| Live model switch | Guarded `/model` command | Launch-time selection only |
| Usage | Timestamped usage with fork bounds | Estimated API-equivalent spend; calendar allocation by creation day |
| Directory grants | Stable task-memory symlink | Real paths plus private/common Git metadata |
| Review selection priority | First | Second |

## Three launch sites

All adapters implement `buildLaunch`, `buildResume`, and `buildFork`. A feature wired in
one must be wired in all three — omitting resume or fork is the most common gap.

## Key files

- `server/agents/claude.js`, `server/agents/codex.js` , `server/agents/agy.js` — the adapters
- `server/agents/index.js` — registry and provider metadata; `adapterFor(entry.agent)` selects by the mapping field (`absent → claude`; unknown explicit ids throw)
- `server/mcp/client-config.js` — MCP config helpers for both agents; `ALLOWED_TOOLS` list
- `server/memory-store.js` — prompt constants and path helpers shared by both adapters

## Red flags — STOP

- A new feature only touches one adapter file
- "Codex doesn't support X" used to skip the Codex side without documenting the gap or providing an MCP-tool alternative
- Feature wired in `buildLaunch` but not in `buildResume` or `buildFork`

## Antigravity capability contract

| Capability | Antigravity |
|---|---|
| Dispatch | Local, Default login only; opt-in plugin; retained intent follows current-launch native read and idle composer |
| Mode | `--mode auto` with bounded post-composer BTab/footer verification; captured idle accept-edits hint is a placeholder, coloured auto footer is accepted; uncertainty shows setup |
| Resume | `--conversation`, launch model/effort/grants retained; fresh native readiness before wake text; uncertain intent never replayed |
| Fork | Guarded `/fork` in a separate pane; immutable parent prefix and step saved before launch |
| Identity/status | Six identity-scoped hooks; pane-process PID and summaries classification required; child events never set root status |
| MCP/instructions | Installed stdio native get_session_info read through the production POST router, launch identity and process ancestry gate intent/mail; optional GET streams receive 405; HTTP activity, shell imports and cached definitions cannot release them; SessionStart ephemeral instructions and skill catalog |
| Approval | Captured call_mcp_tool envelope, exact args.ServerName = agent-wrangler_agent-wrangler and registered ToolName; startup permits only get_session_info; human verifies installed namespace |
| Input | Bracketed paste, framed composer, busy mail, Ctrl-U draft clearing, Escape interrupt; no generated Ctrl-C |
| History | JSONL/chunks, rewind pruning, saved fork prefix; chat, search, activity and restore share the parser |
| Usage | Per-model raw input/output/cache-read tokens; known API rates marked `~`, unknown models tokens only |
| Models | Account TSV with offline snapshot; Flash low/medium/high, default Medium; Claude-on-agy has no effort |
| Grants | Real paths and private/common Git dirs on dispatch/resume/fork; git/network may require native reviewer bypass |
| Deliberately unavailable | Gemini CLI, agy Logins, containers, remote control, headless helpers, sandbox-mode UI, custom compaction thresholds |

Native plugin validation, exact tool names, root PID ancestry, auto availability,
worktree cwd/git behavior and instruction retention across resume/compaction
require the [human acceptance runner](../../../scripts/agy-human-acceptance.sh).
Fixture tests do not prove native behavior. See [Antigravity](../../../docs/antigravity.md).
