#!/usr/bin/env node
// PostToolUse hook (matcher: Bash) injected into wrangler-launched Codex
// sessions (server/codex-hook-config.js). If the agent just ran `gh pr create`
// and a PR url is in the output, it starts scripts/pr-model-footer.mjs detached,
// which tags the PR body with the session's model. It never attaches the PR to
// a card. Codex's payload has the same shape as Claude's (tool_input.command,
// tool_response), so server/pr-hook.js parses it. All errors are swallowed and
// it always exits 0 with no stdout.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractCreatedPrUrl } from '../server/pr-hook.js';

const FOOTER_SCRIPT = fileURLToPath(new URL('./pr-model-footer.mjs', import.meta.url));

async function main() {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;

  const prUrl = extractCreatedPrUrl(stdin);
  if (!prUrl || !process.env.AW_PR_MODEL_URL || !process.env.AW_SESSION_ID) return;
  const child = spawn(process.execPath, [FOOTER_SCRIPT, prUrl], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

main().catch(() => {}).finally(() => process.exit(0));
