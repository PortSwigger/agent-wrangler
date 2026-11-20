# Contributing

Install dependencies with `npm ci`. Run the tests with:

```sh
AW_BROWSER_TESTS=0 npm test
```

Use `npm test` so the test setup isolates data from your live installation. Do not
invoke `node --test` directly.

Browser tests skip locally unless you explicitly opt in with
`AW_BROWSER_TESTS=1 npm test`. They require Chrome or Chromium; set `CHROME_BIN` if
its executable is outside the usual locations. `CI=true` (case-insensitive) or `CI=1`
also enables browser tests; values such as `false`, `0` and `no` do not. `AW_BROWSER_TESTS=0` always disables them, including in
CI and when Chrome is installed. Agents must keep `AW_BROWSER_TESTS=0` on every
local test command.

The CI Test job runs browser tests and explicitly sets `AW_BROWSER_TESTS=1`
and `AW_REQUIRE_BROWSER=1` to fail if no
browser is available.

agy's conversation reader needs `node:sqlite` (Node 22.5+). On older Node its
tests skip; CI runs `server/agents/agy.test.js` again on Node 22 with
`AW_REQUIRE_SQLITE=1`, which fails rather than skips.
