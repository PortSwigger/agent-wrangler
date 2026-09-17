# Per-session auto-compaction budget

## Goal

Let a session opt into an auto-compaction threshold without changing the default behaviour of any existing or newly-created session that leaves it unset.

## Session model

Persist an optional `autoCompactTokens` integer on the mapping entry. It is launch configuration, not mutable runtime state: a session keeps its selected threshold for its lifetime. A fork copies the parent's value; a resume carries it forward and reapplies it to the new CLI process.

The server accepts only integers from 100,000 through 1,000,000 inclusive. Omission is valid and is persisted as absent/null only where the existing mapping convention requires it; command builders must receive no provider-specific setting when it is absent.

## Provider adapters

Claude receives `--autocompact <tokens>` on launch, resume, and fork. Codex receives `-c model_auto_compact_token_limit=<tokens>` on those same paths. Neither adapter changes model context-window configuration.

## Entry points

The dispatch dialog exposes the setting in Advanced options as an optional working-context/auto-compaction threshold. The WebSocket dispatch path, scheduling path, and `spawn_session` MCP tool share server validation. `spawn_session` accepts `auto_compact_tokens`; it is intentionally the future persona/extension integration point.

Fork has no override control and inherits the source session. No command/API changes an existing session's threshold after creation.

## Compatibility and testing

Legacy mappings lacking the property remain valid. Unset dispatches produce the exact existing provider commands. Tests cover validation, adapters, mapping persistence, dispatch/spawn plumbing, resume, fork inheritance, and the normal omitted/default paths.

## Extensions API

Extensions can use the documented `spawn_session.auto_compact_tokens` opt-in surface. The `onBeforeDispatch` payload also exposes the selected `autoCompactTokens` value (or `null` when unset), alongside the other launch settings; it is informational and cannot alter the launch or persisted threshold.
