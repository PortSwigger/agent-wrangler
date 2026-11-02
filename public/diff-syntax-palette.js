// Theme-derived ink over the same overlays used by diff rows.
const inputs = { comment: '--fg-muted', keyword: '--purple', string: '--cyan', function: '--blue-fg' };
export function over(a, b) { return a.slice(0, 3).map((v, i) => v * (a[3] ?? 1) + b[i] * (1 - (a[3] ?? 1))); }
function luminance(c) {
  return c.slice(0, 3).map((v) => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; })
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
}
export function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
export function readableInk(candidate, fg, backgrounds) {
  if (!backgrounds.every((bg) => contrast(fg, bg) >= 4.5)) return fg.slice(0, 3);
  for (let step = 0; step <= 20; step++) {
    const t = step / 20;
    const chosen = candidate.slice(0, 3).map((v, i) => Math.round(v * (1 - t) + fg[i] * t));
    if (backgrounds.every((bg) => contrast(chosen, bg) >= 4.5)) return chosen;
  }
  return fg.slice(0, 3);
}
export function updateDiffSyntaxPalette() {
  // Canvas normalizes browser-supported CSS colours. Minimal DOMs stay plain.
  const canvas = document.createElement?.('canvas');
  const ctx = canvas?.getContext?.('2d', { willReadFrequently: true });
  if (!ctx) return;
  canvas.width = canvas.height = 1;
  const style = getComputedStyle(document.body);
  const value = (name) => style.getPropertyValue(name).trim();
  const rgb = (name) => {
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value(name) || value('--fg'); ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].map((v, i) => i === 3 ? v / 255 : v);
  };
  const backgrounds = [];
  // Check wallpaper extremes through the translucent body/panel/source layers.
  for (const backdrop of [[0, 0, 0], [255, 255, 255]]) {
    const surface = over(rgb('--surface'), over(rgb('--term-bg'), over(rgb('--bg'), backdrop)));
    const bases = [surface, ...['green', 'red'].map((name) => {
      const colour = rgb(`--term-ansi-${name}`); colour[3] *= .14; return over(colour, surface);
    })];
    const accent = rgb('--accent'); accent[3] *= .16;
    backgrounds.push(...bases, ...bases.map((bg) => over(accent, bg)));
  }
  const fg = rgb('--fg');
  for (const [role, fallback] of Object.entries(inputs)) {
    const chosen = readableInk(rgb(value(`--syntax-${role}`) ? `--syntax-${role}` : fallback), fg, backgrounds);
    document.body.style.setProperty(`--diff-syntax-${role}`, `rgb(${chosen.join(',')})`);
  }
}
