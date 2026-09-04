export function supportsChatView(session) {
  return session?.agent !== 'codex';
}

export function viewForSession(session, stored, chatViewDefault) {
  if (!supportsChatView(session)) return 'terminal';
  if (stored === 'chat' || stored === 'terminal') return stored;
  return chatViewDefault ? 'chat' : 'terminal';
}
