import fs from 'node:fs';

// The running app's version, from its own package.json — the single source the
// release process bumps, so `--version`, the startup banner and the formula's
// `brew test` all agree with the tag they were built from.
export const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
