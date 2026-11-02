import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrModelHandler } from './pr-model-handler.js';
import { claudeModelId } from './agents/claude.js';

function call(handler, headers = {}) {
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      status: 0,
      writeHead(status) { this.status = status; this.headersSent = true; return this; },
      end(body) { resolve({ status: this.status, body }); },
    };
    handler({ headers }, res);
  });
}

const graph = {
  sessions: [
    { sessionId: 'LIVE', agent: 'claude', currentModel: 'claude-sonnet-5-5', model: 'opus' },
    { sessionId: 'FRESH', agent: 'claude', currentModel: null, model: 'opus' },
    { sessionId: 'CODEX', agent: 'codex', currentModel: null, model: 'gpt-5.5' },
  ],
};
const entries = { ARCHIVED: { agent: 'claude', model: 'haiku' } };
const handler = (enabled = true) => createPrModelHandler({ graph: () => graph, entryFor: (id) => entries[id] || null, enabled: () => enabled });
const model = async (h, session) => JSON.parse((await call(h, { 'x-aw-session': session })).body).model;

test('answers the live transcript model over the launch model', async () => {
  assert.equal(await model(handler(), 'LIVE'), 'claude-sonnet-5-5');
});

test('falls back to the launch model as an exact id', async () => {
  assert.equal(await model(handler(), 'FRESH'), claudeModelId('opus'));
  assert.match(await model(handler(), 'FRESH'), /^claude-opus-/);
  assert.equal(await model(handler(), 'CODEX'), 'gpt-5.5');
  assert.match(await model(handler(), 'ARCHIVED'), /^claude-haiku-/);
});

test('null with the setting off, or for an unknown card', async () => {
  assert.equal(await model(handler(false), 'LIVE'), null);
  assert.equal(await model(handler(), 'NOPE'), null);
});

test('400 without a caller', async () => {
  assert.equal((await call(handler())).status, 400);
});
