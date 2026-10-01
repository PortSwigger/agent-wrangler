import semver from 'semver';

// The version of the per-extension `host` façade this server serves. A manifest
// declares the range it was written against as `engines.wranglerApi`; a mismatch
// is a BOOT failure (see host-api/index.js), not a degradation — an extension
// built for a surface this server does not offer is a mistake a human must see.
//
// Bump the MINOR for an additive capability, the MAJOR for a breaking reshape —
// and on a major, add `v2.js` and keep `v1.js` as the shim rather than editing
// the builders in place, so an old manifest's declared range keeps meaning what
// it meant. That is the whole point of carrying the version at all.
//
// An addition to `alwaysPresent` (host-api/index.js) is a MINOR too, even
// though it is not a capability at all: 1.1.0 added `host.settings`, and a
// manifest declaring `^1.1.0` is stating that it needs that key to exist.
//
// So is an addition to the CLIENT half, which is what 1.2.0 is: `api.onMessage`
// / `forExtension().onMessage` (public/slots.js), the inbound seam that makes a
// `board:broadcast` frame actually reach the same extension's browser half —
// before it, app.js's ws ladder had no `ext:` branch and dropped it. There is no
// new server-side key for it, but the number is the only thing a manifest can
// declare a dependency on, and the server serves both halves: a manifest whose
// client module calls onMessage declares `^1.2.0` and then refuses to boot
// against a server whose app.js would drop its frames, which is the whole
// purpose of carrying a version.
//
// And so is an addition to the STORE FACTORY bag, which is what 1.3.0 is:
// `extId` and a read-through `settings` beside the store name (server/index.js
// activateExtension). It is not a façade key either — a factory never gets one
// — but it is the same argument twice over: a manifest whose store factory
// reads `settings` to decide its state-file path is broken, silently, against a
// server that hands it `undefined`, and the declared range is the only thing
// that can say so.
//
// 1.4.0 is `sessions:spawn` growing the options a real extension needed to
// launch work the way core launches it: `worktree` (branch/base/auto/
// folderName, so the wrangler cuts it and stamps the card's record), `addDirs`,
// `taskId` (bound BEFORE launch), `autoMergeOnPass`/`autoFixPrChecks`, and the
// resolved worktree summary on the result. Every one is additive on one
// existing method, so v1.js keeps its builders and no v2.js is needed — but an
// extension that cuts its own worktree because spawn could not is broken in a
// way only the declared range can express, which is what the number is for.
//
// 1.5.0 is the SETTING DEF vocabulary widening: a `select` type, and the
// constraint fields (`min`/`max`/`step`, `maxLength`/`pattern`, `options`)
// enforced on the write path. No façade key again, and the same argument a
// third time — a manifest declaring `type: 'select'` or a `min` is QUARANTINED
// by an older server that has never heard of either, so the declared range is
// the only thing that can say which servers it will load on.
//
// 1.6.0 adds two capabilities: `usage:read` (`host.usage.byCard()`, every card's
// spend summed over every transcript and day it owned, through the shared
// usage-scan memo) and `sessions:bill` (`host.sessions.bill(sessionId,
// liveSessionId)`, which records a headless conversation onto a card's
// `priorLiveSessionIds` so the scanners bill it there, and never repoints the
// card's live conversation). Both exist because the jobs extension had to price
// its board and bill a headless triage run to the card that asked for it, and
// neither is reachable any other way: the scan memo and the entry's prior-id
// list are core singletons a manifest may not import. Additive keys on the
// façade, so v1.js keeps its builders — and a manifest declaring `^1.6.0` is
// saying it needs those two keys to exist, which an older server's
// unknown-capability quarantine is the only thing that can honour.
//
// 1.7.0 is the other kind of CLIENT addition: a `view` contribution may carry
// `badge()`, and core draws the count it returns on the rail button it already
// builds for that view (public/slots.js reportBadges, app.js
// setExtViewBadge). No server-side key again, and the reason the number has to
// move is the reason 1.2.0 did: a manifest whose client half returns a count
// from `badge` gets SILENCE from a server whose slots.js never calls it — no
// error, no quarantine, just a rail button that never says anything — and the
// declared range is the only thing that can tell those two servers apart.
//
// 1.8.0 is the CLIENT half once more: `api.openSession(sessionId)`
// (public/slots.js apiFor, implemented by app.js's base api). It switches the
// board to the grid and selects the card if it is on the board, otherwise
// pending-selects it, sends the core `resume` frame and toasts "Restoring…" —
// what the board itself does for a Search result. An extension could do none
// of that: its `send` is bound to its OWN handler types so it may not send
// `resume`, and there is no other route to the view or the selection. No new
// server-side key, but a manifest whose client half calls `openSession` is
// broken, silently, against a server whose app.js never supplied it, and the
// declared range is the only thing that can say so.
//
// 1.9.0 is the `dispatch.field` slot (public/slots.js) plus the
// `hideDispatchField` manifest key — the first extension surface that shapes a
// CORE form. No new façade key again, and the same argument once more, from
// both halves at once: an older `slots.js` THROWS on an unknown slot name, so
// the whole client module fails to load, and an older SERVER quarantines a
// manifest declaring `hideDispatchField` outright. The declared range is the
// only thing that can say which servers such a manifest will load on.
//
// 1.10.0 adds the `sessions:interrupt` capability (`host.sessions.interrupt(
// sessionId)` → Promise<boolean>): Escape into a live card's pane, so an
// extension can stop a turn without killing the pane. Nothing else reaches a
// pane's keys — `deliver` only pastes text — and the spend-limit extension
// needed exactly this. An additive key, so v1.js keeps its builders. The same
// minor carries three CLIENT/dispatch seams that extension needed to live in
// the board's own chrome rather than beside it: the `card.action` value slot
// (items in the card and Actions menus), the `card.cost` value slot (a numeric
// ceiling core draws into the cost tag as `$8.08 / $50.00`), and a
// dispatch.field contribution's `ext(el)`, which reaches that extension's own
// `onBeforeDispatch` as `ext`. An older slots.js throws on either slot name
// and an older server drops `ext`, so only the range can say so.
//
// 1.11.0 is the CLIENT half again, for a task TILE rather than a card: the
// `task.action` value slot (items in a task tile's right-click menu, subject
// `{ id, name, adhoc }`) and `api.minimiseTask(taskId)`, which tucks the tile
// into the tray the way its header's Minimise does. Minimising is board view
// state app.js owns — not a control frame `send` could carry — so, like
// `openSession`, only the base api can reach it. An older slots.js throws on
// the slot name and has no such method, so only the range can say so.
//
// 1.12.0 is the `codexPolicy` manifest key: a synchronous per-launch hook that
// answers a Codex session's sandbox, approval policy, `--approve-for-me` and
// bypass (validated by extensions/codex-policy.js, resolved by
// createCodexPolicyResolver). No façade key, and a server older than this never
// calls the hook — the manifest loads but its policy is silently ignored, and
// every Codex launch keeps the core defaults. So a manifest declaring
// `^1.12.0` refuses to boot against such a server, which is the only way a
// human learns the policy they chose is not being applied.
//
// 1.13.0 is the CLIENT half: `api.settings()`, the extension's own current
// setting values in the browser. Without it a dispatch.field could not prefill
// from Settings, so the server half had to fill empty fields itself — which
// meant a dispatch could never turn off a toggle Settings had on. An older
// slots.js has no such method, so only the range can say so.
//
// 1.14.0 lets an extension choose which chips a board card shows. Every core
// chip in a card's meta row carries a stable `data-chip` key (cards.js
// CORE_CHIPS), a `card.pill` contribution's key is `<extId>:<id>` and it may
// carry a `label`. `api.cards` (chips, hideChips, renderSample) is gated on
// `cards:hideChips`, the first CLIENT-ONLY capability: it rides `requires` and
// is disclosed like any other, but it has no server façade, so it lives in
// CLIENT_CAPABILITIES rather than as a V1_BUILDERS key. Also the
// `settings.panel` slot (an extension's own block in its settings dialog,
// saved on Done), `api.settings.set(key, value)` → Promise and
// `api.settings.onChange(fn)`, and the `list` setting type with the `hidden`
// and `maxItems` def fields, and `registrar.api` (the contribution api, on the
// registrar register() receives, for load-time use). An older slots.js throws on the slot name and an
// older server quarantines `type: 'list'` and the unknown capability, so only
// the range can say so.
//
// 1.15.0 is what moving the board TODOs out of core needed, and it is mostly
// the CLIENT half again plus one server hook. `task.body` is a slot with one host
// per task tile (Unassigned included) whose contributions may carry
// `weight(taskId, graph)` px, summed into tile sizing; `api.claimDrag(el)` marks an element as carrying an extension-owned
// drag, so the board holds its re-renders and cell highlight while it is claimed;
// `api.openDispatch({ taskId, intent, lockTask })` opens the
// dispatch modal and resolves with the `dispatched` ack (null on cancel);
// `api.requestBoardRender()` asks for a board re-render. Server side: the
// `onTaskDelete({ taskId, host })` manifest hook and `host.tasks.adhocId`
// (under `tasks:read`). An older slots.js throws on the slot name and an older
// server never calls the hook or serves the id, so only the range can say so.
//
// 1.16.0 is the `textarea` setting type: multi-line prose with its own larger
// length cap. A vocabulary widening with no façade key — an older server
// quarantines a manifest declaring it, so only the range can say so.
//
// 1.17.0 is what moving task memory out of core needed: the `hooks` manifest
// object (value hooks core uses the return of, starting with
// `session.launchContext` for env vars and extra directory grants), the
// `activate`/`deactivate` lifecycle functions, the `events` capability
// (`host.events.on/emit`, extension events forced under `ext:<id>:`) and
// `memory:read`/`memory:append` (`host.memory`, provided by the task-memory
// extension). An older server ignores the manifest keys and refuses the
// capabilities, so only the range can say so.
export const HOST_API_VERSION = '1.17.0';

// Does this server serve `range`? A null/absent range is "no constraint" and
// passes — declaring the range is optional, getting it wrong is not.
export function servesRange(range) {
  if (range == null || range === '') return true;
  if (!isValidRange(range)) return false;
  return semver.satisfies(HOST_API_VERSION, range);
}

// Deliberately DUPLICATED as a one-liner in server/extensions/index.js: that
// module is a leaf (it may not import anything under host-api/), but the loader
// has to reject a malformed range at manifest-load time, before any façade
// exists. Keep the two identical; they are one definition split by the leaf rule.
export function isValidRange(range) {
  return semver.validRange(range) != null;
}
