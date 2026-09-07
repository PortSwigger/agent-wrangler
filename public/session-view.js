// Which view a session opens in: the human's saved per-session choice if there
// is one, otherwise the board's `chatViewDefault` setting.
//
// Agent-agnostic. Codex was forced to 'terminal' here for as long as the server
// could not resolve a Codex rollout (PR #94) — that resolution now exists
// (server/conversation-file.js), so there is no longer an agent this view cannot
// render and no agent gate to apply.
export function viewForSession(stored, chatViewDefault) {
  if (stored === 'chat' || stored === 'terminal') return stored;
  return chatViewDefault ? 'chat' : 'terminal';
}
