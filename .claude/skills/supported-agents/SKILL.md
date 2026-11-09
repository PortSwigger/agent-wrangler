---
name: supported-agents
description: Use when implementing any agent-facing feature, adding launch flags, asking what agents this codebase supports, or checking whether a new capability needs to cover multiple agents.
---

# Supported agents

## Overview

The wrangler supports three agents — **Claude**, **Codex** and **Gemini** (Google's Gemini CLI) —
behind a shared adapter registry (`server/agents/index.js`). Each agent has its own adapter file
(`server/agents/claude.js`, `server/agents/codex.js`, `server/agents/gemini.js`) that owns
command-building, process detection, live-state reading, and cost parsing. The shared machinery (graph reconciliation, card-id handling, tmux, `classify()`)
is agent-agnostic and imports *from* the agents layer, never the reverse.

When adding an agent-facing feature, check every adapter file. If the feature needs
agent-specific wiring, implement it in each (or document the gap) before the work is done. Capabilities that are
truly agent-agnostic belong in the shared layer and don't need adapter changes.

## Capability differences

These are stable conceptual differences. For current mechanisms, read the adapter files directly.

| Capability | Claude | Codex | Gemini |
|---|---|---|---|
| Hooks | PostToolUse/Bash hooks injected at launch | None — status is pane-scraped (working/idle only; no needs-you) | AfterTool (PR attach) and SessionStart hooks in the board's Gemini home settings; status is pane-scraped (working, needs-you, idle) |
| Session ID | Preset before launch; wrangler knows it immediately | Discovered post-launch by polling the Codex sessions directory | Preset (`--session-id`) |
| MCP identity | Can send a custom header per request | Cannot set arbitrary headers; uses a bearer token from an env var | Custom header from settings, `$AW_SESSION_ID` expanded by Gemini |
| System prompt injection | Dedicated CLI flag | Config key injected as a developer-role message | None: a SessionStart hook adds the instructions as `<hook_context>` (Gemini treats it as context, and the first turn of a launch with an intent can run before it lands) |
| Skills delivery | Per-launch plugin dir (cwd-independent) | Text catalog injected at launch; skill files read on demand via absolute path | Text catalog in the SessionStart context, as Codex |
| Slash-command plugins | Yes | No — MCP tools are the parity layer | No — MCP tools are the parity layer |
| OS sandbox | None | `workspace-write` seatbelt: writes only to cwd, tmp, memory dir, each `--add-dir`; the launch cwd's git common dir is auto-granted (session-manager) | None (Gemini's own `--sandbox` is not used); permission mode Auto is YOLO |

Gemini takes no settings on its command line and reads system settings only when root owns them, so
it runs with `GEMINI_CLI_HOME` pointing at the board's own Gemini home (`server/agents/gemini-config.js`):
the user's `settings.json` with the board's MCP server, hooks and folder-trust-off merged in, its own
`projects.json` and `tmp/`, and every other `~/.gemini` entry symlinked. `~/.gemini` is never written.
Never combine `--resume` with `--prompt-interactive`: Gemini 0.66 submits the prompt while the resume
is still loading and records it to a second, headerless file. A fork's prompt is typed in by
`gemini-fork.js` once the copy has opened.

The registry owns enumeration and validation. Only an absent historical provider defaults to
Claude; explicit unknown ids (including an empty string) are rejected before parsing or launching.
History scanners, file/chain discovery, search extraction and usage scans are adapter capabilities.
Browser labels, icons, cost estimates, model switching, compaction presets and the Codex policy
row come from the same metadata; unavailable providers can still label historical conversations. The registered providers
are Claude, Codex and Gemini.

| Additional capability | Claude | Codex | Gemini |
|---|---|---|---|
| History | Project transcripts with branch pruning | Validated rollout continuation chains | JSONL edit log (`$set`/`$patch`/`$rewindTo`); the scanner prunes rewinds, keeping a failed turn's prompt |
| Active-turn mail | Cross-session socket; pane fallback waits for idle | Pane input with clear-composer and dialog guards | Pane input once idle (startup hooks count as working) |
| Live model switch | Guarded `/model` command | Launch-time selection only | Launch-time selection only |
| Usage | Timestamped usage with fork bounds | Estimated API-equivalent spend; calendar allocation by creation day | Estimated API-equivalent spend per timestamped response; a fork bills from `forkedAt` |
| Directory grants | Stable task-memory symlink | Real paths plus private/common Git metadata | Real paths as `--include-directories` |
| Review selection priority | First | Second | Third |

## Capability flags, not id checks

Extensions read what an agent can do from `host.agents.list()` (`server/agents/listing.js`
`agentCapabilities`), never from its id. Each flag is read off an adapter field, so a new
adapter sets the field rather than anyone adding its id to a list:

| Flag | Adapter field | Claude | Codex | Gemini |
|---|---|---|---|---|
| `disallowedTools` | `supportsDisallowedTools` | yes | no | no |
| `remoteControl` | `supportsRemoteControl` | yes | no | no |
| `askUserTool` | `askUserTool` | `AskUserQuestion` | none | none |
| `sandbox` | `launch.codexPolicy` | no | yes | no |
| `mailWhileWorking` | `terminal.socketMail` | yes | no | no |
| `headless` | `headless` | yes | yes | yes |

A model's `resolved` full id comes from the adapter's `modelId(value)`; an adapter without one
launches by full id already.

## Headless one-shots

`server/headless.js` `runHeadless` runs a tool-less one-shot on any adapter with a `headless`
field: `defaultModel()`, `command({ prompt, model, effort, env, cwd })` → `{ file, args, env,
liveSessionId? }`, and `parse(stdout)` → `{ text, liveSessionId?, error? }`. The payload goes on
stdin. Claude runs `claude -p` with its tools disallowed and a fresh `--session-id`; Codex runs
`codex exec --json` read-only with its tool features disabled, reporting its id in `thread.started`;
Gemini runs `gemini -p -o json` with a fixed `--session-id`, no extensions or MCP servers and a policy
denying every tool (`server/agents/gemini-headless-policy.toml`), default model Gemini 3.1 Flash-Lite.
With no model named a run uses Settings › Background model (`backgroundModel()`, default: the first
headless adapter's `defaultModel()`, Claude Haiku). Archive review and `host.agents.headless` both
go through it. A run by another agent than the card's own is billed through `billedRuns` and priced
by that agent's usage scanner (`server/billed-runs.js`).

## Adding a provider

A new provider is one adapter file in `server/agents/` plus one line in `allAgents()`
(`server/agents/index.js`). Nothing outside `server/agents/` compares agent ids: shared code
reads the fields below, so a check like `agent === 'codex'` anywhere else is a bug. Copy the
nearest of `claude.js`/`codex.js`/`gemini.js` and fill in every field (prices: add the provider to
`PROVIDERS` in `server/price-catalog.js`, its rows to the snapshot via `npm run gen:catalog`, and a
cost function to `server/pricing.js`); an optional field left out means
"no", never "behave like Claude".

**Identity and models**
- [ ] `id`, `label`, `tmuxPrefix` (unique, e.g. `gm_`), `reviewPriority` (lower is picked first for a review)
- [ ] `models` (`value`, `label`, `pillLabel`, `transcriptPrefixes`, `contextWindow`, one `default: true`) and `efforts` (or `effortsForModel(model)`)
- [ ] `modelId(value)` when a launch value is an alias, and `contextWindow(model)` when the window is read rather than carried on `models`
- [ ] `autoEffortResolver(paths)` for the "auto" effort, `modelCommand(model)` when the TUI switches model live
- [ ] `isAvailable()` (binary on PATH), `unavailableMessage`, `launch.availabilityOverride` (optional)

**Launching**
- [ ] `buildLaunch`, `buildResume`, `buildFork` (all three; see below)
- [ ] `presetsSessionId` with `discoverLiveId(opts)` when the CLI mints its own conversation id, and `resumeCarriesIntent`
- [ ] `launch.grantPaths` (`'symlink'` or `'realpath'`), `launch.gitMetadataGrants`, `launch.recoverMissingConversation`
- [ ] `launch.trust`: a trust-store writer in session-manager's `LAUNCH_TRUST` (`'claude-config'`, `'codex-config'`), or none; a new store adds one writer there
- [ ] `launch.codexPolicy`: takes the sandbox/approval policy (the dispatch dialog shows its row from `controls.codexPolicy`, derived from this)
- [ ] `supportsRemoteControl`, `supportsDisallowedTools`, `headlessArchiveReview` (each `true` only when the CLI really has it; phone control stays gated on `supportsRemoteControl`)
- [ ] `matchProcess(command)`, `matchContainerized(command)`, `parseTeamMember(command)` (optional)

**Status and the pane** (`terminal`)
- [ ] `statusSource` (`'live-file'`, `'codex-rollout'`, anything else is pane-scraped) and `readLive()`
- [ ] `terminal.classify`, `readySignal` (`'title'` or `'composer'`), `composerIsReady`, `composerIsEmpty`, `composerDraft`, `composerMark`, `clearKeys`, `interruptKeys`, `editingKeys`
- [ ] `terminal.contextSource` (`'pane'` or `'analysis'`), `modelLabel`, `contextPercent`, `imageCount`, `suggestion`, `backgroundShellPattern`
- [ ] Flags: `paneMetadata`, `restoreDraft`, `socketMail`, `allowWhileWorking`, `imageAcknowledgement`, `autoBlock` (a `'waiting'` status may be the timed auto-mode check), `updatesOnExit` (a clean exit may be a self-update; read the pane before auto-archiving)

**History, cost and usage**
- [ ] `history`: `findFile`, `findFiles`, `directory`, `resolveResumeDir`, `launchCwd`, `createScanner`, `mightCarryChat`, `mightCarryText`, `extractLine`, `discoverSources`, plus `requiresResumeFile`, `continuations`, `forEachLine`, and `branches` (the transcript is a tree whose rewound branches `selectLive` prunes)
- [ ] `analyze(liveSid)` (or `graphAnalysis`), `listResumable`, `activityInRange`, `transcriptPath`, `subagentDetail` and `subagentDetailOverride`
- [ ] `usage`: `billingProviders`, `scanDaily`, `scanMonth`, `costUsd`, `unknownModelLabel`, and `catalogFamilies` (`{ provider, pattern }`, the price catalog's family/version pattern for its first-party ids) when model labels come from the catalog
- [ ] `labels` (`liveTitle`, `summaryFirst`), `presentation` (`icon`, `color`, `estimatedCost`), `controls` (`switchModel`, `modelSwitchNote`, `permissionModes`, `autoCompact`), `forkHelp`

**Prove it**
- [ ] Extend `server/agents/provider-capabilities.test.js`: its fixture provider drives the shared paths with no Claude fallback
- [ ] `git grep -nE "[!=]==? *['\"](claude|codex)['\"]" -- server public ':!server/agents/' ':!*.test.js'` still prints nothing
- [ ] Add a column to the capability tables above

## Three launch sites

Every adapter implements `buildLaunch`, `buildResume`, and `buildFork`. A feature wired in
one must be wired in all three — omitting resume or fork is the most common gap.

## Key files

- `server/agents/claude.js`, `server/agents/codex.js`, `server/agents/gemini.js` — the adapters
- `server/agents/gemini-*.js` — Gemini's home and settings, conversation files, transcript reader, usage, fork helper and SessionStart hook
- `server/agents/index.js` — registry and provider metadata; `adapterFor(entry.agent)` selects by the mapping field (`absent → claude`; unknown explicit ids throw)
- `server/mcp/client-config.js` — MCP config helpers for the agents; `ALLOWED_TOOLS` list
- `server/memory-store.js` — prompt constants and path helpers shared by the adapters

## Red flags — STOP

- A new feature only touches one adapter file
- "Codex doesn't support X" used to skip the Codex side without documenting the gap or providing an MCP-tool alternative
- Feature wired in `buildLaunch` but not in `buildResume` or `buildFork`
