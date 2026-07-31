import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Custom styles live in a top-level `styles/<id>/` (outside the statically-served
// public/ tree, committable). Each is a theme.json manifest + image assets. The
// manifest is compiled here to CSS-var overrides and never served raw; only
// manifest-declared assets are reachable, via assetPath (see server/index.js).
export const STYLES_DIR = path.join(fileURLToPath(new URL('..', import.meta.url)), 'styles');
// Themes are added by editing STYLES_DIR in the repo, not through an in-app editor.
// CUSTOM_STYLES_DIR is read-only support for themes hand-placed there previously.
export const CUSTOM_STYLES_DIR = path.join(os.homedir(), '.agent-wrangler', 'custom-styles');

// ansi color names are authored camelCase (`brightRed`) or kebab (`bright-green`);
// both normalize to the `--term-ansi-bright-red` CSS-var spelling.
const kebab = (s) => s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

// Flatten a manifest's `colors` to the `{ '--bg': '#…' }` shape the client applies
// verbatim. Top-level keys are CSS var names sans `--`; the nested `terminal`
// object maps onto the `--term-*` palette.
function flattenColors(colors = {}) {
  const vars = {};
  for (const [key, val] of Object.entries(colors)) {
    if (key === 'terminal') continue;
    vars[`--${key}`] = val;
  }
  const t = colors.terminal || {};
  for (const [key, val] of Object.entries(t)) {
    if (key === 'ansi') continue;
    vars[`--term-${key}`] = val;
  }
  for (const [name, val] of Object.entries(t.ansi || {})) {
    vars[`--term-ansi-${kebab(name)}`] = val;
  }
  return vars;
}

// A style may swap the UI font via a top-level `font` (a CSS font-family value);
// it flattens to the same `--font` var the client applies verbatim. The font face
// itself is loaded globally (index.html); this only selects it.
function withFont(vars, font) {
  if (typeof font === 'string') vars['--font'] = font;
  return vars;
}

function readManifest(dir, id) {
  const file = path.join(dir, id, 'theme.json');
  let m;
  try {
    m = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!m || typeof m.name !== 'string' || (m.base !== 'dark' && m.base !== 'light') || typeof m.icon !== 'string') {
    console.error(`[styles] skipping ${id}: invalid manifest (need name, icon, base dark|light)`);
    return null;
  }
  return m;
}

// Scan one dir for valid style subdirectories; return descriptors tagged with the
// given `editable` flag. Bad manifests are skipped + logged, never thrown.
function scanStyles(dir, editable) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const styles = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = readManifest(dir, e.name);
    if (!m) continue;
    const wallpaper = isSafeSegment(m.assets?.wallpaper) ? m.assets.wallpaper : null;
    const iconImage = isSafeSegment(m.assets?.iconImage) ? m.assets.iconImage : null;
    styles.push({
      id: e.name,
      name: m.name,
      base: m.base,
      icon: m.icon,
      iconViewBox: m.iconViewBox,
      iconFill: m.iconFill === true,
      vars: withFont(flattenColors(m.colors), m.font),
      // `background` is a raw CSS background-image value (e.g. layered gradients),
      // applied to body directly — adapts to the viewport, no asset needed. Takes
      // precedence over wallpaperUrl on the client.
      background: typeof m.background === 'string' ? m.background : null,
      wallpaperUrl: wallpaper ? `/styles/${e.name}/${wallpaper}` : null,
      iconImageUrl: iconImage ? `/styles/${e.name}/${iconImage}` : null,
      editable,
      // The raw parsed manifest, so the client can read any key the editor didn't
      // model (e.g. iconCredit).
      manifest: m,
    });
  }
  return styles;
}

// Reject anything that isn't a single safe path segment (same guard memory-store
// uses), so an id can never escape the custom-styles dir.
function isSafeSegment(s) {
  return typeof s === 'string' && s.length > 0 && s !== '.' && s !== '..' &&
    !s.includes('/') && !s.includes('\\') && !s.includes('\0');
}

// Bundled (committed, read-only) styles in STYLES_DIR plus any styles in
// CUSTOM_STYLES_DIR (hand-placed there; there is no in-app way to create these).
// On an id collision the bundled one wins and stays read-only.
export function listStyles(dir = STYLES_DIR, customDir = CUSTOM_STYLES_DIR) {
  const bundled = scanStyles(dir, false);
  const custom = scanStyles(customDir, true);
  const seen = new Set(bundled.map((s) => s.id));
  return [...bundled, ...custom.filter((s) => !seen.has(s.id))];
}

// Resolve a servable asset: the file must be a manifest-declared asset of the
// style (exact-name match, so traversal can't escape). Checks the custom dir then
// the bundled dir, so wallpapers for both serve through /styles/<id>/<file>.
export function assetPath(id, file, dir = STYLES_DIR, customDir = CUSTOM_STYLES_DIR) {
  if (!isSafeSegment(id)) return null;
  for (const base of [customDir, dir]) {
    const m = readManifest(base, id);
    if (!m) continue;
    const declared = Object.values(m.assets || {});
    if (declared.includes(file)) return path.join(base, id, file);
  }
  return null;
}
