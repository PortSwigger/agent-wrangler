export function errorKind(value) {
  if (typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(value)) return value;
  return null;
}

export function claudeLastTurn(entry) {
  const at = Date.parse(entry.timestamp);
  if (!Number.isFinite(at)) return null;
  if (entry.isApiErrorMessage) {
    const kind = errorKind(entry.error);
    return { outcome: 'error', ...(kind ? { errorKind: kind } : {}), at };
  }
  const msg = entry.message;
  if (msg?.role === 'assistant' && msg.stop_reason === 'end_turn') return { outcome: 'ok', at };
  const content = msg?.content;
  const interrupted = (text) => /^\[Request interrupted by user(?: for tool use)?\]$/.test(text);
  if (msg?.role === 'user' && (typeof content === 'string' ? interrupted(content) : Array.isArray(content) && content.some((b) => b?.type === 'text' && interrupted(b.text)))) {
    return { outcome: 'aborted', at };
  }
  return null;
}

