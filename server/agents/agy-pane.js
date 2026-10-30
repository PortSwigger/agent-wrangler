const ansi = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const plain = (text) => String(text || '').replace(ansi, '');
const modal = /Do you trust the contents|Requesting permission|Run this command\?|Allow calling this tool\?|not signed in|Select login method|Choose your colou?r scheme|Terms of Service|Data Use|review (?:this )?(?:artifact|plan)|artifact review|feedback survey|Individual quota reached|quota exceeded|authentication (?:failed|required)/i;
function footer(text) {
  const lines = plain(text).split('\n');
  const bottom = lines.findLastIndex((line) => /^\s*[─━-]{5,}\s*$/.test(line));
  return bottom < 0 ? '' : lines.slice(bottom + 1).join('\n');
}
function mode(text) {
  return /(?:^|\s)(auto|accept-edits|default)(?=\s|·|$)/m.exec(footer(text))?.[1] || null;
}
function composer(text) {
  const lines = plain(text).split('\n');
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*[─━-]{5,}\s*$/.test(lines[i])) { bottom = i; break; }
  if (bottom < 0) return null;
  let top = bottom - 1;
  while (top >= 0 && !/^\s*[─━-]{5,}\s*$/.test(lines[top])) top--;
  if (top < 0 || !/^\s*>/.test(lines[top + 1] || '')) return null;
  const draft = lines.slice(top + 1, bottom).map((line, i) => i === 0 ? line.replace(/^\s*> ?/, '') : line.replace(/^  /, '')).join('\n').trimEnd();
  if (draft.replace(/\s+/g, ' ') === 'Accept-edits mode: file edits auto-approved (shift+tab to cycle)' && /\? for shortcuts/.test(footer(text)) && mode(text) === 'accept-edits') return '';
  return draft;
}
export const agyPane = {
  mode,
  ready(text) { return !modal.test(plain(text)) && composer(text) !== null; },
  empty(text) { return this.ready(text) && composer(text).trim() === ''; },
  draft(text) { return this.ready(text) ? composer(text) : null; },
  classify(text) {
    const value = plain(text);
    const blocked = modal.exec(value);
    if (blocked) return { status: 'needs-you', waitingFor: blocked[0] };
    if (!this.ready(text)) return { status: 'unknown', waitingFor: null };
    return { status: /esc to cancel/i.test(value) ? 'working' : 'idle', waitingFor: null };
  },
  model(text) { return /((?:Gemini|Claude|GPT)[^\n]*?)(?:\s{2,}|$)/im.exec(plain(text).split('\n').slice(-4).join('\n'))?.[1]?.trim() || null; },
  imageCount(text) { return Number(/(\d+) media attached/.exec(plain(text))?.[1] || 0); },
};
