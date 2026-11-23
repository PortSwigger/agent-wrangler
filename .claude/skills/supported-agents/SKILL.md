---
name: supported-agents
description: Use when implementing any agent-facing feature, adding launch flags, asking what agents this codebase supports, or checking whether a new capability needs to cover multiple agents.
---

# Supported agents

## Overview

Agent Wrangler launches three agents — **Claude**, **Codex** and **agy** (Google's Antigravity CLI) —
behind a shared adapter registry (`server/agents/index.js`). Each agent has its own adapter file
(`server/agents/claude.js`, `server/agents/codex.js`, `server/agents/agy.js`) that owns
command-building, process detection, live-state reading, and cost parsing. The shared machinery (graph reconciliation, card-id handling, tmux, `classify()`)
is agent-agnostic and imports *from* the agents layer, never the reverse.

A fourth adapter, **Gemini CLI** (`server/agents/gemini.js`), is registered only to read the
conversations its old sessions left: chat, usage and search, model pills, labels and icons. agy
replaced it. It has `dispatchable: false`, no build functions and no `headless`, so nothing starts,
resumes, forks or adopts it, and `launchAgentError` refuses it wherever an agent id is launch input.
New features don't need a Gemini CLI side.

When adding an agent-facing feature, check every adapter file. If the feature needs
agent-specific wiring, implement it in each (or document the gap) before the work is done. Capabilities that are
truly agent-agnostic belong in the shared layer and don't need adapter changes.

## Capability differences

These are stable conceptual differences. For current mechanisms, read the adapter files directly.

| Capability | Claude | Codex | agy |
|---|---|---|---|
| Hooks | PostToolUse/Bash hooks injected at launch | None — status is pane-scraped (working/idle only; no needs-you) | SessionStart hook in the board's plugin folder (records the conversation id, injects instructions); status is pane-scraped (working, needs-you, idle) |
| Session ID | Preset before launch; Agent Wrangler knows it immediately | Discovered post-launch by polling the Codex sessions directory | Minted by agy: the SessionStart hook records it, else the newest conversation begun in the launch folder |
| MCP identity | Can send a custom header per request | Cannot set arbitrary headers; uses a bearer token from an env var | Stdio bridge (`agy-mcp-bridge.js`) adds the bearer from `$AW_SESSION_TOKEN`; agy expands no variables in MCP headers |
| System prompt injection | Dedicated CLI flag | Config key injected as a developer-role message | None: the SessionStart hook injects them as a system message on a conversation's first start |
| Skills delivery | Per-launch plugin dir (cwd-independent) | Text catalog injected at launch; skill files read on demand via absolute path | Text catalog in the SessionStart system message, as Codex |
| Slash-command plugins | Yes | No — MCP tools are the parity layer | No — MCP tools are the parity layer |
| OS sandbox | None | `workspace-write` seatbelt: writes only to cwd, tmp, memory dir, each `--add-dir`; the launch cwd's git common dir is auto-granted (session-manager) | None (agy's `--sandbox` is not used); permission mode Auto is agy's own auto mode, whose reviewer approves safe commands |

agy 1.5.13 takes no MCP servers or hooks on its command line (`--settings` rejects both keys), so
every launch adds a board-owned folder (`~/.agent-wrangler/agy/root`, `server/agents/agy-config.js`)
with `--add-dir`; agy loads the plugin in its `.agents/plugins/agent-wrangler/` (the MCP bridge and
the SessionStart hook). agy sorts its workspaces by path and may report that folder as its cwd, so
the instructions name the real working directory. `--settings` (this session only) carries the
launch folder's trust and `mcp(agent-wrangler/<tool>)` grants, merged with the user's own entries.
Conversations are SQLite (`~/.gemini/antigravity-cli/conversations/<id>.db`, protobuf steps);
`agy-db.js` mirrors each to append-only JSONL under `~/.agent-wrangler/agy/transcripts/`, and every
reader (chat, search, usage, transcript tool) reads the mirror. agy has no fork: its `/fork` switches
the running pane to the copy, so `buildFork` is absent and the board hides Fork (`providerMetadata().fork`).

The registry owns enumeration and validation. Only an absent historical provider defaults to
Claude; explicit unknown ids (including an empty string) are rejected before parsing or launching.
History scanners, file/chain discovery, search extraction and usage scans are adapter capabilities.
Browser labels, icons, cost estimates, model switching, compaction presets and the Codex policy
row come from the same metadata; unavailable providers can still label historical conversations. The registered providers
are Claude, Codex, agy and the read-only Gemini CLI; `dispatchableAgents()` is the first three, and
the dispatch picker, `host.agents.list()`, the MCP tools' agent and model lists and the generated
spawn-session table read it.

| Additional capability | Claude | Codex | agy |
|---|---|---|---|
| History | Project transcripts with branch pruning | Validated rollout continuation chains | SQLite steps mirrored to JSONL; a step is written once settled, again if it changes; `rewindTo` marks dropped steps |
| Active-turn mail | Cross-session socket; pane fallback waits for idle | Pane input with clear-composer and dialog guards | Pane input once idle |
| Live model switch | Guarded `/model` command | Launch-time selection only | Launch-time selection only (model and effort) |
| Usage | Timestamped usage with fork bounds | Estimated API-equivalent spend; calendar allocation by creation day | Estimated API-equivalent spend per reply (uncached input, cache reads, output incl. thinking) |
| Directory grants | Stable task-memory symlink | Real paths plus private/common Git metadata | Real paths as `--add-dir`, plus the board's plugin folder |
| Review selection priority | First | Second | Third |

## Capability flags, not id checks

Extensions read what an agent can do from `host.agents.list()` (`server/agents/listing.js`
`agentCapabilities`), never from its id. Each flag is read off an adapter field, so a new
adapter sets the field rather than anyone adding its id to a list:

| Flag | Adapter field | Claude | Codex | agy |
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
field: `defaultModel()`, `command({ prompt, stdin, model, effort, env, cwd })` → `{ file, args, env,
stdin?, liveSessionId? }`, and `parse(stdout)` → `{ text, liveSessionId?, error? }`. The payload goes on
stdin. Claude runs `claude -p` with its tools disallowed and a fresh `--session-id`; Codex runs
`codex exec --json` read-only with its tool features disabled, reporting its id in `thread.started`;
agy ignores stdin when given `-p <prompt>`, so it returns `stdin` (payload, then prompt) and runs
`agy --output-format json` on that piped prompt with every tool denied by a session permission rule,
default model Gemini 3.8 Flash at low effort.
With no model named a run uses Settings › Background model (`backgroundModel()`, default: the first
headless adapter's `defaultModel()`, Claude Haiku). Archive review and `host.agents.headless` both
go through it. A run by another agent than the card's own is billed through `billedRuns` and priced
by that agent's usage scanner (`server/billed-runs.js`).

## Adding a provider

A new provider is one adapter file in `server/agents/` plus one line in `allAgents()`
(`server/agents/index.js`). Nothing outside `server/agents/` compares agent ids: shared code
reads the fields below, so a check like `agent === 'codex'` anywhere else is a bug. Copy the
nearest of `claude.js`/`codex.js`/`agy.js` and fill in every field (prices: add the provider to
`PROVIDERS` in `server/price-catalog.js`, its rows to the snapshot via `npm run gen:catalog`, and a
cost function to `server/pricing.js`); an optional field left out means
"no", never "behave like Claude".

**Identity and models**
- [ ] `id`, `label`, `tmuxPrefix` (unique, e.g. `gm_`), `reviewPriority` (lower is picked first for a review)
- [ ] `models` (`value`, `label`, `pillLabel`, `transcriptPrefixes`, `contextWindow`, one `default: true`) and `efforts` (or `effortsForModel(model)`)
- [ ] `modelId(value)` when a launch value is an alias, and `contextWindow(model)` when the window is read rather than carried on `models`
- [ ] `autoEffortResolver(paths)` for the "auto" effort (null when unknown; any file it reads goes in `defaultSourcePaths` in `auto-effort.js`, which `sourcesSignature` watches), `modelCommand(model)` when the TUI switches model live
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

Every adapter implements `buildLaunch`, `buildResume`, and `buildFork` (agy has no fork, so it
leaves `buildFork` out and the board offers none). A feature wired in one must be wired in all
three — omitting resume or fork is the most common gap.

## Key files

- `server/agents/claude.js`, `server/agents/codex.js`, `server/agents/agy.js` — the adapters
- `server/agents/gemini.js`, `server/agents/gemini-*.js` — the read-only Gemini CLI adapter: conversation files, transcript reader and usage
- `server/agents/agy-*.js` — agy's protobuf reader, SQLite reader and JSONL mirror, transcript reader, usage, plugin folder, SessionStart hook and MCP bridge
- `server/agents/index.js` — registry and provider metadata; `adapterFor(entry.agent)` selects by the mapping field (`absent → claude`; unknown explicit ids throw)
- `server/mcp/client-config.js` — MCP config helpers for the agents; `ALLOWED_TOOLS` list
- `server/memory-store.js` — prompt constants and path helpers shared by the adapters

## Red flags — STOP

- A new feature only touches one adapter file
- "Codex doesn't support X" used to skip the Codex side without documenting the gap or providing an MCP-tool alternative
- Feature wired in `buildLaunch` but not in `buildResume` or `buildFork`
