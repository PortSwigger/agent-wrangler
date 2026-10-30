# Antigravity capability dispositions

This matrix covers every inventory §13 item. **Support** means implemented on the listed shared or agy-specific path, exercised with fakes where tests are named. It is not a native acceptance tick. **Replace** names a narrower explicit workflow. **Decline** names an unavailable interface. All native claims remain pending the human acceptance runner and board checks.

The automated evidence is `server/agents/agy.test.js`, `server/agents/agy-history.test.js`, `server/agy-plugin.test.js`, `server/agy-integration.test.js`, `server/agy-terminal.test.js`, `server/price-catalog.test.js`, and `scripts/gen-catalog-agy.test.js`. Existing-provider suites cover shared terminal and lifecycle behavior. Cross-cutting scenarios combine that coverage; they are not claims that every native variant has been tested.

## 1. Launch a CLI reliably and control its environment

| Capability / scenario | Disposition | Path or boundary |
| --- | --- | --- |
| Strip environment leakage; preserve independent conversation persistence | Support; native pending | agy.js; agy.test.js; session-manager.js |
| Identify the card and launch lineage | Support; native pending | agy.js; agy.test.js; session-manager.js |
| Attribute external artifacts to sessions | Support; native pending | agy.js; agy.test.js; session-manager.js |
| Identify session for MCP | Support; native pending | agy.js; agy.test.js; session-manager.js |
| Prevent unintended authentication/config overrides | Support; native pending | agy.js; agy.test.js; session-manager.js |
| Inject provider configuration without breaking core policy | Support; native pending | agy.js; agy.test.js; session-manager.js |
| Deliver the initial prompt intact | Support; native pending | agy.js; agy.test.js; session-manager.js |
| Preserve arbitrary prompts and paths | Support; native pending | agy.js; agy.test.js; session-manager.js |
| Establish a predictable terminal surface | Support; native pending | agy.js; agy.test.js; session-manager.js |
| Launch long prompts/configurations | Support; native pending | agy.js; agy.test.js; session-manager.js |
| Launch in the intended workspace | Support; native pending | agy.js; agy.test.js; session-manager.js |
| Honor workspace choice | Support; native pending | agy.js; agy.test.js; session-manager.js |
| Find binaries under service launch | Support; native pending | agy.js; agy.test.js; session-manager.js |
| Avoid nesting and installation leakage | Support; native pending | agy.js; agy.test.js; session-manager.js |
| Advertise usable providers and fail clearly | Support; native pending | agy.js; agy.test.js; session-manager.js |
## 2. Trust, permissions, sandbox access, and startup prompts

| Capability / scenario | Disposition | Path or boundary |
| --- | --- | --- |
| Select and retain permission behavior | Support; native pending | agy-lifecycle.js; agy-trust.js; agy-pane.js; agy-integration.test.js |
| Configure autonomy and network | Support; native pending | agy-lifecycle.js; agy-trust.js; agy-pane.js; agy-integration.test.js |
| Translate policy into valid CLI arguments | Support; native pending | agy-lifecycle.js; agy-trust.js; agy-pane.js; agy-integration.test.js |
| Trust workspace unattended | Support; native pending | agy-lifecycle.js; agy-trust.js; agy-pane.js; agy-integration.test.js |
| Safely modify shared provider state | Support; native pending | agy-lifecycle.js; agy-trust.js; agy-pane.js; agy-integration.test.js |
| Trust generated workspaces | Support; native pending | agy-lifecycle.js; agy-trust.js; agy-pane.js; agy-integration.test.js |
| Carry authorized trust to isolated checkouts | Support; native pending | agy-lifecycle.js; agy-trust.js; agy-pane.js; agy-integration.test.js |
| Keep trust consistent across logins | Decline | Default login only; agy Logins are unavailable. |
| Control automatic trust setup | Support; native pending | agy-lifecycle.js; agy-trust.js; agy-pane.js; agy-integration.test.js |
| Let a sandboxed agent commit | Support; native pending | agy-lifecycle.js; agy-trust.js; agy-pane.js; agy-integration.test.js |
| Grant task memory and follow reassignment | Support; native pending | agy-lifecycle.js; agy-trust.js; agy-pane.js; agy-integration.test.js |
| Retain workspace reach | Support; native pending | agy-lifecycle.js; agy-trust.js; agy-pane.js; agy-integration.test.js |
| Detect needs-you; avoid unsafe Enter | Support; native pending | agy-lifecycle.js; agy-trust.js; agy-pane.js; agy-integration.test.js |
| Detect needs-you across CLI versions | Support; native pending | agy-lifecycle.js; agy-trust.js; agy-pane.js; agy-integration.test.js |
| Preserve sessions awaiting authentication | Support; native pending | agy-lifecycle.js; agy-trust.js; agy-pane.js; agy-integration.test.js |
| Detect needs-you; avoid unintended consent | Support; native pending | agy-lifecycle.js; agy-trust.js; agy-pane.js; agy-integration.test.js |
| Detect needs-you; prevent accidental self-update | Decline | Modal input guards apply; no agy self-update menu driver is implemented. |
| Track provider self-update lifecycle | Replace | Record discovered CLI version; updater lifecycle has no captured contract and is not driven. |
| Detect needs-you for modal operations | Support; native pending | agy-lifecycle.js; agy-trust.js; agy-pane.js; agy-integration.test.js |
## 3. Discover processes and bind the right conversation

| Capability / scenario | Disposition | Path or boundary |
| --- | --- | --- |
| Detect provider processes | Support; native pending | agy-hooks.js; agy-summaries.js; agy-plugin.test.js |
| Find the process behind a terminal | Support; native pending | agy-hooks.js; agy-summaries.js; agy-plugin.test.js |
| Discover remote/container launches | Decline | Local only; nonlocal runtime dispatch is refused. |
| Establish terminal ownership | Support; native pending | agy-hooks.js; agy-summaries.js; agy-plugin.test.js |
| Bind conversation to durable card | Support; native pending | agy-hooks.js; agy-summaries.js; agy-plugin.test.js |
| Match workspace to transcript | Support; native pending | agy-hooks.js; agy-summaries.js; agy-plugin.test.js |
| Avoid stale conversation capture | Support; native pending | agy-hooks.js; agy-summaries.js; agy-plugin.test.js |
| Keep concurrent session identities distinct | Support; native pending | agy-hooks.js; agy-summaries.js; agy-plugin.test.js |
| Find resumed conversation files | Support; native pending | agy-hooks.js; agy-summaries.js; agy-plugin.test.js |
| Discover actual running sessions | Support; native pending | agy-hooks.js; agy-summaries.js; agy-plugin.test.js |
| Discover team members without phantom cards | Decline | Native children are represented as subagents; no agy multi-pane team feature is implemented. |
| Represent multi-pane agent teams | Decline | Native children use subagent rows; no agy team-pane orchestration. |
| Derive live labels and readiness | Support; native pending | agy-hooks.js; agy-summaries.js; agy-plugin.test.js |
| Keep meaningful session labels | Support; native pending | agy-hooks.js; agy-summaries.js; agy-plugin.test.js |
| Obtain concise board titles | Support; native pending | agy-hooks.js; agy-summaries.js; agy-plugin.test.js |
| Track conversation replacement | Support; native pending | agy-hooks.js; agy-summaries.js; agy-plugin.test.js |
| Adopt external conversation safely | Support; native pending | agy-hooks.js; agy-summaries.js; agy-plugin.test.js |
## 4. Resume, fork, stop, suspend, and recover

| Capability / scenario | Disposition | Path or boundary |
| --- | --- | --- |
| Resume the intended history | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
| Resume after workspace deletion | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
| Distinguish continue from branch | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
| Preserve exact fork history | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
| Branch conversation without stopping parent | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
| Wake with a prompt; retain launch policy | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
| Wake with a prompt | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
| Serialize session relaunch | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
| Stop the intended session without orphaning/killing siblings | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
| Stop a turn and restore its prompt | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
| Restore accurate input | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
| Recover human prompt rather than CLI plumbing | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
| Restore from large transcripts | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
| Replace interrupted input without clobbering unrelated drafts | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
| Stop sessions without wedging host terminals | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
| Surface failed launches and recover | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
| Recover from provider self-update | Replace | Generic failed-pane/resume recovery; no agy updater automation. |
| Recover a launch that never created a conversation | Replace | No root identity means resume is refused; do not select history by cwd or last-conversation cache. |
| Avoid suspending fresh launches | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
| Preserve background work | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
| Close sessions with background-job awareness | Support; native pending | session-manager.js; agy-history.js; agy-integration.test.js |
## 5. Read live status, readiness, model and context

| Capability / scenario | Disposition | Path or boundary |
| --- | --- | --- |
| Detect working/idle/needs-you safely | Support; native pending | agy-pane.js; agy-hooks.js; agy-history.js |
| Distinguish turn work from background jobs | Support; native pending | agy-pane.js; agy-hooks.js; agy-history.js |
| Detect active turn from terminal | Support; native pending | agy-pane.js; agy-hooks.js; agy-history.js |
| Detect turn state beyond spinner scraping | Support; native pending | agy-pane.js; agy-hooks.js; agy-history.js |
| Read live status from large rollouts | Support; native pending | agy-pane.js; agy-hooks.js; agy-history.js |
| Detect a failed turn requiring attention | Support; native pending | agy-pane.js; agy-hooks.js; agy-history.js |
| Offer appropriate recovery action | Support; native pending | agy-pane.js; agy-hooks.js; agy-history.js |
| Detect context maintenance | Support; native pending | agy-pane.js; agy-hooks.js; agy-history.js |
| Expose next-prompt suggestions without mislabeling drafts | Decline | agy has no captured ghost suggestion; return no suggestion. |
| Distinguish suggestion from placeholder | Decline | agy returns no ghost suggestion; framed draft parsing remains conservative. |
| Detect composer ready/empty across escape variants | Support; native pending | agy-pane.js; agy-hooks.js; agy-history.js |
| Detect input surface rather than arbitrary cursor glyph | Support; native pending | agy-pane.js; agy-hooks.js; agy-history.js |
| Protect drafts while detecting readiness | Support; native pending | agy-pane.js; agy-hooks.js; agy-history.js |
| Read pending human input safely | Support; native pending | agy-pane.js; agy-hooks.js; agy-history.js |
| Display current live model | Support; native pending | agy-pane.js; agy-hooks.js; agy-history.js |
| Display actual context occupancy | Support; native pending | agy-pane.js; agy-hooks.js; agy-history.js |
| Explain working context budget | Support; native pending | agy-pane.js; agy-hooks.js; agy-history.js |
| Configure automatic compaction | Decline | No captured agy threshold interface; omit custom compaction controls. |
| Keep live state fresh without fd exhaustion | Support; native pending | agy-pane.js; agy-hooks.js; agy-history.js |
## 6. Deliver text, mail, and images without corrupting input

| Capability / scenario | Disposition | Path or boundary |
| --- | --- | --- |
| Deliver arbitrary multiline text as one block | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Submit after input is absorbed | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Submit prompts ending in escape characters | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Deliver after startup without silent loss | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Confirm delivery and repair safely | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Deliver through context-maintenance transitions | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Deliver notifications without clobbering drafts | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Deliver guidance during a turn | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Deliver mail without terminal input | Replace | Durable mailbox tools are supported; no agy cross-session socket. Notifications use guarded pane delivery. |
| Enable unattended peer messaging | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Avoid provider dedup swallowing mail wake-ups | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Make mailbox tools available before mail prompt | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Reliably nudge durable mailbox recipients | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Attach browser images | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Preserve image attachment semantics | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Submit images and prose in the same turn | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Attach images with provider-specific readiness | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Make uploaded files accessible | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Attach images on dispatch or dormant resume | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Normalize image input formats | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
| Deliver ordered attachments | Support; native pending | pane-ready.js; mailbox-delivery.js; message-delivery.js; agy-integration.test.js |
## 7. Read conversation history and normalize provider formats

| Capability / scenario | Disposition | Path or boundary |
| --- | --- | --- |
| Locate native conversation history | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Find newly materialized/rotated history | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Prevent wrong-thread history | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Show full resumed conversation | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Incremental chat across transcript continuations | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Pair tool activity across polls | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Show useful history from large transcripts | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Exclude transport copies and injected instructions | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Normalize roles and content | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Preserve original pasted text in chat/search/titles | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Normalize commands without leaking tag soup | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Show queued human input exactly once | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Identify real human dialogue | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Represent useful automatic instructions | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Handle evolving transcript schemas | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Show tool calls/results and edit counts | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Explain tool approval outcomes | Decline | Native permission/denial screens are recognized; detailed undocumented transcript denial schemas are not inferred. |
| Represent reasoning without fabricating text | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Expose end-of-turn recap and next action | Decline | No captured agy recap schema; do not fabricate recap or next action. |
| Show current conversation branch | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Preserve history through compaction | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Reflect retroactive transcript changes | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Display attachments without helper-text noise | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Confirm submitted prompts without stuck duplicates | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Distinguish automation from human input | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Search durable conversation history | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Discover and index conversations | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Report actual work within a time range | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
| Read another session's context | Support; native pending | agy-history.js; agy-history.test.js; agy-integration.test.js |
## 8. Usage, cost, models, effort and native subagents

| Capability / scenario | Disposition | Path or boundary |
| --- | --- | --- |
| Account tokens once per request | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Account multi-model calls correctly | Decline | Use per-step model fields only; missing/unknown model remains tokens-only, with no guessed attribution. |
| Price provider cache token categories | Decline | Observed input/output/cache-read only; no invented cache-write or TTL charges. |
| Avoid double-billing copied history | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Be explicit about billing uncertainty | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Account and show native subagents | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Detect native worker activity | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Explain native worker trace completeness | Decline | Show summaries-classified descendants and captured transcript fields only; native completeness is unverified. |
| Account native worker families | Decline | Summaries parentage accounts native descendants; advisor/TTL semantics without evidence are declined. |
| Account usage across resets and resumes | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Retain lifetime cost across resume files | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Normalize provider token categories | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Price mixed-model conversations | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Price context-dependent requests | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Present honest estimated cost | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Price changing model identifiers | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Keep pricing current and available offline | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Offer valid models and labels | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Offer valid models/efforts for installed CLI | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Work with old/absent provider versions | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Spawn/schedule a valid target provider | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Explain effective default effort | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Keep derived model/context/cost fresh | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Preserve historical spend | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Avoid lost or duplicated usage attribution | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Report temporal usage with known precision | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
| Provide consistent offline usage reporting | Support; native pending | agy-usage.js; price-catalog.js; gen-catalog-agy.test.js |
## 9. MCP, skills, hooks, and headless helpers

| Capability / scenario | Disposition | Path or boundary |
| --- | --- | --- |
| Connect and preapprove session tools | Support; native pending | agy-plugin.js; agy-hooks.js; agy-mcp-entry.js; agy-plugin.test.js |
| Supply reusable skills and mandatory guidance | Support; native pending | agy-plugin.js; agy-hooks.js; agy-mcp-entry.js; agy-plugin.test.js |
| Keep provider instruction scope correct | Support; native pending | agy-plugin.js; agy-hooks.js; agy-mcp-entry.js; agy-plugin.test.js |
| Automatically attach created PRs | Replace | Explicit set_links and existing PR discovery are available; uncorrelated agy PostToolUse output is never used to infer a PR. |
| Get reliable turn completion without losing user integrations | Support; native pending | agy-plugin.js; agy-hooks.js; agy-mcp-entry.js; agy-plugin.test.js |
| Preserve native user hook safely | Support; native pending | agy-plugin.js; agy-hooks.js; agy-mcp-entry.js; agy-plugin.test.js |
| Run small headless model jobs | Decline | No internal agy -p execution; existing helper providers remain explicit. |
| Isolate headless authentication and capabilities | Decline | No agy headless helper; interactive auth overrides are stripped. |
| Derive durable learnings without rebilling/repeating review | Decline | agy archive-review helper is unavailable. |
| Reuse provider login env for headless jobs | Decline | No agy login or headless support. |
## 10. Runtime and container adaptations

| Capability / scenario | Disposition | Path or boundary |
| --- | --- | --- |
| Prevent unsupported runtime/provider combinations | Replace | Retain shared lifecycle; agy local only. Nonlocal dispatch is refused. |
| Integrate alternate launch hosts honestly | Replace | Retain shared lifecycle; agy local only. Nonlocal dispatch is refused. |
| Reach host MCP/hooks from runtime | Decline | Local transport only; no agy nonlocal runtime implementation. |
| Make injected resources available in runtime | Decline | No agy container resource copy. |
| Execute copied provider hooks | Decline | No agy container hook copy. |
| Resume off-host conversations | Decline | No agy off-host resume. |
| Read runtime-local transcripts | Decline | Host history only; no agy container reader. |
| Read runtime-local status | Decline | Local hooks/panes only; no agy container status reader. |
| Track long runtime startup and failure | Replace | Retain shared lifecycle; agy local only. Nonlocal dispatch is refused. |
| Keep runtime task context fresh | Replace | Retain shared lifecycle; agy local only. Nonlocal dispatch is refused. |
| Reclaim runtime resources safely | Replace | Retain shared lifecycle; agy local only. Nonlocal dispatch is refused. |
## 11. Browser terminal, chat controls and remaining two-provider assumptions

| Capability / scenario | Disposition | Path or boundary |
| --- | --- | --- |
| Parse terminal output reliably | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
| Keep terminal rendering synchronized | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
| Support simultaneous terminal viewers | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
| Preserve full terminal input/status area | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
| Render provider emoji/spinners accurately | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
| Scroll and select text without changing CLI input | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
| Copy terminal text into browser clipboard | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
| Edit multiline CLI input from browser | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
| Recover terminal transport | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
| Switch model without corrupting input | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
| Represent live model separately from launch/default model | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
| Keep modal actions in correct surface | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
| Display unavailable reasoning honestly | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
| Present provider capabilities truthfully | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
| Register and display a third provider consistently | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
| Select independent review provider | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
| Keep provider messaging accurate | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
| Survive process-discovery failures | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
| Match interactive CLI performance under service launch | Support; native pending | provider metadata, shared terminal, agy-pane.js; agy-integration.test.js |
## Cross-cutting CLI test scenarios

| Capability / scenario | Disposition | Path or boundary |
| --- | --- | --- |
| Start agy from terminal, a service manager, inside Claude, inside Codex, and from a stale tmux server; record inherited env, actual cwd, native session id, persistence and executable discovery. | Support / explicit limits | Fixture coverage for implemented paths; native variants and service/account/renderer behavior require human checks. Containers, agy headless/login/updater helpers and unsupported schemas are declined. |
| Exercise fresh install/login, no credentials, expired auth, workspace trust, permission bypass, organization settings, theme/terms/onboarding, self-update menu/progress/exit, goal replacement and concurrent-conversation lock; a chat Send must never accidentally accept a default. | Support / explicit limits | Fixture coverage for implemented paths; native variants and service/account/renderer behavior require human checks. Containers, agy headless/login/updater helpers and unsupported schemas are declined. |
| Run long initial prompt (over 16 KB), multiline text, blank/image-only prose, leading hyphen, literal shell characters, tabs, Unicode/emoji, trailing backslash and literal escape-looking text; verify exact turn count and resulting prompt. | Support / explicit limits | Fixture coverage for implemented paths; native variants and service/account/renderer behavior require human checks. Containers, agy headless/login/updater helpers and unsupported schemas are declined. |
| Start two sessions in the same cwd simultaneously and a nested child while parent writes; prove discovery never assigns an already-owned conversation and distinguishes native id, board id, fork source, resume id and subagent ids. | Support / explicit limits | Fixture coverage for implemented paths; native variants and service/account/renderer behavior require human checks. Containers, agy headless/login/updater helpers and unsupported schemas are declined. |
| Resume before first turn, resume after cwd drift/deletion, fork before/after first prompt, resume fork after parent advances, clear/new conversation, rewind, compact, and multiple resume continuations; check history, labels, ids and cost remain attached correctly. | Support / explicit limits | Fixture coverage for implemented paths; native variants and service/account/renderer behavior require human checks. Containers, agy headless/login/updater helpers and unsupported schemas are declined. |
| Send during boot, model work, tool execution, background shell/monitor, compaction, draft typing, ghost suggestion, update menu and runtime bring-up; distinguish submitted, rejected and unknown outcomes, including dropped Enter and a competing paste. | Support / explicit limits | Fixture coverage for implemented paths; native variants and service/account/renderer behavior require human checks. Containers, agy headless/login/updater helpers and unsupported schemas are declined. |
| Test Escape, Ctrl-C once/twice, Ctrl-D, Ctrl-U on multiline drafts, Shift/Option-Enter, Cmd-word movement and clear-line; record idle/working/dialog semantics, prompt restoration and graceful termination separately. | Support / explicit limits | Fixture coverage for implemented paths; native variants and service/account/renderer behavior require human checks. Containers, agy headless/login/updater helpers and unsupported schemas are declined. |
| Verify automated mail/PR nudges preserve a terminal draft, don't accept ghost suggestions, can steer during a turn only if supported, and survive identical unread counts, reconnect, dormant wake and a fresh MCP handshake. | Support / explicit limits | Fixture coverage for implemented paths; native variants and service/account/renderer behavior require human checks. Containers, agy headless/login/updater helpers and unsupported schemas are declined. |
| Paste small/large/multiple images from browser clipboard, Finder/drop, HTML/data URL, HEIC/TIFF, and paths containing spaces; verify ordered actual model-visible attachments, not literal path-only text or late markers in next draft. | Support / explicit limits | Fixture coverage for implemented paths; native variants and service/account/renderer behavior require human checks. Containers, agy headless/login/updater helpers and unsupported schemas are declined. |
| Resize wide/narrow repeatedly, attach browser plus external terminal, change fonts, force same-size reattach, scroll/copy with mouse, and inspect Unicode widths/OSC title/hyperlink/clipboard behavior without leaking extra input. | Support / explicit limits | Fixture coverage for implemented paths; native variants and service/account/renderer behavior require human checks. Containers, agy headless/login/updater helpers and unsupported schemas are declined. |
| Exercise sandbox writes to cwd, linked worktree private/common Git dirs, external grants, symlinked roots, reassigned task memory, network and denied approvals; verify identical policy on launch/resume/fork. | Support / explicit limits | Fixture coverage for implemented paths; native variants and service/account/renderer behavior require human checks. Containers, agy headless/login/updater helpers and unsupported schemas are declined. |
| Connect MCP with explicit card identity and boot handshake; check tool approval behavior, extension tools, skill discovery/mandatory startup nudges and headless env selection for agy. | Support / explicit limits | Fixture coverage for implemented paths; native variants and service/account/renderer behavior require human checks. Containers, agy headless/login/updater helpers and unsupported schemas are declined. |
| Compare transcript rendering against native terminal: queued/absorbed/concatenated prompts, slash/bang commands, synthetic instructions, redacted reasoning, visible thought, recaps, tool calls/results/denials, raw custom patches and images. | Support / explicit limits | Fixture coverage for implemented paths; native variants and service/account/renderer behavior require human checks. Containers, agy headless/login/updater helpers and unsupported schemas are declined. |
| Check usage against controlled requests with multi-block output, cache read/write TTL, reasoning, advisor/mixed models, native subagents, cumulative resets, repeated counters, fork copies and multiple resume files; record billing-estimate limits. | Support / explicit limits | Fixture coverage for implemented paths; native variants and service/account/renderer behavior require human checks. Containers, agy headless/login/updater helpers and unsupported schemas are declined. |
| Change provider config/catalog/prices without writing new transcript data; ensure models, efforts, default effort, context windows, occupancy and cost invalidate correctly. Test old CLI without optional metadata subcommands. | Support / explicit limits | Fixture coverage for implemented paths; native variants and service/account/renderer behavior require human checks. Containers, agy headless/login/updater helpers and unsupported schemas are declined. |
| Delete/prune/rotate provider transcripts after indexing and usage caching; verify stale-path eviction, late file creation, permanent searchable history and retained raw historical tokens rather than frozen pre-priced dollars. | Support / explicit limits | Fixture coverage for implemented paths; native variants and service/account/renderer behavior require human checks. Containers, agy headless/login/updater helpers and unsupported schemas are declined. |
| Run the runtime matrix explicitly: local vs container/extension host, actual remote home/pid/cwd, callback reachability, copied skills/hooks/grants, status/transcript reads, image access and resource teardown. | Support / explicit limits | Fixture coverage for implemented paths; native variants and service/account/renderer behavior require human checks. Containers, agy headless/login/updater helpers and unsupported schemas are declined. |
| Audit all fallback validators and browser surfaces for third-provider routing: search facets, labels/icons, notifications, model menu gates, permissions/context/cost pills, fork help, complementary-review selection, headless env and standalone cost reports. | Support / explicit limits | Fixture coverage for implemented paths; native variants and service/account/renderer behavior require human checks. Containers, agy headless/login/updater helpers and unsupported schemas are declined. |
