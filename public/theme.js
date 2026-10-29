import { updateDiffSyntaxPalette } from './diff-syntax-palette.js';
import { esc } from './util.js';

// Style picker: built-in dark/light/paper + drop-in styles (server-compiled manifests
// from /api/styles — contributed by extensions, the core Themes one included, or
// hand-placed under ~/.agent-wrangler/custom-styles/). Self-contained — it owns the theme vars and
// the xterm color read; the only outward coupling is a re-theme hook the app
// registers (onThemeChange) so a style change can re-paint a live terminal without
// this module importing the terminal's state (keeps the dependency one-way).
// There is no in-app way to create/edit a style — new ones ship in an extension.

// xterm renders to a canvas, so it can't inherit our CSS theme — it needs a JS
// color object. Read the resolved --term-* custom properties off the body so the
// canvas tracks whatever theme (today: dark/light) is applied; reassigning
// term.options.theme re-themes a live terminal.
// The canvas background: for a translucent (rgba) --term-bg we make the canvas
// fully transparent so it takes the #term wrapper's bg uniformly (wrapper carries
// the bg + padding — no double-paint, no frame). Opaque themes keep the real
// colour. Caveat: a transparent canvas reports black to the program (OSC 11), so
// the terminal renders dark-theme diffs — so a translucent theme should be
// dark-toned; opaque themes report their true lightness so
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

// The terminals' font family, from the theme's --font-mono. Read separately from
// readTerminalTheme because xterm takes it as its own option, not a colour.
export function readTerminalFont() {
  return getComputedStyle(document.body).getPropertyValue('--font-mono').trim()
    || 'ui-monospace, SFMono-Regular, Menlo, monospace';
}

const MOON_ICON = '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>';
const SUN_ICON = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>';
const PAPER_ICON = '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>';
// Paper: Light tuned for long reading. No wallpaper. Off-white and off-black
// rather than pure white and black, a slightly darker board so the reading pane
// stands forward, Inter and Roboto Mono (loaded in index.html) and a
// centred chat column.
const PAPER_VARS = {
  '--bg': '#eceef1', '--surface': '#fcfcfb', '--surface-2': '#e9ebee',
  '--fg': '#1b1d21', '--fg-muted': '#4b535e', '--fg-subtle': '#69717d',
  '--border': '#d2d6dc', '--border-muted': '#e0e3e7',
  '--chrome': '#e5e8ec',
  '--tile-bg': '#f3f4f6', '--card-bg': 'var(--surface)',
  '--pill-idle-bg': '#e9ebee',
  '--field-bg': '#ffffff',
  '--term-bg': '#fbfbfa', '--term-fg': '#1b1d21', '--term-cursor': '#1b1d21',
  '--font': '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  '--font-mono': '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  '--prose-leading': '1.6',
  // Pink-red, so inline code never reads as a link.
  '--code-fg': '#b3195a',
  // Indigo links, with a faint underline so a link never relies on colour
  // alone. Hover draws the underline solid.
  '--link-fg': '#4f46e5',
  '--link-decoration': 'underline 1px color-mix(in srgb, #4f46e5 35%, transparent)',
  // Paler than --surface-2, which buttons and chips share.
  '--code-bg': '#f1f2f4', '--bubble-bg': '#f1f2f4',
  // Kept at 1px so the blocks don't change size, just invisible.
  '--code-border': 'transparent', '--bubble-border': 'transparent',
  '--chat-measure': '68em',
};
const BUILT_IN_STYLES = [
  { id: 'dark', name: 'Dark', base: 'dark', iconInner: MOON_ICON, vars: {}, wallpaperUrl: '/dark-bg.png' },
  { id: 'light', name: 'Light', base: 'light', iconInner: SUN_ICON, vars: {}, wallpaperUrl: '/light-bg.png' },
  { id: 'paper', name: 'Paper', base: 'light', iconInner: PAPER_ICON, vars: PAPER_VARS },
];
let customStyles = [];
let currentStyleId = 'dark';
let appliedVarKeys = [];

// The app registers a callback here to re-theme a live terminal when the style
// changes — keeps theme.js from importing the terminal's `current` handle. It is
// called with { id, base }, which app.js also hands to api.onThemeChange.
let themeChangeHook = null;
export function onThemeChange(fn) { themeChangeHook = fn; }

function allStyles() { return [...BUILT_IN_STYLES, ...customStyles]; }
// The style on screen: the saved one, or Dark while it is unavailable (its
// extension is off, or /api/styles has not answered yet).
function effectiveStyle() { return allStyles().find((s) => s.id === currentStyleId) || BUILT_IN_STYLES[0]; }
function styleIconInner(s) { return s.iconInner ?? `<path d="${esc(s.icon || '')}"/>`; }
// Stroke icons (lucide-style, the default) share the rail's 24-grid + currentColor
// outline. A theme can instead ship a filled silhouette (iconFill) on its own
// viewBox — then we fill rather than stroke so a dense path reads as a solid shape.
// The icon-fill / icon-stroke class lets a container draw every theme's icon at
// one size and weight whatever its viewBox (see .theme-tile in styles.css).
function styleIconSvg(s) {
  const vb = esc(s.iconViewBox || '0 0 24 24');
  const paint = s.iconFill ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor"';
  return `<svg class="icon ${s.iconFill ? 'icon-fill' : 'icon-stroke'}" viewBox="${vb}" ${paint} stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${styleIconInner(s)}</svg>`;
}

// An icon image URL is only ever a same-origin asset path (/styles/...) or a
// data:image/ upload preview. Allowlist those; reject anything else.
export function safeIconUrl(url) {
  if (typeof url !== 'string' || url === '') return null;
  if (/^data:image\//i.test(url)) return url;
  if (url[0] !== '/') return null;
  try {
    const parsed = new URL(url, location.origin);
    if (parsed.origin !== location.origin) return null;
    // Return the re-parsed path, not the raw input: origin-only bypasses
    // (protocol-relative //, backslash variants, ...) never survive into
    // pathname/search/hash, so this can't carry a foreign host to the sink.
    return parsed.pathname + parsed.search + parsed.hash;
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
// The palette half is skipped when neither base nor vars moved: a manifest that
// only repointed its wallpaper (a watcher rotating stills every few minutes) must
// not strip and re-set every var and repaint the xterm canvas for nothing.
function applyStyle(style) {
  const vars = style.vars || {};
  const paletteKey = JSON.stringify([style.base, vars]);
  if (paletteKey !== appliedPaletteKey) {
    appliedPaletteKey = paletteKey;
    document.body.classList.toggle('light', style.base === 'light');
    for (const k of appliedVarKeys) document.body.style.removeProperty(k);
    appliedVarKeys = Object.keys(vars);
    for (const [k, v] of Object.entries(vars)) document.body.style.setProperty(k, v);
    updateDiffSyntaxPalette();
    themeChangeHook?.({ id: style.id, base: style.base === 'light' ? 'light' : 'dark' });
  }
  setBackground(style);
  setFavicon(style);
}

// A background-image assigned before the browser holds the file paints as NO
// image until the fetch+decode lands — on a translucent style that is a
// whole-board flash to the flat colour, every frosted surface included, on
// every wallpaper change. So a wallpaper URL is fetched and decoded off-screen
// first and only assigned once it is ready; a raw CSS `background` (gradients)
// needs no asset and goes straight on. Only the newest request may land — a
// second change while a decode is in flight supersedes it — and a failed load
// still assigns, so this degrades to the old behaviour rather than to a stuck
// wallpaper. Without an Image constructor (tests) it assigns synchronously.
let wantedBackground = null;
let appliedPaletteKey = null;
let wallpaperSeq = 0;
function setBackground(style) {
  const bg = style.background
    ? style.background
    : (style.wallpaperUrl ? `url("${style.wallpaperUrl}")` : '');
  if (bg === wantedBackground) return;
  wantedBackground = bg;
  const seq = ++wallpaperSeq;
  const commit = () => { if (seq === wallpaperSeq) document.body.style.backgroundImage = bg; };
  if (!style.wallpaperUrl || style.background || typeof Image !== 'function') { commit(); return; }
  const img = new Image();
  img.src = style.wallpaperUrl;
  const ready = typeof img.decode === 'function'
    ? img.decode()
    : new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; });
  ready.then(commit, commit);
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
// An id that is not available is ignored rather than saved as Dark.
export function selectStyle(id) {
  const style = allStyles().find((s) => s.id === id);
  if (!style) return;
  currentStyleId = style.id;
  localStorage.setItem('cm-style', currentStyleId);
  applyStyle(style);
}

// New custom-style set (the /api/styles fetch, and every `styles` push — a
// theme dir edited on disk, or an extension contributing themes turned on or
// off). Re-apply the active style if it's a custom one (its colors may have
// changed); show Dark while it is missing, WITHOUT persisting that, so the saved
// choice comes back with its theme. Built-ins are unaffected by the custom set.
export function setCustomStyles(styles) {
  customStyles = Array.isArray(styles) ? styles : [];
  if (BUILT_IN_STYLES.some((s) => s.id === currentStyleId)) return;
  applyStyle(effectiveStyle());
}

// A theme's own colours for its picker button, read from its vars (an
// /api/styles entry) or its raw theme.json `colors` (a theme that is switched
// off, which /api/styles leaves out), never the live CSS, so every button shows
// its theme and not the one on screen.
// --panel-bg is the opaque one; --bg/--surface are often translucent over a
// wallpaper. Dark and Light carry no vars and take their base's values from
// styles.css. A value is a hand-placed theme.json string headed for a style
// attribute, so only plain colour syntax gets through.
const BASE_SWATCH = {
  dark: { tile: '#151b23', ink: '#f0f6fc', dots: ['#1f6feb', '#3fb950', '#f85149'] },
  light: { tile: '#ffffff', ink: '#1f2328', dots: ['#0969da', '#1a7f37', '#cf222e'] },
};
const COLOUR_RE = /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d\s.,%/+-]+\))$/i;
export function safeColour(v) { return typeof v === 'string' && COLOUR_RE.test(v.trim()) ? v.trim() : null; }
export function themeSwatch(s) {
  const fallback = BASE_SWATCH[s.base === 'light' ? 'light' : 'dark'];
  const vars = s.vars || {};
  const colors = s.colors || {};
  const pick = (keys, dflt) => keys.map((k) => safeColour(vars[`--${k}`]) || safeColour(colors[k])).find(Boolean) || dflt;
  return {
    tile: pick(['panel-bg', 'surface'], fallback.tile),
    ink: pick(['fg'], fallback.ink),
    dots: [pick(['accent'], fallback.dots[0]), pick(['green'], fallback.dots[1]), pick(['red'], fallback.dots[2])],
  };
}

const CHECK_ICON = '<svg class="theme-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

// One theme's picker button: its icon on a tile in the theme's own panel and
// text colours, its name, and a strip of its accent/green/red. `style` is an
// /api/styles entry, a built-in, or a raw theme.json with an `id` added. Exported so an extension can draw the same
// button (app.js hands it to the client api as api.themeButtonHtml); clicks are the
// caller's — the markup carries data-id and toggles nothing itself.
export function themeButtonHtml(style, { active = false } = {}) {
  const sw = themeSwatch(style);
  const dots = sw.dots.map((c) => `<i style="background:${c}"></i>`).join('');
  return `<button class="theme-row${active ? ' active' : ''}" data-id="${esc(style.id)}" type="button" aria-pressed="${active}">`
    + `<span class="theme-tile" style="background:${sw.tile};color:${sw.ink}">${styleIconMarkup(style)}</span>`
    + `<span class="theme-meta"><span class="theme-name">${esc(style.name)}</span><span class="theme-dots" aria-hidden="true">${dots}</span></span>`
    + `${CHECK_ICON}</button>`;
}

// HTML for the settings modal's theme picker: one button per available style
// (built-in + custom), current one marked active. Pure — no DOM writes; the
// caller (settings.js) splices this into the modal body it re-renders on every open.
export function renderThemeRows() {
  const active = effectiveStyle().id;
  return allStyles().map((s) => themeButtonHtml(s, { active: s.id === active })).join('');
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
