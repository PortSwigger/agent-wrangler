# Antigravity CLI

Antigravity CLI (`agy`) is an experimental, local agent provider. Install and sign in to
agy yourself, then enable **Settings → Automation → Manage agy integration**. It defaults
to off. Antigravity appears in dispatch after the binary is on PATH and the managed
plugin is installed. Installation errors leave dispatch unavailable; existing history
remains readable. The service PATH must include your binary directory (for example
`/opt/homebrew/bin`). Gemini CLI is a different product and is unsupported.

## Integration footprint

Enabling the setting installs a versioned `agent-wrangler` plugin in
`~/.gemini/config/plugins/agent-wrangler` after the server is listening. Nothing installs
during package installation. An unchanged stamp avoids rewriting the plugin. Disabling
the setting removes only the plugin carrying Wrangler's ownership stamp. A disabled
startup does not write provider-global state.

The plugin has no always-on rules or globally installed skills. Its shell entrypoints
exit without effects outside a Wrangler card. Inside a card, SessionStart injects
instructions and an absolute-path skill catalog. A stdio bridge carries the card identity
to the local MCP server. The captured native hook envelope is `toolCall.name: call_mcp_tool`, with
`toolCall.args.ServerName` and `ToolName`. Approval requires the exact managed server
`agent-wrangler_agent-wrangler` and a currently registered tool, including extension tools.
The server namespace follows the [native plugin contract](https://antigravity.google/docs/plugins?tab=cli);
the human must confirm it on the installed version. No guessed `mcp__…` aliases,
payload substrings or other servers receive approval. During startup, only the native
`get_session_info` read is allowed; other tools are denied with an integration error.
Native naming and plugin loading need the human checks below. Wrangler does not replace global status lines, notifications,
permission allow-lists or user hooks.

**Skip Antigravity trust-folder prompts** is a separate setting, also off by default.
It adds only launch-folder trust entries to `~/.gemini/antigravity-cli/settings.json`,
preserving other keys and refusing malformed settings. It does not remove trust entries
when disabled. Leave it off to answer trust in the terminal. Provider rewrites can race
any shared settings writer; the writer re-reads before its atomic replacement.

## Dispatch, resume and fork

Choose **Antigravity** in dispatch. The bundled default is **Gemini 3.8 Flash** at
**Medium** effort. Flash offers Low, Medium and High; Claude models served through agy
accept no effort flag. Account-specific `agy models` discovery refreshes at runtime;
missing, signed-out or older CLIs retain the bundled model list. This is separate from
API pricing and never runs in the catalog-refresh Action.

Task text is retained on the card; it is never passed through `-i`. Launches use auto mode. Wrangler waits for a clear, framed composer, cycles Shift+Tab
with a bounded retry and verifies `auto` in the footer. A timeout or unsupported account
shows needs-you and holds automated delivery. Auto availability depends on the account;
check it in the terminal. Wrangler does not silently switch to full access. Permission,
trust, login, theme, terms, artifact review, survey and quota screens need your attention.
Unknown screens stay unknown and do not receive automated Enter.

At a clear idle composer Wrangler sends one fixed startup probe asking for native
`get_session_info` with empty arguments. This starts on-demand discovery without exposing
the task or draining mail. The probe forbids configuration searches and shell/Node/curl
repair. Readiness requires that read to succeed through the installed stdio entrypoint,
with the current card identity and fresh definitions for `get_session_info`, `read_mail`
and `rename_session`. The bridge process must belong directly to the current pane agy
process, or its native language-server child. A random launch identity and connection
generation exclude old sessions; a dead bridge cannot keep the gate open. An HTTP
handshake, `tools/list`, cached definitions, status hooks and the auto footer alone do
not establish readiness. A shell-imported bridge never establishes it.

After sign-in or delayed plugin loading, the existing board refresh retries the guarded
startup checks. It sends each startup probe and `/fork` at most once per launch. Once
the native read, root identity and clear composer are confirmed, the retained task is
sent once. Uncertain task or image submission stays visible and is never automatically
replayed, including after Resume. Inspect the terminal before manually resending it.

If tools remain unavailable, the card shows **needs-you**, with task and durable mail
retained. Complete sign-in and inspect the native **`/mcp` manager**. Google's
[MCP guide](https://antigravity.google/docs/mcp?tab=cli) describes manual configuration
reload there; it does not specify a portable `/mcp reload` command. Wrangler sends no
unverified reload shortcut and never chooses a permission option. After recovery, ask
agy to call native `get_session_info` with empty arguments again, or use **Resume** once
a root identity is known. No shell approval is required for a repair bridge because no
repair bridge is part of this workflow.

Transport failures invalidate native readiness. A later native request reconnects with
bounded connection/discovery timeouts; writes are never retried. A lost write response
has an unknown outcome: inspect its effect before making another call. Reconnection
requires another successful native `get_session_info` read before task/mail delivery.
Native reload, post-sign-in discovery, process ancestry and exact plugin naming remain
human probes, not conclusions from the fake client.

Additional folders use real paths. Both private and common Git metadata directories are
granted on launch, resume and fork. agy can choose a Git directory as its default cwd:
the injected instructions require an explicit workspace cwd. Git, network and localhost
commands may need `BypassSandbox: true`; agy's normal reviewer decides each retry.
This fallback and native cwd behavior need human validation. There is no global network
allow-list or command-rewriting permission workaround.

Resume reuses the native conversation and re-passes the saved launch model and effort.
The live model can differ after a guarded `/model` switch; switching does not change
the saved launch selection. Wake text follows the composer and current-process MCP
readiness checks. Wrangler replaces its own old pane on resume. Avoid opening the same
conversation separately in agy or another client: native agy permits divergent writers.
An accepted wake message is saved on the card and acknowledged as queued until readiness
allows one submission. A second wake cannot overwrite an unresolved retained task.

Fork opens the parent in a separate pane, sends `/fork` only at a clear composer, then
waits for a classified new root identity. The child's first prompt is held while binding
is pending. Wrangler saves an immutable copy of the parent's transcript prefix and exact
step before launch. Chat and search stitch that prefix to the child's new steps; parent
advances and rewinds do not change the saved prefix. Parent history is excluded from
child usage. A fork without recorded history is refused. The parent card is untouched.

Mail uses the durable mailbox. Pane notification waits for clear input and a current
native read on this launch; busy input can queue a notification. Drafts and dialogs defer it. Browser
Stop sends Escape, and restoring a prompt uses the same history parser as chat. Wrangler
never generates Ctrl-C for agy. Raw terminal keyboard input remains under your control.
Image delivery waits for agy's attachment-count marker; native image visibility still
needs human confirmation. Pane observations and pastes are not an atomic transaction.

## History and estimated usage

Hooks bind only from the card pane's agy process and only after the read-only summaries
DB classifies the conversation. Missing, locked or unfamiliar schemas stay pending.
Native children contribute usage but cannot set the root's model or status. Nested
print-mode processes cannot capture a card. Adoption lists omit rows classified as
children; external print-mode histories cannot be distinguished reliably from roots.
Wrangler does not use agy for internal headless helpers.

The parser supports the 1.4.10 JSONL transcript and chunk layout, known user wrappers,
rewind pruning, planner text, available reasoning, tool records and error notices.
Unknown record fields are ignored. Parsed steps and fork prefixes are retained under
Wrangler's data directory so readable history and raw usage survive source removal.
Native format changes and retention behavior require validation when upgrading agy.

Every dollar figure for agy is an **API-equivalent estimate**, marked `~`, rather than
Google plan, quota or credit charges. Known Gemini models use Gemini API rates; known
Claude-on-agy and matching OpenAI models use their vendors' published rates. Unknown
models show tokens only. A new model is never priced as a guessed sibling. Context
occupancy uses the latest root request's input tokens; the captured Flash window is
1,048,576 tokens. Child and historical request tokens do not inflate that percentage.

The existing **Refresh catalog snapshots** Action runs weekly and on manual dispatch.
Its `npm run gen:catalog` path refreshes Anthropic, OpenAI and first-party Gemini rates
from the LiteLLM feed, then regenerates the skill model table. CI never installs or runs
agy. Runtime rates refresh every 12 hours. Bundled and last-good cached rates work
offline; missing or malformed feed rows preserve historical rates. Price-only changes
recompute estimates without new transcript bytes. Cache writes are not inferred from
Anthropic multipliers for Gemini. Unpriced tokens are excluded from dollar totals.

## Human acceptance and boundaries

Run `bash scripts/agy-human-acceptance.sh plugin --dry-run` to preview the protocol.
A human runs it without `--dry-run` to validate the generated native plugin and record
sanitised results. It records the tested Git head and asks for explicit pass/fail results. Keep your dev
server on this PR build; the runner never stops or restarts it. Failures return to this
same PR. A tested build is ready for human trials while the PR remains open; manual
merge approval follows successful native trials.

Automated tests use temporary homes, fake binaries, SQLite and transcript/pane fixtures.
They do **not** prove native plugin validation, exact MCP naming, PID ancestry, auto-mode
activation, worktree git/cwd/network access, attachment visibility, or instruction retention
through resume/compaction. Complete the runner and board acceptance after installation.
If native names or schemas differ, keep normal approval and report the mismatch.

Support is Default-login and local-runtime only. agy Logins, devcontainers, remote control,
custom compaction thresholds, sandbox-mode selection UI, advisor/archive-review helpers,
quota billing and external desktop synchronization are unavailable. Independent review
selects the first available provider different from the source in Claude → Codex →
Antigravity order. See the [capability dispositions](antigravity-coverage.md) for the
complete inventory and validation limits.
