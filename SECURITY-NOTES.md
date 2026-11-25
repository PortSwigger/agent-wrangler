# Security notes

Security trade-offs Agent Wrangler makes on purpose, and what limits each one.

## Accepted risks

- 2026-11-25: an enabled extension holding `board:wasm-worker` (host API 2.3.0) loosens the board's
  Content Security Policy. Every board page is normally sent
  `script-src 'self'; object-src 'none'; base-uri 'self'` (#533). While an enabled extension holds
  the capability, the board sends
  `script-src 'self' 'unsafe-eval'; object-src 'none'; base-uri 'self'; worker-src 'self' blob:`
  instead (`server/http-handler.js`, `WASM_WORKER_CSP`). An in-browser WASM speech recognizer
  (vosk-browser 0.0.8) needs it: the recognizer starts its worker from a `blob:` URL, the worker
  inherits the page's policy, and its Emscripten glue builds functions with `new Function` there.
  Measured in Chrome 158 against that bundle and its English model:
  - The current policy refuses the `blob:` worker.
  - `worker-src blob:` alone fails on `'unsafe-eval'`. It also blocks the board's own same-origin
    diff worker, since naming `worker-src` stops it falling back to `script-src`.
  - `worker-src 'self' blob:` with `'wasm-unsafe-eval'` still fails on `'unsafe-eval'`.
  - `worker-src 'self' blob:` with `'unsafe-eval'` loads the model, with or without
    `'wasm-unsafe-eval'`, which `'unsafe-eval'` already covers.

  The cost: with `'unsafe-eval'`, a string that reaches `eval`, `new Function` or a string
  `setTimeout` in any board script runs as code. That covers core and every extension's board half,
  so a script gadget that passes injected text to one of them becomes cross-site scripting. Inline
  scripts, inline event handlers, `javascript:` URLs and scripts from other origins stay blocked, so
  injected markup on its own still runs nothing. `worker-src blob:` lets board code run a worker
  from a blob it built, which needs running script to begin with, so on its own it adds little.

  What limits it:
  - Off unless asked for: with no enabled holder the header is the normal policy, byte for byte.
  - Consented: the capability is in the manifest's `requires`, so the install dialog names it, and so
    does the update dialog when an update adds it. Each says it loosens the policy for every page
    and every extension (`public/extensions-panel.js`). An installed extension that widens `requires`
    on disk after consent is quarantined.
  - Live: the board checks for a holder on every request, so turning the holder off, quarantining it
    or uninstalling it restores the normal policy on the next page load.
  - Not narrower: a policy applies to a whole page, so the grant cannot be limited to the holder's
    own scripts. An extension already runs with full access to the machine (see
    [docs/extensions.md](docs/extensions.md)), so the capability discloses a board-wide weakening
    rather than granting a new level of trust.

  Revisit if the recognizer is rebuilt without dynamic functions: `'wasm-unsafe-eval'` could then
  replace `'unsafe-eval'`.
