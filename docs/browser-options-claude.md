# Browser options for Claude Code workers

Which ways of driving a browser launch and work from a Claude Code worker in
**auto mode** (`permissions.defaultMode: "auto"`, so the classifier decides) with no
permission prompt and no denial. Tested on 15 Nov 2026 on macOS (arm64), Claude Sonnet 5.5, with
the user's own `~/.claude/settings.json` and no extra allow rules for browsers. The Codex view is a
separate investigation (hive-c8dh); each agent can only test its own sandbox and approval behaviour.

## Results

Every option below was exercised end to end: launch, load a page, click a button, read the result,
take a screenshot. "No prompt" means no permission dialog and no classifier denial appeared. No
permission was denied at any point, and no browser crashed or showed a crash dialog.

| Option | Launches | Claude auto mode, no prompt | Allow rule needed | Core browser tests | Hive screenshots | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| `chrome-devtools` MCP against the user's running Chrome | yes | yes | none (the MCP tools ran unprompted) | no: a tool for the agent, not a binary for `CHROME_BIN` | yes: `take_screenshot` with `filePath` | none to install; see the privacy note |
| Playwright MCP plugin (`mcp__plugin_playwright_playwright__*`) | yes | yes | none | no | yes: `browser_take_screenshot` | none; its browser lives in the shared Playwright cache |
| Playwright Chromium (`playwright-core` 1.56.1, installed under `.scratch`) | yes, ~2-3 s | yes | none | yes via `CHROME_BIN` | yes: `page.screenshot` | 299 MB |
| Playwright Chromium headless shell | yes, ~2 s | yes | none | yes via `CHROME_BIN` | yes | 178 MB |
| Chrome for Testing (`@puppeteer/browsers install chrome@stable`, v157) | yes, ~3 s | yes | none | yes via `CHROME_BIN` | yes | 375 MB |
| Installed Google Chrome (Playwright `channel: 'chrome'`, or the default of `findChrome()`) | yes, ~0.5 s | yes | none | yes, no setup | yes | 0 |
| Playwright Firefox 142 | yes, ~3.6 s | yes | none | no: needs CDP | yes | 248 MB |
| Playwright WebKit 26 | yes, ~7.7 s | yes | none | no: needs CDP | yes | 271 MB |
| `rodney` CLI | not installed (`which rodney` is empty); not tested | n/a | n/a | n/a | n/a | n/a |

Downloads ran without a prompt too: `npm i playwright-core`, `npx playwright-core install ...` and
`npx @puppeteer/browsers install ...` all ran in the worktree's `.scratch` (git-excluded) under auto
mode. The 15 Nov approval covered downloading browsers; nothing here needs a standing rule.

## Core browser tests

`server/browser-harness.js` finds Chrome by `CHROME_BIN`, then the installed Google Chrome, and
drives it over raw CDP. These suites passed with each Chromium-family binary, with
`AW_BROWSER_TESTS=1 AW_REQUIRE_BROWSER=1 npm test -- <file>`:

| `CHROME_BIN` | `ext-api.test.js` | `board-acceptance.test.js` |
| --- | --- | --- |
| Chrome for Testing | 1 pass, 3.4 s | 4 pass, 7.4 s |
| Playwright headless shell | 1 pass, 2.9 s | 4 pass, 7.4 s |
| Playwright Chromium | 1 pass, 3.4 s | 4 pass, 7.9 s |
| installed Google Chrome (unset) | 1 pass, 3.0 s | 4 pass, 8.0 s |

Firefox and WebKit cannot back these tests: the harness speaks CDP. Playwright's Firefox and WebKit
builds only serve Playwright's own protocol, which suits cross-engine checks of the board UI but not
the existing harness.

Playwright 1.56.1 resolved an older Chromium build (v141) than the system Chrome (v157). Pin the
version if a test depends on a recent browser feature.

## Things to know

- **Privacy of the running Chrome.** `chrome-devtools` MCP lists every tab in the user's real
  browser (mail, calendar, spreadsheets, Jira) in `list_pages` and `new_page` output, and can read or
  drive any of them. It ran with no prompt, so nothing stops a worker from touching those tabs.
  Always open a page with `isolatedContext` and only act on that page's `pageId`. Close it
  afterwards. This is a convention, not an enforced boundary.
- **Tool schemas.** The MCP tools are deferred: load them with `ToolSearch` first. `take_snapshot`
  and `take_screenshot` require a numeric `pageId`; `playwright` `browser_click` takes `target`
  (a snapshot ref or a selector), not a description.
- **Stray files.** The Playwright MCP writes `.playwright-mcp/` snapshots into the working directory
  (already git-ignored) and `browser_take_screenshot` writes relative to it, so pass a path under
  `.scratch`.
- **Shared cache.** `~/Library/Caches/ms-playwright` already holds Chromium 1208 and many
  `mcp-chrome-*` profile directories from earlier sessions. Set `PLAYWRIGHT_BROWSERS_PATH` to a
  `.scratch` folder, as here, to keep a worker's install out of it.
- **Leaving the worktree.** Nothing here touched the user's Chrome profile or policy, Claude or
  Codex settings, the live checkout or port 7777.

## Recommendation

1. **Core browser tests: use the installed Google Chrome** (no `CHROME_BIN`). It needs no download,
   starts fastest and passed everything. Where it is missing, point `CHROME_BIN` at a Chrome for
   Testing build from `@puppeteer/browsers`, whose version is pinned. CI uses the runner's
   `google-chrome-stable`.
2. **Interactive checks and Hive screenshots: use the `chrome-devtools` MCP in an `isolatedContext`.**
   It needs no install, no rule and no prompt, and gives snapshots, clicks, console and network. Treat
   the isolation rule above as mandatory. Use Playwright Chromium (headless shell is enough, and
   smallest) for scripted or repeatable captures that must not share a browser with the user.
3. **Do not install Firefox or WebKit by default.** They add about 520 MB and cannot run the core
   tests. Install them only for a specific cross-engine bug.
4. **No settings change is needed for Claude.** If the user wants the isolation rule enforced rather
   than conventional, propose a `PreToolUse` hook that rejects `chrome-devtools` `select_page`,
   `take_*` and `evaluate_script` calls whose `pageId` is not one the session opened. This is only a
   proposal.

Against the Codex findings (hive-c8dh): this view says every option works for Claude with no rule,
so any difference there comes from Codex's sandbox, not from the browsers. Where Codex needs an
approval or an allow-rule for an option that needs none here, prefer the option that works in both
agents: the installed Chrome or Chrome for Testing over `CHROME_BIN`, and Playwright Chromium for
scripted captures.
