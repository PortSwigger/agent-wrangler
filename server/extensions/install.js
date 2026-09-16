import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// The ONE place in the tree that shells out to `git` or `npm`, the way
// pr-status.js confines `gh`: everything an external-extension install needs
// from a subprocess lives here behind injectable runners, so nothing else may
// spawn either binary and a test can exercise the whole install path with no
// process and no network. This module stays a LEAF (node:fs/path/child_process/
// util only) — manifest reading belongs to external.js and the provenance
// record to provenance.js; the control handler composes the three.
const execFileAsync = promisify(execFile);

// Default runners. `execFile` with an argv ARRAY and no `shell` option is the
// whole no-shell guarantee: a URL is one argv element, never a string a shell
// re-parses, so metacharacters in it are inert by construction.
const defaultGit = (args, opts = {}) => execFileAsync('git', args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...opts });
const defaultNpm = (args, opts = {}) => execFileAsync('npm', args, { timeout: 300000, maxBuffer: 16 * 1024 * 1024, ...opts });

// Thrown by lockDependencies when the clone has no package-lock.json. A named
// class (and `code`) is what lets the control handler tell "this repo is not
// installable — it ships no lockfile" apart from a parse failure or an IO
// error, so the user gets the one message that tells them what to fix. Callers
// discriminate with `err instanceof MissingLockfileError` or
// `err.code === 'AW_NO_LOCKFILE'`; the message also names the expected path.
export class MissingLockfileError extends Error {
  constructor(file) {
    super(`No package-lock.json at ${file} — an extension without a lockfile is not installable (its dependency set would be unpinned and unreviewable).`);
    this.name = 'MissingLockfileError';
    this.code = 'AW_NO_LOCKFILE';
    this.file = file;
  }
}

// scp-like shorthand: `git@host:path` (also `user@host:path`). Deliberately
// anchored and character-restricted rather than "contains an @ and a colon" —
// a loose matcher is exactly how `ext::sh -c id` sneaks past an allow-list.
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._\-~/+]+$/;

// SECURITY: a scheme ALLOW-LIST, checked before git is ever invoked.
//  - git's `ext::` transport runs an ARBITRARY COMMAND (`ext::sh -c '…'`) as the
//    transport helper. That is a real, exploited RCE vector, not a theoretical
//    one, and the URL is the only thing an installing user is asked to supply.
//  - `file://` and bare local paths are refused because they sidestep the whole
//    provenance story: there is no remote to re-clone from or `ls-remote`
//    against, so nothing can ever verify or update what was installed.
// Anything with whitespace or a shell metacharacter is refused outright even
// though the URL never reaches a shell (cloneTo/lsRemoteHead pass argv arrays
// with no `shell: true`) — defence in depth, so a hostile URL cannot get as far
// as git at all, and so no future caller can reintroduce the hazard by
// interpolating a stored URL into a command string.
export function assertAllowedUrl(url) {
  if (typeof url !== 'string' || !url.trim()) throw new Error('Repository URL is required');
  if (/[\s'"`$;&|<>(){}\\^*?!]/.test(url)) {
    throw new Error(`Refusing repository URL containing whitespace or shell metacharacters: ${url}`);
  }
  if (/^https:\/\/[^/]/.test(url) || /^ssh:\/\/[^/]/.test(url) || SCP_LIKE.test(url)) return url;
  throw new Error(`Refusing repository URL ${url} — only https://, ssh:// and git@host:path are allowed (ext:: runs an arbitrary command; file:// and local paths have no remote to verify or update against).`);
}

// `--` is what stops a URL beginning with `-` being read as an option. The two
// `protocol.*.allow=never` flags are belt-and-braces BEHIND assertAllowedUrl: a
// clone can follow a submodule URL or an HTTP redirect to a URL this process
// never saw, so the transports are disabled in git itself rather than trusted
// to have been screened. `--no-local` additionally stops the local-path
// optimisation (hardlinking someone else's object store) if a path ever slips
// through.
export async function cloneTo(url, destDir, { git = defaultGit } = {}) {
  assertAllowedUrl(url);
  await git([
    '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.file.allow=never',
    'clone', '--depth', '1', '--no-recurse-submodules', '--no-local',
    '--', url, destDir,
  ]);
  return destDir;
}

// The pinned `sha` the provenance record stores, so a later "Check for updates"
// has something to compare against.
export async function readHead(dir, { git = defaultGit } = {}) {
  const { stdout } = await git(['rev-parse', 'HEAD'], { cwd: dir });
  return parseSha(stdout, 'git rev-parse HEAD');
}

// The remote's current default-branch head, for the on-demand update check.
// `ls-remote` output is `<sha>\tHEAD`; same allow-list and same no-shell rule
// as cloneTo, since this takes a URL too.
export async function lsRemoteHead(url, { git = defaultGit } = {}) {
  assertAllowedUrl(url);
  const { stdout } = await git([
    '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.file.allow=never',
    'ls-remote', '--', url, 'HEAD',
  ]);
  return parseSha(stdout, `git ls-remote ${url}`);
}

function parseSha(stdout, what) {
  const m = String(stdout || '').match(/\b[0-9a-f]{7,40}\b/);
  if (!m) throw new Error(`Could not parse a commit sha out of ${what}`);
  return m[0];
}

// Reads the clone's lockfile into the shape the update consent modal needs:
//   { all: ['name@version', …], direct: ['name@version', …], transitiveCount }
// `all` is flat, sorted and de-duplicated (one package can appear at several
// nested node_modules paths at the same version) so two installs' dependency
// sets diff as plain string lists. `direct` is the subset whose NAME is named
// in the extension's own dependency set — that's what the modal itself lists,
// with `transitiveCount` standing in for the rest. Direct names come from the
// lockfile's root package entry (v2/v3 `packages[""]`) when present, else the
// clone's package.json, so the answer survives either lockfile vintage.
export function lockDependencies(dir) {
  const file = path.join(dir, 'package-lock.json');
  if (!fs.existsSync(file)) throw new MissingLockfileError(file);
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'));

  const seen = new Set();
  const byName = new Map();
  const add = (name, version) => {
    if (!name || !version) return;
    seen.add(`${name}@${version}`);
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(version);
  };

  if (lock.packages && typeof lock.packages === 'object') {
    // v2/v3: keys are paths like `node_modules/foo` or
    // `node_modules/a/node_modules/b`; the package NAME is the last segment
    // after the final `node_modules/`. The root key `""` is the extension
    // itself, never a dependency.
    for (const [key, meta] of Object.entries(lock.packages)) {
      if (!key || !meta) continue;
      const i = key.lastIndexOf('node_modules/');
      add(i === -1 ? key : key.slice(i + 'node_modules/'.length), meta.version);
    }
  }
  if (lock.dependencies && typeof lock.dependencies === 'object') {
    // Legacy v1 nests `dependencies` recursively. A v2 lockfile carries BOTH
    // keys for backwards compatibility, so both branches run and the de-dup
    // above is what keeps that from double-reporting.
    const walk = (tree) => {
      for (const [name, meta] of Object.entries(tree)) {
        if (!meta) continue;
        add(name, meta.version);
        if (meta.dependencies) walk(meta.dependencies);
      }
    };
    walk(lock.dependencies);
  }

  const directNames = new Set(directDependencyNames(dir, lock));
  const all = [...seen].sort();
  const direct = all.filter((s) => directNames.has(s.slice(0, s.lastIndexOf('@'))));
  return { all, direct, transitiveCount: all.length - direct.length };
}

function directDependencyNames(dir, lock) {
  const root = lock?.packages?.[''];
  if (root && root.dependencies) return Object.keys(root.dependencies);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return Object.keys(pkg.dependencies || {});
  } catch {
    return [];
  }
}

// Installs the clone's own dependencies into `<dir>/node_modules`. `cwd: dir` is
// the whole isolation: the server's package.json, package-lock.json and
// scripts/sync-deps.sh are untouched, and there is deliberately NO interaction
// with the startup `npm ci` reconciliation — an extension's tree is its own.
//
// `--ignore-scripts` is a MITIGATION, NOT A BOUNDARY. It only stops install-time
// lifecycle hooks; every dependency's code runs in-process the moment the
// extension is imported, with the server's own privileges. Installing an
// extension is exactly as much trust as `npm install`-ing a package into the
// server, and nothing here should be read as sandboxing it.
export async function npmCi(dir, { npm = defaultNpm } = {}) {
  await npm(['ci', '--ignore-scripts', '--omit=dev'], { cwd: dir });
  return path.join(dir, 'node_modules');
}
