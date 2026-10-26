import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logError } from './log.js';

// Themes beyond the client's built-in Dark/Light come from extensions (the core
// Themes extension ships the bundled set) and from CUSTOM_STYLES_DIR. Each is a
// `<id>/theme.json` manifest + image assets. The manifest is compiled here to
// CSS-var overrides and never served raw; only manifest-declared assets are
// reachable, via assetPath (see server/http-handler.js).
// CUSTOM_STYLES_DIR is read-only support for themes hand-placed there.
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
    logError(`[styles] skipping ${id}: invalid manifest (need name, icon, base dark|light)`);
    return null;
  }
  return m;
}

// Scan one dir for valid style subdirectories; return descriptors tagged with the
// given `editable` flag (and `extension`, the contributing extension's id, when
// it came from one). Bad manifests are skipped + logged, never thrown.
function scanStyles(dir, editable, extension = null, off = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const styles = [];
  for (const e of entries) {
    if (!e.isDirectory() || off.includes(e.name)) continue;
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
      ...(extension ? { extension } : {}),
      // The raw parsed manifest, so the client can read any key the editor didn't
      // model (e.g. iconCredit).
      manifest: m,
    });
  }
  return styles;
}

// Reject anything that isn't a single safe path segment (same guard task-memory's store
// uses), so an id can never escape the custom-styles dir.
function isSafeSegment(s) {
  return typeof s === 'string' && s.length > 0 && s !== '.' && s !== '..' &&
    !s.includes('/') && !s.includes('\\') && !s.includes('\0');
}

// The theme sources in precedence order: each enabled extension's `themes` dir
// in load order (core extensions before installed ones), then CUSTOM_STYLES_DIR
// (hand-placed there; there is no in-app way to create these). `extThemes` is
// `[{ id, dir, off? }]` for enabled extensions only (extensions/index.js
// `themeSources`); `off` lists the theme ids that extension has switched off,
// which are skipped as if absent, so the next source may answer that id.
function sources(customDir, extThemes) {
  return [
    ...extThemes.map((t) => ({ dir: t.dir, editable: false, extension: t.id, off: t.off || [] })),
    { dir: customDir, editable: true, off: [] },
  ];
}

// Every source's styles, first source wins an id collision — so a theme id is
// only ever answered by one place, and assetPath below resolves the same one.
export function listStyles(extThemes = [], customDir = CUSTOM_STYLES_DIR) {
  const seen = new Set();
  const out = [];
  for (const src of sources(customDir, extThemes)) {
    for (const s of scanStyles(src.dir, src.editable, src.extension, src.off)) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}

// Resolve a servable asset: the file must be a manifest-declared asset of the
// style (exact-name match, so traversal can't escape), read from the same source
// listStyles took that id from, so every theme's wallpaper serves through
// /styles/<id>/<file>.
export function assetPath(id, file, extThemes = [], customDir = CUSTOM_STYLES_DIR) {
  if (!isSafeSegment(id)) return null;
  for (const src of sources(customDir, extThemes)) {
    if (src.off.includes(id)) continue;
    const m = readManifest(src.dir, id);
    if (!m) continue;
    const declared = Object.values(m.assets || {});
    return declared.includes(file) ? path.join(src.dir, id, file) : null;
  }
  return null;
}
