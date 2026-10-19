// Which view a session opens in: the human's saved per-session choice if there
// is one, otherwise the board's `chatViewDefault` setting.
//
// Codex was forced to 'terminal' here for as long as the server could not
// resolve a Codex rollout (PR #94) — that resolution now exists
// (server/conversation-file.js). An agent whose session files the chat view
// cannot read yet (pi) says so on the server's `agents` message (`chat: false`),
// and its sessions open in the terminal whatever was stored.
export function viewForSession(stored, chatViewDefault, { chat = true } = {}) {
  if (!chat) return 'terminal';
  if (stored === 'chat' || stored === 'terminal') return stored;
  return chatViewDefault ? 'chat' : 'terminal';
}
