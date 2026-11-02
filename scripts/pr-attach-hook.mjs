#!/usr/bin/env node
// PostToolUse hook (matcher: Bash) injected into wrangler-launched Claude
// sessions via `claude --settings`. A pure passive observer: it reads the hook
// payload on stdin, and if the agent just ran `gh pr create` and a PR url is in
// the output, it
//   - POSTs it to the wrangler so the PR attaches to THIS session's card
//     (identity from $AW_SESSION_ID — the card id, inherited from the launch env);
//   - starts scripts/pr-model-footer.mjs detached, which tags the PR body with
//     the session's model. Detached so the gh round trips never delay the tool
//     result; independent of the attach, which the server may have switched off.
// All errors are swallowed and it always exits 0 with no stdout, so it can never
// disrupt the tool result or the session. The parsing lives in server/pr-hook.js
// (unit-tested); this file is just the I/O wrapper.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractCreatedPrUrl } from '../server/pr-hook.js';

const FOOTER_SCRIPT = fileURLToPath(new URL('./pr-model-footer.mjs', import.meta.url));

function startModelFooter(prUrl) {
  if (!process.env.AW_PR_MODEL_URL || !process.env.AW_SESSION_ID) return;
  const child = spawn(process.execPath, [FOOTER_SCRIPT, prUrl], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

async function main() {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;

  const prUrl = extractCreatedPrUrl(stdin);
  if (!prUrl) return;

  try { startModelFooter(prUrl); } catch {}

  const url = process.env.AW_PR_ATTACH_URL;
  const session = process.env.AW_SESSION_ID;
  if (!url || !session) return;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AW-Session': session },
    body: JSON.stringify({ url: prUrl }),
  });
}

main().catch(() => {}).finally(() => process.exit(0));
