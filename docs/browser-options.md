# Browser options for Codex workers

## Recommendation

Use a scratch-local Chrome Headless Shell for browser tests, launched **outside
Codex's macOS workspace sandbox** through an approved, narrowly scoped command.
The existing `CHROME_BIN` override is sufficient; no test-harness rewrite is
needed. Keep browser tests opt-in locally. Changing the browser download alone
does not remove the sandbox restriction.

For interactive screenshots, the configured Chrome DevTools MCP already works
against a running browser without a Codex shell approval. Its file-output roots
must include the worker's worktree before it can save artifacts there. A second
working pattern is to start a directory-isolated Rodney browser once outside the
sandbox, then run navigation, JavaScript, clicks and screenshots inside it.
That pattern needs an initial approved launch, but no further escalation in the
measured session.

These are proposals, not installed settings. No browser policy, personal Chrome
profile, Codex configuration or live board was changed.

## Trial boundary

Measured on 15 November 2026: macOS 27.2 arm64, Node 24.2.0, Playwright 1.65.1,
Codex `workspace-write` sandbox, network enabled and automatic escalation review.
Results describe this host and session, not every Codex installation or Claude's
approval behavior. An accepted escalated tool call still runs outside the sandbox;
it is not evidence that an option works inside it without approval.

Downloads, npm cache, browser binaries and probe scripts lived under `.scratch`
in a dedicated worktree. Browser launches used temporary profiles or a separate
Rodney data directory. Tests used throwaway state and ephemeral ports, never the
live board's port. Each failing engine received one launch attempt per tested
version inside the sandbox; failed sandbox launches were not retried in a loop.

## Results

All passing engine probes set page content, clicked a button, checked its changed
text and wrote a PNG. Times are single observations, including first-run effects,
not benchmark averages. “Outside” means an explicit `require_escalated` call
accepted under the browser-trial authorization; no additional human answer was
needed during this run.

| Option | Inside Codex sandbox | Outside sandbox / managed-profile result | Launch / click + PNG total |
| --- | --- | --- | --- |
| Existing Chrome via configured DevTools MCP | Isolated tab, JS/click and inline PNG passed; worktree file save denied by MCP roots | Attaches to existing browser; does not launch a new profile | Tool round trips were seconds; no comparable process-launch timing |
| Playwright full Chromium, bundled Chrome for Testing 159.0.8154.6 (revision 1255) | `SIGABRT` before browser connection | Passed with temporary profile; no managed-profile block observed | 236 ms / 989 ms |
| Separate cached Chrome for Testing 145.0.7632.6 (revision 1208), copied into scratch | `SIGABRT` before browser connection | Passed with temporary profile; no managed-profile block observed | 503 ms / 2,138 ms |
| Playwright Chrome Headless Shell 159.0.8154.6 (revision 1255) | `SIGTRAP`; Mach bootstrap registration denied | Passed with temporary profile | 83 ms / 494 ms |
| Playwright Firefox 159.0 (revision 1572) | `SIGABRT`, after headless-mode message | Passed with temporary profile | 503 ms / 1,228 ms |
| Playwright WebKit 27.2 (revision 2388) | Launcher reports `Abort trap: 6`, exit 134 | Passed with isolated context | 256 ms / 764 ms |
| Installed Rodney CLI (`dev` version) + scratch headless shell | Connecting to an externally started session, navigation, JS, click, file screenshot and stop all passed | Directory-isolated `start` passed outside sandbox | Start tool call ~0.25 s; six subsequent commands together ~0.70 s |

Playwright's current `browsers.json` identifies its full `chromium` download as
**Chrome for Testing**. Those names are not independent engines in this version.
The separate 145 trial checks an additional binary version, not a different
browser family. Both full Chrome versions failed in the sandbox. The shell's
more specific diagnostic was:

```text
bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.<pid>:
Permission denied (1100)
```

This, together with successful launches outside the sandbox, points to the macOS
process sandbox rather than a profile policy as the immediate launch blocker.
It does not establish that every enterprise policy is harmless. Playwright
[documents policy-related limitations](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge).
`--no-sandbox` was already present in Playwright's Chromium arguments; it does not
disable the enclosing Codex sandbox.

Rodney was already installed. Its independent sandboxed `start` was deliberately
not attempted after its selected browser engine had failed there: repeating that
launch would add another crash without testing a different engine. Thus Rodney's
fresh launch inside the sandbox remains unmeasured; its successful **attachment
and subsequent commands** are the measured result. It needed `ROD_CHROME_BIN`
and `RODNEY_HOME` pointing into scratch. A raw `data:` URL failed its URL handling;
HTTPS navigation followed by DOM replacement worked. This was a CLI error, not
a browser crash.

## Core tests and Hive screenshots

Core's `server/browser-harness.js` and board acceptance test launch a Chrome binary
and talk CDP over a local WebSocket. The measured compatibility is:

| Option | Existing core browser tests | Hive UI screenshot flow |
| --- | --- | --- |
| Full Chrome for Testing | `CHROME_BIN` worked: board acceptance 4/4 passed in 8.91 s outside sandbox | PNG probe passed; CDP screenshot support available |
| Headless shell | `CHROME_BIN` worked: board acceptance 4/4 passed in 7.28 s outside sandbox | Actual Hive UI fixture rendered and saved PNG with zero page errors |
| Firefox / WebKit | No drop-in `CHROME_BIN` support; would require a Playwright harness adapter | Both saved probe PNGs outside sandbox; actual Hive fixture not exercised with these engines |
| DevTools MCP | Current tests do not call MCP; attaching to its browser requires a harness change | Inline PNG passed; file output to this worktree refused |
| Rodney | Current tests do not invoke Rodney or attach to its persistent browser | Sandboxed file PNG passed after external start; Hive page itself not exercised through Rodney |

For the Hive check, a temporary local HTTP server served the installed extension's
`test/fixtures/ui-polish.html` and its public assets. Headless shell rendered the
cell view (87 `.hive-ghost` elements, no page errors), saved a PNG and copied it
into this session's attachment inbox. This verifies fixture rendering and artifact
staging, not a live Hive backend or human-facing attachment publication. The
screenshot was not published. An earlier attempt to load a copied extension in a
fresh core instance displayed only core's empty board, so that screenshot is not
counted as a Hive rendering pass.

Hive's inspected browser runner also takes a binary through `HIVE_TEST_CHROME`
and writes screenshot artifacts via CDP. Shell/full Chrome are protocol-compatible;
the complete Hive browser suite was not run. Its binary and output settings need
the same outside-sandbox launch arrangement. Firefox/WebKit cannot substitute for
that CDP binary without an adapter.

The default browser policy's six tests passed with:

```sh
npm test -- server/browser-test-policy.test.js
```

The two real core browser-test runs used this command outside the sandbox,
changing only `CHROME_BIN` between full Chrome and shell:

```sh
AW_BROWSER_TESTS=1 CHROME_BIN="<absolute scratch binary>" \
  npm test -- server/board-acceptance.test.js
```

## Approval boundaries

A filesystem writable root is not enough to permit these macOS browser launches.
There is no measured browser flag or ordinary workspace path allowance that fixes
them. The exact successful escalation prefix requested for core tests was:

```text
["npm", "test", "--", "server/board-acceptance.test.js"]
```

The engine probes used a fixed scratch script with one engine argument. Each
outside-sandbox option kept a single command form, with requested prefixes:

```text
["node", ".scratch/browser-options/probe.mjs", "chromium"]
["node", ".scratch/browser-options/probe.mjs", "legacy"]
["node", ".scratch/browser-options/probe.mjs", "shell"]
["node", ".scratch/browser-options/probe.mjs", "firefox"]
["node", ".scratch/browser-options/probe.mjs", "webkit"]
```

Rodney's external start used a fixed wrapper prefix
`[".scratch/browser-options/rodney-trial.sh"]`; its later commands ran without
escalation. The Hive fixture/staging probe used
`["node", "--import", "./server/test-setup.js", ".scratch/browser-options/hive.mjs"]`.
These name temporary investigation scripts, not shipped repository commands or
rules installed in a user's configuration. Any durable wrapper should be reviewed
before granting its execution prefix; script contents can change.

MCP file-output rejection is a separate server-side root check: “not within any
of the configured workspace roots.” A Codex shell allow rule does not fix it.
Propose adding the worker worktree and intended artifact directory to the MCP's
supported output roots when configuring that server. The exact configuration key
was not established in this trial. No personal configuration was edited. Existing
browser connection behavior depends on the configured MCP server; see the upstream
[connection guidance](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md#connecting-to-a-running-chrome-instance).

## Installation cost and reproduction

| Download | Compressed transfer reported by installer | Installed `du -sh` |
| --- | ---: | ---: |
| Full Chrome for Testing 159 | 191.9 MiB | 382 MiB |
| Headless shell 159 | 100.8 MiB | 206 MiB |
| Firefox 159 | 107.6 MiB | 300 MiB |
| WebKit 27.2 | 81.8 MiB | 319 MiB |
| FFmpeg helper | 1.4 MiB | 2.9 MiB |
| Playwright npm packages | Not measured | 19 MiB |

The complete new browser download was about 484 MiB and took several minutes on
this connection. Disk totals exclude npm cache and temporary profiles. The extra
cached Chrome 145 copy occupied 330 MiB; no second download was needed. MCP reused
the running browser and Rodney reused the shell download.

To reproduce downloads without writing to the normal npm/browser caches:

```sh
mkdir -p .scratch/browser-options
npm install --prefix .scratch/browser-options --cache .scratch/npm-cache \
  --no-audit --no-fund playwright@1.65.1
PLAYWRIGHT_BROWSERS_PATH="$PWD/.scratch/browsers" \
  node .scratch/browser-options/node_modules/playwright/cli.js \
  install chromium firefox webkit
```

For the recommended test-only install, use `install chromium --only-shell`
instead. Playwright [documents separate full and shell downloads](https://playwright.dev/docs/browsers#chromium-headless-shell).
The tested shell executable was:

```text
.scratch/browsers/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell
```

A minimal equivalent engine probe, saved as `.scratch/browser-options/probe.mjs`:

```js
import { chromium, firefox, webkit } from './node_modules/playwright/index.mjs';
const name = process.argv[2];
const engine = { chromium, shell: chromium, firefox, webkit }[name];
const browser = await engine.launch({
  headless: true, timeout: 12000,
  ...(name === 'chromium' ? { channel: 'chromium' } : {}),
});
try {
  const page = await browser.newPage();
  await page.setContent(`<button onclick="this.textContent='Passed'">Run</button>`);
  await page.locator('button').click();
  if (await page.locator('button').textContent() !== 'Passed') throw Error('click');
  await page.screenshot({ path: `.scratch/browser-options/${name}.png` });
} finally {
  await browser.close();
}
```

Run with `PLAYWRIGHT_BROWSERS_PATH="$PWD/.scratch/browsers" node
.scratch/browser-options/probe.mjs shell`, or another engine name. On this host,
performing the launch inside the sandbox produces a crash; use an authorized
outside-sandbox trial, and stop an option if it produces repeated crash dialogs.
The equivalent probe omits timing instrumentation and the optional older-binary
path used in the investigation.

## Smallest adoption change

For core browser tests, document the shell install, `CHROME_BIN` and a narrow
approved test-command prefix. Keep `AW_BROWSER_TESTS=1` explicit. This needs no
runtime dependency or source change to core and avoids touching managed Chrome.
A future stable repository wrapper could encapsulate binary discovery and the
selected test list so each worker does not invent a new approval command.

For interactive agents, document the existing MCP connection and correct its
output-root configuration, or use a scratch-isolated browser started once through
an approved wrapper and connect subsequent commands to it. Rodney demonstrates
that latter pattern working inside this sandbox after setup. Treat a broader
browser-service integration as follow-up work; this report does not implement it.
