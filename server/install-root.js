import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_ENV } from './install-env.js';

// Where sessions should find files that ship with the app: the PR-attach hook,
// the agent-skills plugin, the builtin extensions' skills. Those paths are baked
// into a session's command line (and Codex's developer_instructions) at launch
// and read for as long as the session lives, so they must outlive an upgrade.
//
// Node realpaths the main module, so import.meta.url is always the app's real
// directory. When an install keeps each version in its own directory and an
// upgrade removes the old one, that path disappears under a running session.
// AW_INSTALL_ROOT names an upgrade-stable path to the same app, such as a
// symlink the upgrade repoints; see docs/install-signals.md.
//
// Server-internal reads (public/, styles/, catalog snapshots) keep their
// import.meta.url paths: they're resolved by the running process and can't go
// stale. Git never uses this; it runs in self-update.js's realpathed APP_ROOT.
//
// A LEAF apart from install-env.js (itself import-free), so skill-catalog.js
// stays importable from server/extensions/**.

// The app directory as this module resolved it: the default, which is exactly
// what each session-facing path was derived from before AW_INSTALL_ROOT.
export const SOURCE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// A dev instance (AW_DEV) is always a checkout testing its own hook and skills,
// so it ignores the variable even when started from a pane that still carries a
// packaged board's copy (panes predating install-env.js's strip keep their env).
export function resolveInstallRoot({ installRoot, dev, sourceRoot = SOURCE_ROOT }) {
  return installRoot && !dev ? path.resolve(installRoot) : sourceRoot;
}

export const INSTALL_ROOT = resolveInstallRoot({ installRoot: INSTALL_ENV.installRoot, dev: Boolean(process.env.AW_DEV) });

// Re-roots a path found under SOURCE_ROOT (a builtin extension's import.meta.url
// dir) onto INSTALL_ROOT. Anything outside it, such as an extension installed
// under the data dir, is returned unchanged. The identity when the variable is unset.
export function installPath(p, { root = INSTALL_ROOT, sourceRoot = SOURCE_ROOT } = {}) {
  const rel = path.relative(sourceRoot, p);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return p;
  return path.join(root, rel);
}
