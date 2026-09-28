#!/usr/bin/env node
// Shared Claude/Codex UserPromptSubmit command hook. A local, bounded request
// asks Wrangler's extension registry for context before the model sees this
// prompt. On a server outage it exits successfully with no output so the user's
// prompt is never stranded by an optional extension.
async function main() {
  const url = process.env.AW_PROMPT_HOOK_URL;
  const sessionId = process.env.AW_SESSION_ID;
  if (!url || !sessionId) return;
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  const input = JSON.parse(stdin);
  if (input.hook_event_name !== 'UserPromptSubmit' || input.agent_id) return;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AW-Session': sessionId },
    body: JSON.stringify({ ...input, agent: process.env.AW_AGENT }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return;
  const result = await response.json();
  if (result && Object.keys(result).length) process.stdout.write(JSON.stringify(result));
}

main().catch(() => {}).finally(() => process.exit(0));
