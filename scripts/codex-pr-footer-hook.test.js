import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('./codex-pr-footer-hook.mjs', import.meta.url));
const PR = 'https://github.com/acme/widgets/pull/42';

// Codex's PostToolUse payload for its shell tool, as codex-cli 0.165.0 sends it.
function payload(command, output) {
  return JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: output });
}

// A stand-in wrangler that records every request and answers no model, so the
// footer stops before running gh.
async function withServer(fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, session: req.headers['x-aw-session'] });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"model":null}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    server.close();
  }
}

function runHook(stdin, env) {
  return spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', env: { ...process.env, ...env } });
}

async function waitFor(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

test('after gh pr create, the hook asks the wrangler for the model, never attaches, and stays silent', async () => {
  await withServer(async (base, requests) => {
    const r = runHook(payload('gh pr create --title T --body B', `${PR}\n`), { AW_SESSION_ID: 'card-1', AW_PR_MODEL_URL: `${base}/pr-model`, AW_PR_ATTACH_URL: `${base}/pr-attach` });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.ok(await waitFor(() => requests.length > 0), 'footer never called the wrangler');
    assert.deepEqual(requests, [{ method: 'POST', url: '/pr-model', session: 'card-1' }]);
  });
});

test('a command that only prints a PR url starts nothing', async () => {
  await withServer(async (base, requests) => {
    const r = runHook(payload(`gh pr view ${PR}`, `${PR}\n`), { AW_SESSION_ID: 'card-1', AW_PR_MODEL_URL: `${base}/pr-model` });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(await waitFor(() => requests.length > 0, 500), false);
  });
});

test('garbage on stdin, or no lookup url, still exits 0 with no output', () => {
  for (const [stdin, env] of [['not json', {}], [payload('gh pr create', PR), { AW_PR_MODEL_URL: '' }]]) {
    const r = runHook(stdin, env);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});
