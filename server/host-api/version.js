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
export const HOST_API_VERSION = '1.1.0';

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
