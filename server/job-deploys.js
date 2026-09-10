import YAML from 'yaml';

// GitHub's filter patterns are not plain globs: per the filter-pattern cheat
// sheet `*` stops at `/` while `**` does not, and `?`/`+` are QUANTIFIERS on the
// preceding character (`main?` matches `mai` and `main`), not wildcards of their
// own. Compiled once to an anchored regex per pattern, so the two wildcard
// widths and the quantifiers cannot drift apart across call sites.
const compiled = new Map();
function toRegex(glob) {
  const hit = compiled.get(glob);
  if (hit) return hit;
  let src = '';
  let atomAt = -1;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    let atom;
    if (ch === '*') {
      if (glob[i + 1] === '*') { atom = '.*'; i++; } else atom = '[^/]*';
    } else if (ch === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) atom = '\\[';
      else { atom = `[${glob.slice(i + 1, end).replace(/\\/g, '\\\\')}]`; i = end; }
    } else if ((ch === '?' || ch === '+') && atomAt >= 0) {
      // Quantify the preceding atom through a group: `.*?`/`[^/]*+` would read as
      // a lazy or (JS-invalid) possessive quantifier rather than "optional".
      src = `${src.slice(0, atomAt)}(?:${src.slice(atomAt)})${ch}`;
      atomAt = -1;
      continue;
    } else atom = ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    atomAt = src.length;
    src += atom;
  }
  const re = new RegExp(`^${src}$`);
  compiled.set(glob, re);
  return re;
}

// A leading `!` is the pattern's SIGN, not part of its glob — ordering is
// matchesFilters' business, so the matcher answers "does this pattern address
// this path" for negative and positive patterns alike.
export function filterMatch(pattern, value) {
  if (typeof pattern !== 'string' || typeof value !== 'string') return false;
  return toRegex(pattern.startsWith('!') ? pattern.slice(1) : pattern).test(value);
}

// Last match wins: a later `!` un-matches an earlier positive and a later
// positive re-matches it, so evaluating the list in order IS the rule.
export function matchesFilters(patterns, value) {
  let matched = false;
  for (const p of patterns) if (filterMatch(p, value)) matched = !p.startsWith('!');
  return matched;
}

const asList = (v) => (v == null ? null : Array.isArray(v) ? v.map(String) : [String(v)]);
const basename = (file = '') => String(file).split('/').pop().replace(/\.ya?ml$/i, '');
const UNPARSEABLE = 'unparseable';
const NO_PUSH = 'no push trigger';

// `on` is a string, a list of event names or a map of event → filters; YAML 1.1
// reads the bare key as boolean true (this package's 1.2 core schema keeps it a
// string, a `%YAML 1.1` directive does not), and a JS object key is a string
// either way, so the boolean lands under 'true'.
function pushConfig(doc) {
  const on = doc.on ?? doc[true];
  if (typeof on === 'string') return on === 'push' ? {} : null;
  if (Array.isArray(on)) return on.includes('push') ? {} : null;
  if (on && typeof on === 'object') return 'push' in on ? on.push ?? {} : null;
  return null;
}

function evaluatePush(config, files, base) {
  const branches = asList(config.branches);
  const ignoreBranches = asList(config['branches-ignore']);
  const tags = asList(config.tags) || asList(config['tags-ignore']);
  if (tags && !branches && !ignoreBranches) return { triggers: false, reason: 'only on tags' };
  if (branches && !matchesFilters(branches, base)) return { triggers: false, reason: `only branches ${branches.join(', ')}` };
  if (ignoreBranches && matchesFilters(ignoreBranches, base)) return { triggers: false, reason: `ignores branches ${ignoreBranches.join(', ')}` };
  const paths = asList(config.paths);
  const ignorePaths = asList(config['paths-ignore']);
  // An empty file list is unknowable, not "nothing matched": wrongly expecting a
  // deploy surfaces as the stale flag for a human, while a wrong "merge is
  // delivery" silently marks the sub-job delivered.
  if (!files.length) return { triggers: true, reason: 'runs on push' };
  // GitHub honours `paths` when a workflow illegally declares both.
  if (paths) {
    if (!files.some((f) => matchesFilters(paths, f))) return { triggers: false, reason: `only on paths ${paths.join(', ')}` };
  } else if (ignorePaths && !files.some((f) => !matchesFilters(ignorePaths, f))) {
    return { triggers: false, reason: `ignores ${ignorePaths.join(', ')}` };
  }
  return { triggers: true, reason: 'runs on push' };
}

export function inferDeploys({ workflows = [], files = [], base = '' } = {}) {
  const evaluated = workflows.map((wf) => {
    let doc;
    let failed = false;
    try { doc = YAML.parse(wf.text ?? ''); } catch { failed = true; }
    const named = !failed && doc && typeof doc === 'object' && typeof doc.name === 'string' && doc.name.trim();
    const name = named || wf.name || basename(wf.file);
    const head = { name, file: wf.file };
    if (failed || (doc != null && (typeof doc !== 'object' || Array.isArray(doc)))) return { ...head, triggers: false, reason: UNPARSEABLE };
    const config = doc && pushConfig(doc);
    if (!config) return { ...head, triggers: false, reason: NO_PUSH };
    return { ...head, ...evaluatePush(config, files, base) };
  });
  const firing = evaluated.filter((w) => w.triggers);
  // A workflow that simply has no push trigger (or would not parse) says nothing
  // a human could act on; a filter reason names the workflow that declined THIS
  // diff, which is the whole point of the line.
  const informative = evaluated.find((w) => w.reason !== NO_PUSH && w.reason !== UNPARSEABLE);
  const summary = firing.length ? `Deploys on merge · ${firing.map((w) => w.name).join(' · ')}`
    : !evaluated.length ? 'Merge completes it · no workflows'
      : `Merge completes it · ${informative ? `${informative.name} ${informative.reason}` : `nothing runs on push to ${base}`}`;
  return { expected: firing.length > 0, workflows: evaluated, summary };
}
