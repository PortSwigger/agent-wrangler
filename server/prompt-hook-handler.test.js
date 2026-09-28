import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHttpServer } from './http-handler.js';
import { createPromptHookHandler } from './prompt-hook-handler.js';

const script = fileURLToPath(new URL('../scripts/prompt-hook.mjs', import.meta.url));

function runHook(url, sessionId, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, AW_PROMPT_HOOK_URL: url, AW_SESSION_ID: sessionId, AW_AGENT: 'codex' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('native hook command returns extension context in the same prompt response', async (t) => {
  const seen = [];
  const sm = {
    acceptsPromptHook: (id) => id === 'CARD',
    entryFor: () => null, // first prompt can precede the saved card entry
    runPromptHooks: async (payload) => {
      seen.push(payload);
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'set intent first' } };
    },
  };
  const server = createHttpServer({
    port: 0, promptHookHandler: createPromptHookHandler(sm),
    mcpRequestHandler: (_req, res) => res.end(),
    prAttachHandler: (_req, res) => res.end(),
    fileHandler: (_req, res) => res.end(),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/prompt-hook`;
  const input = { hook_event_name: 'UserPromptSubmit', session_id: 'LIVE', cwd: '/repo', model: 'gpt-6-sol', prompt: 'fix it' };
  const result = await runHook(url, 'CARD', input);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, 'set intent first');
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].sessionId, seen[0].liveSessionId, seen[0].agent, seen[0].prompt, seen[0].entry], ['CARD', 'LIVE', 'codex', 'fix it', null]);

  // The bridge must not turn a subagent prompt into a parent-card event.
  const sub = await runHook(url, 'CARD', { ...input, agent_id: 'subagent-1' });
  assert.equal(sub.stdout, '');
  assert.equal(seen.length, 1);
  const unknown = await runHook(url, 'OTHER', input);
  assert.equal(unknown.stdout, '');
  assert.equal(seen.length, 1);
});
