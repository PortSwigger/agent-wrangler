export function viewKeyOf(value) {
  const s = String(value ?? '');
  const i = s.indexOf('&');
  return i < 0 ? s : s.slice(0, i);
}

export function parseViewHash(hash) {
  const m = String(hash || '').match(/^#view=(.+)$/);
  if (!m) return null;
  const rest = m[1];
  const i = rest.indexOf('&');
  const view = i < 0 ? rest : rest.slice(0, i);
  if (!view) return null;
  return { view, params: new URLSearchParams(i < 0 ? '' : rest.slice(i + 1)) };
}
