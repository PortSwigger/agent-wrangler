#!/usr/bin/env node
// PostToolUse hook (matcher: Bash) injected into wrangler-launched Claude
// sessions via `claude --settings`. A pure passive observer: it reads the hook
// payload on stdin, and if the agent just ran `gh pr create` and a PR url is in
// the output, POSTs it to the wrangler so the PR attaches to THIS session's card
// (identity from $AW_SESSION_ID — the card id, inherited from the launch env).
// All errors are swallowed and it always exits 0 with no stdout, so it can never
// disrupt the tool result or the session. The parsing lives in server/pr-hook.js
// (unit-tested); this file is just the I/O wrapper.
import { extractCreatedPrUrl } from '../server/pr-hook.js';

async function main() {
  const url = process.env.AW_PR_ATTACH_URL;
  const session = process.env.AW_SESSION_ID;
  if (!url || !session) return;

  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;

  const prUrl = extractCreatedPrUrl(stdin);
  if (!prUrl) return;

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AW-Session': session },
    body: JSON.stringify({ url: prUrl }),
  });
}

main().catch(() => {}).finally(() => process.exit(0));
