import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { createHttpServer } from './http-handler.js';
import { createMcpRequestHandler } from './mcp/server.js';
import { routeControlMessage } from './control/router.js';
import { JobStore } from './job-store.js';
import { JobRunner } from './job-runner.js';

// Exercise the browser control protocol and real HTTP MCP schema together.
// External agent/GitHub work is replaced, so this never spends tokens or publishes.
test('real control + MCP lifecycle discovers repositories and requires human approval before implementation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-job-http-'));
  const store = new JobStore(path.join(dir, 'jobs.json'));
  let sid = 0;
  const alive = new Set();
  const runtime = { async launch(job, sub, run, bind) { const id = `session${++sid}`; alive.add(id); bind(id, { path: `/wt/${id}`, branch: id, repoRoot: '/repo' }); }, async stop(r) { alive.delete(r.sessionId); }, async isAlive(r) { return alive.has(r.sessionId); } };
  const runner = new JobRunner({ store, runtime, github: {} });
  const deps = { jobStore: store, rebuild: async () => {} };
  const server = createHttpServer({ port: 7878, mcpRequestHandler: createMcpRequestHandler(deps) });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => socket.on('message', (raw) => routeControlMessage(raw, { ...deps, runJobs: () => runner.tick(), reply: (msg) => socket.send(JSON.stringify(msg)) })));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  t.after(async () => { socket.terminate(); wss.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((r) => socket.once('open', r));
  const control = (msg) => new Promise((resolve) => { socket.once('message', (raw) => resolve(JSON.parse(raw))); socket.send(JSON.stringify(msg)); });
  const created = await control({ type: 'job-create', job: { title: 'Sign-in', intent: 'Reliable sign-in' } });
  assert.equal(created.type, 'job-created'); const id = created.jobId;
  assert.deepEqual(store.get(id).repos, []);
  await control({ type: 'job-action', id, action: 'start' }); await runner.tick();
  const run = store.get(id).runs[0]; assert.ok(run.sessionId);
  const plan = { stories: [{ id: 's', key: 'AUTH-1', title: 'Reliable sign-in', value: 'Customers can access accounts' }], subJobs: [{ id: 'api', title: 'Fix sign-in', repo: '/repo', storyId: 's', dependsOn: [], instructions: 'Implement and verify', deployment: { workflows: ['deploy.yml'], verify: 'Check deployed version' } }] };
  const reportBody = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'job_report', arguments: { runId: run.id, report: { kind: 'plan', plan } } } };
  const call = async (caller, origin) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-AW-Session': caller, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(reportBody) });
    return { response, body: response.ok ? await response.json() : null };
  };
  assert.equal((await call(run.sessionId, 'https://unrelated.example')).response.status, 403);
  assert.equal((await call('other')).body.result.isError, true);
  assert.equal((await call(run.sessionId)).body.result.structuredContent.accepted, true);
  await runner.tick(); assert.equal(sid, 1, 'report must not silently approve its own plan');
  const current = store.get(id);
  assert.deepEqual(current.repos, ['/repo']);
  const approved = await control({ type: 'job-action', id, action: 'approve-plan', revision: current.revision });
  assert.equal(approved.type, 'job-action-complete');
  await runner.tick(); assert.equal(store.get(id).stage, 'active'); assert.equal(sid, 2);
  assert.equal(new JobStore(store.file).get(id).subJobs[0].jiraKey, 'AUTH-1');
});
