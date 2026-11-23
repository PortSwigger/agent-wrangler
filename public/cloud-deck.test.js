import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectCloudDeck } from './cloud-deck.js';

const gateway = 'https://decks.example.com';
const ready = { state: 'ready', url: '/' };
const provisioning = { state: 'provisioning', statusUrl: '/status', phase: 'storage' };

test('connects with the browser session and polls until the deck is ready', async () => {
  const calls = [];
  const messages = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    return calls.length === 1 ? Response.json(provisioning, { status: 202 }) : Response.json(ready);
  };
  await connectCloudDeck(gateway, (s) => messages.push(s), { fetchImpl, wait: async () => {} });
  assert.deepEqual(messages, ['Preparing deck storage…']);
  assert.deepEqual(calls.map(([url, { method = 'GET' }]) => [url, method]), [
    [gateway + '/connect', 'POST'], [gateway + '/status', 'GET'],
  ]);
  for (const [, opts] of calls) {
    assert.equal(opts.credentials, 'include');
    assert.equal(opts.redirect, 'error');
    assert.equal(opts.body, undefined);
    assert.equal(opts.headers, undefined);
  }
});

test('stops on refusal, unavailable service and unexpected routes', async () => {
  for (const [response, error] of [
    [new Response(null, { status: 403 }), /Access refused/],
    [Response.json({ error: 'ineligible' }, { status: 403 }), /not eligible/],
    [new Response(null, { status: 503 }), /unavailable/],
    [Response.json({ ...provisioning, statusUrl: 'https://other.example.com/status' }, { status: 202 }), /unexpected/],
    [Response.json({ ...ready, url: 'https://other.example.com/' }), /unexpected/],
  ]) {
    await assert.rejects(connectCloudDeck(gateway, assert.fail, { fetchImpl: async () => response }), error);
  }
});
