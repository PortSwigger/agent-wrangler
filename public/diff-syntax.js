// Pure projection/token adapter shared by the worker, coordinator and tests.
export const LIMITS = Object.freeze({ source: 64 * 1024, line: 8 * 1024, diff: 512 * 1024, segments: 16000, renderSegments: 32000, depth: 32, cache: 2 * 1024 * 1024 });
const extensions = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript',
  jsx: 'jsx', tsx: 'tsx', json: 'json', html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
  css: 'css', sh: 'bash', bash: 'bash', py: 'python', yaml: 'yaml', yml: 'yaml', md: 'markdown', markdown: 'markdown',
};
export function languageForPath(path) {
  const name = String(path ?? '').split('/').pop().toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = name.slice(dot + 1);
  return dot < 0 || !Object.hasOwn(extensions, ext) ? null : extensions[ext];
}
export function projectHunk(lines, side) {
  return (lines || []).filter((ln) => ln.type === 'context' || ln.type === (side === 'old' ? 'del' : 'add'));
}
export function admittedSource(lines) {
  // UTF-16 bytes: a conservative budget for typical ASCII source.
  if (lines.some((ln) => ln.text.length * 2 > LIMITS.line)) return null;
  const source = lines.map((ln) => ln.text).join('\n');
  return source.length * 2 <= LIMITS.source ? source : null;
}
const roles = {
  comment: 'comment', prolog: 'comment', doctype: 'comment', cdata: 'comment', keyword: 'keyword',
  string: 'string', 'template-string': 'string', 'template-punctuation': 'string', 'attr-value': 'string',
  function: 'function', 'class-name': 'function', tag: 'function', 'attr-name': 'function',
};
export const SYNTAX_ROLES = new Set(Object.values(roles));
export function tokenLines(tokens, source) {
  const lines = [[]];
  let count = 0;
  function walk(token, inherited = '', depth = 0) {
    if (depth > LIMITS.depth || ++count > LIMITS.segments) throw new Error('Token budget');
    if (typeof token === 'string') {
      const parts = token.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i) lines.push([]);
        if (parts[i]) lines.at(-1).push({ text: parts[i], role: inherited });
      }
    } else if (Array.isArray(token)) {
      for (const child of token) walk(child, inherited, depth + 1);
    } else if (token && typeof token.type === 'string') {
      walk(token.content, Object.hasOwn(roles, token.type) ? roles[token.type] : inherited, depth + 1);
    } else throw new Error('Invalid token');
  }
  walk(tokens);
  if (!validTokenLines(lines, source)) throw new Error('Token mismatch');
  return lines;
}
export function validTokenLines(lines, source) {
  if (!Array.isArray(lines) || lines.length !== source.split('\n').length) return false;
  let count = 0;
  for (const line of lines) {
    if (!Array.isArray(line)) return false;
    for (const seg of line) {
      if (++count > LIMITS.segments || !seg || typeof seg.text !== 'string' || seg.text.includes('\n') ||
          (seg.role !== '' && !SYNTAX_ROLES.has(seg.role))) return false;
    }
  }
  return lines.map((ln) => ln.map((s) => s.text).join('')).join('\n') === source;
}
