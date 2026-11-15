#!/usr/bin/env node
// Status hook for sessions on a runtime with `statusEvents: true`
// (docs/session-api.md, "Status events"). Claude and Codex run it on each hook
// event the launch names, with the state as its one argument:
//
//   status-event-hook.mjs working|waiting-permission|waiting-input|idle
//
// It POSTs { state, at, sessionId?, detail? } to $AW_STATUS_EVENT_URL with
// $AW_SESSION_TOKEN as the bearer. `sessionId` is the agent's conversation id
// from the hook payload; `detail`, for a waiting state, is a Notification's
// message or the tool a PermissionRequest asks for. It always exits 0
// with no stdout, so it never changes what the agent does. Node builtins only and
// no imports of its own, so a runtime installs it by copying this one file.
const STATES = new Set(['working', 'waiting-permission', 'waiting-input', 'idle']);
const STDIN_CAP = 256 * 1024;

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let text = '';
  for await (const chunk of process.stdin) {
    if (text.length < STDIN_CAP) text += chunk;
  }
  return text;
}

async function main() {
  const state = process.argv[2];
  const url = process.env.AW_STATUS_EVENT_URL;
  const token = process.env.AW_SESSION_TOKEN;
  const at = Date.now();
  let payload = null;
  try { payload = JSON.parse(await readStdin()); } catch {}
  if (!STATES.has(state) || !url || !token) return;
  const body = { state, at };
  const sid = payload?.session_id;
  if (typeof sid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sid)) body.sessionId = sid;
  if (state.startsWith('waiting-')) {
    const tool = typeof payload?.tool_name === 'string' && payload.tool_name ? `Permission to use ${payload.tool_name}` : null;
    const detail = typeof payload?.message === 'string' && payload.message ? payload.message : tool;
    if (detail) body.detail = detail.slice(0, 200);
  }
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  });
}

main().catch(() => {}).finally(() => process.exit(0));
