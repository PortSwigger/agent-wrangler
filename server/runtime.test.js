import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverPort, deckPort, deckOnly, bindHost } from './runtime.js';

test('serverPort prefers AW_PORT, then PORT, then 7878', () => {
  const save = { aw: process.env.AW_PORT, p: process.env.PORT };
  try {
    process.env.AW_PORT = '9001'; process.env.PORT = '9002';
    assert.equal(serverPort(), 9001);
    delete process.env.AW_PORT;
    assert.equal(serverPort(), 9002);
    delete process.env.PORT;
    assert.equal(serverPort(), 7878);
  } finally {
    if (save.aw === undefined) delete process.env.AW_PORT; else process.env.AW_PORT = save.aw;
    if (save.p === undefined) delete process.env.PORT; else process.env.PORT = save.p;
  }
});

test('bindHost defaults to loopback, honours AW_BIND_HOST override', () => {
  const save = process.env.AW_BIND_HOST;
  try {
    delete process.env.AW_BIND_HOST;
    assert.equal(bindHost(), '127.0.0.1');
    process.env.AW_BIND_HOST = '0.0.0.0';
    assert.equal(bindHost(), '0.0.0.0');
  } finally {
    if (save === undefined) delete process.env.AW_BIND_HOST; else process.env.AW_BIND_HOST = save;
  }
});

test('serverPort is the deck port in deck-only mode, so sessions reach MCP with no board', () => {
  const keys = ['AW_PORT', 'AW_DECK_PORT', 'AW_DECK_ONLY'];
  const save = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.AW_PORT = '9001'; delete process.env.AW_DECK_PORT; delete process.env.AW_DECK_ONLY;
    assert.equal(deckOnly(), false);
    assert.equal(serverPort(), 9001);
    assert.equal(deckPort(), 9002);
    process.env.AW_DECK_ONLY = '1';
    assert.equal(deckOnly(), true);
    assert.equal(serverPort(), 9002);
    process.env.AW_DECK_PORT = '9100';
    assert.equal(serverPort(), 9100);
    process.env.AW_DECK_ONLY = '0';
    assert.equal(serverPort(), 9001);
  } finally {
    for (const k of keys) if (save[k] === undefined) delete process.env[k]; else process.env[k] = save[k];
  }
});
