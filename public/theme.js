import { esc } from './util.js';

// Style picker: built-in dark/light + drop-in styles (server-compiled manifests
// from /api/styles — bundled in styles/, or hand-placed under
// ~/.agent-wrangler/custom-styles/). Self-contained — it owns the theme vars and
// the xterm color read; the only outward coupling is a re-theme hook the app
// registers (onThemeChange) so a style change can re-paint a live terminal without
// this module importing the terminal's state (keeps the dependency one-way).
// There is no in-app way to create/edit a style — new ones are added by editing
// styles/ in the repo.

// xterm renders to a canvas, so it can't inherit our CSS theme — it needs a JS
// color object. Read the resolved --term-* custom properties off the body so the
// canvas tracks whatever theme (today: dark/light) is applied; reassigning
// term.options.theme re-themes a live terminal.
// The canvas background: for a translucent (rgba) --term-bg we make the canvas
// fully transparent so it takes the #term wrapper's bg uniformly (wrapper carries
// the bg + padding — no double-paint, no frame). Opaque themes keep the real
// colour. Caveat: a transparent canvas reports black to the program (OSC 11), so
// the terminal renders dark-theme diffs — correct for our only translucent theme
// (Jurassic Park is dark-toned); opaque themes report their true lightness so
// light mode gets light diffs and white-on-white doesn't happen.
export function readTerminalTheme() {
  const s = getComputedStyle(document.body);
  const v = (n) => s.getPropertyValue(n).trim();
  const termBg = v('--term-bg');
  const translucent = termBg.startsWith('rgba');
  return {
    background: translucent ? 'rgba(0,0,0,0)' : termBg, foreground: v('--term-fg'),
    cursor: v('--term-cursor'), cursorAccent: v('--term-bg'),
    selectionBackground: v('--term-selection'),
    black: v('--term-ansi-black'), red: v('--term-ansi-red'),
    green: v('--term-ansi-green'), yellow: v('--term-ansi-yellow'),
    blue: v('--term-ansi-blue'), magenta: v('--term-ansi-magenta'),
    cyan: v('--term-ansi-cyan'), white: v('--term-ansi-white'),
    brightBlack: v('--term-ansi-bright-black'), brightRed: v('--term-ansi-bright-red'),
    brightGreen: v('--term-ansi-bright-green'), brightYellow: v('--term-ansi-bright-yellow'),
    brightBlue: v('--term-ansi-bright-blue'), brightMagenta: v('--term-ansi-bright-magenta'),
    brightCyan: v('--term-ansi-bright-cyan'), brightWhite: v('--term-ansi-bright-white'),
  };
}

const MOON_ICON = '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>';
const SUN_ICON = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>';
const BUILT_IN_STYLES = [
  { id: 'dark', name: 'Dark', base: 'dark', iconInner: MOON_ICON, vars: {}, wallpaperUrl: '/dark-bg.png' },
  { id: 'light', name: 'Light', base: 'light', iconInner: SUN_ICON, vars: {}, wallpaperUrl: '/light-bg.png' },
];
let customStyles = [];
let currentStyleId = 'dark';
let appliedVarKeys = [];

// The app registers a callback here to re-theme a live terminal when the style
// changes — keeps theme.js from importing the terminal's `current` handle.
let themeChangeHook = null;
export function onThemeChange(fn) { themeChangeHook = fn; }

function allStyles() { return [...BUILT_IN_STYLES, ...customStyles]; }
function styleIconInner(s) { return s.iconInner ?? `<path d="${esc(s.icon || '')}"/>`; }
// Stroke icons (lucide-style, the default) share the rail's 24-grid + currentColor
// outline. A theme can instead ship a filled silhouette (iconFill) on its own
// viewBox — then we fill rather than stroke so a dense path reads as a solid shape.
function styleIconSvg(s) {
  const vb = esc(s.iconViewBox || '0 0 24 24');
  const paint = s.iconFill ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor"';
  return `<svg class="icon" viewBox="${vb}" ${paint} stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${styleIconInner(s)}</svg>`;
}

// An icon image URL is only ever a same-origin asset path (/styles/...) or a
// data:image/ upload preview. Allowlist those; reject anything else.
export function safeIconUrl(url) {
  if (typeof url !== 'string' || url === '') return null;
  if (/^data:image\//i.test(url)) return url;
  if (url[0] !== '/') return null;
  try {
    return new URL(url, location.origin).origin === location.origin ? url : null;
  } catch {
    return null;
  }
}
// Effective row glyph: an uploaded image (as-is) wins over the svg path.
function styleIconMarkup(s) {
  const imgUrl = safeIconUrl(s.iconImageUrl);
  if (imgUrl) return `<img class="icon" src="${esc(imgUrl)}" alt="" />`;
  return styleIconSvg(s);
}

// Apply = base class (so unspecified roles inherit dark/light) + inline var
// overrides on body + wallpaper; readTerminalTheme reads the resolved vars, so a
// live terminal re-themes off the same source (via the registered hook).
function applyStyle(style) {
  document.body.classList.toggle('light', style.base === 'light');
  for (const k of appliedVarKeys) document.body.style.removeProperty(k);
  const vars = style.vars || {};
  appliedVarKeys = Object.keys(vars);
  for (const [k, v] of Object.entries(vars)) document.body.style.setProperty(k, v);
  document.body.style.backgroundImage = style.background
    ? style.background
    : (style.wallpaperUrl ? `url("${style.wallpaperUrl}")` : '');
  themeChangeHook?.();
  setFavicon(style);
}

function setFavicon(style) {
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  try {
    const imgUrl = safeIconUrl(style.iconImageUrl);
    if (imgUrl) { link.href = imgUrl; return; }
    if (style.icon) {
      const fg = getComputedStyle(document.body).getPropertyValue('--fg').trim() || '#888888';
      const vb = style.iconViewBox || '0 0 24 24';
      const paint = style.iconFill ? `fill="${fg}" stroke="none"` : `fill="none" stroke="${fg}"`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" ${paint} stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${style.icon}"/></svg>`;
      link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
      return;
    }
    link.href = 'favicon.svg';
  } catch { link.href = 'favicon.svg'; }
}

// Select + apply a style by id, and persist the choice. Called both at startup
// (persisted/migrated id) and from the settings modal's theme row click.
export function selectStyle(id) {
  const style = allStyles().find((s) => s.id === id) || BUILT_IN_STYLES[0];
  currentStyleId = style.id;
  localStorage.setItem('cm-style', currentStyleId);
  applyStyle(style);
}

// New custom-style set (initial /api/styles fetch). Re-apply the active style if
// it's a custom one (its colors may have changed on disk); fall back to dark if
// it was removed. Built-ins are unaffected by the custom set.
export function setCustomStyles(styles) {
  customStyles = Array.isArray(styles) ? styles : [];
  if (BUILT_IN_STYLES.some((s) => s.id === currentStyleId)) return;
  const active = customStyles.find((s) => s.id === currentStyleId);
  if (active) applyStyle(active);
  else selectStyle('dark');
}

// HTML for the settings modal's theme picker: one row per available style (built-in
// + custom), current one marked active. Pure — no DOM writes; the caller (settings.js)
// splices this into the modal body it re-renders on every open.
export function renderThemeRows() {
  return allStyles()
    .map((s) => `<button class="theme-row${s.id === currentStyleId ? ' active' : ''}" data-id="${esc(s.id)}">${styleIconMarkup(s)}<span>${esc(s.name)}</span></button>`)
    .join('');
}

// Wire up the persisted (or migrated) built-in style immediately; a persisted
// custom style resolves once /api/styles loads. Called once at startup.
export function initStyles() {
  // Migrate the old cm-theme ('dark'/'light') into cm-style on first run.
  currentStyleId = localStorage.getItem('cm-style')
    || (localStorage.getItem('cm-theme') === 'light' ? 'light' : 'dark');
  localStorage.setItem('cm-style', currentStyleId);
  applyStyle(BUILT_IN_STYLES.find((s) => s.id === currentStyleId) || BUILT_IN_STYLES[0]);

  fetch('/api/styles').then((r) => r.json()).then((d) => setCustomStyles(d.styles)).catch(() => {});
}
