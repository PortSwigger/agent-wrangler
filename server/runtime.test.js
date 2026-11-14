import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardPort, deckPort, bindHost, sessionApiPort, setSessionApiPort } from './runtime.js';

test('boardPort prefers AW_PORT, then PORT, then 7878', () => {
  const save = { aw: process.env.AW_PORT, p: process.env.PORT };
  try {
    process.env.AW_PORT = '9001'; process.env.PORT = '9002';
    assert.equal(boardPort(), 9001);
    delete process.env.AW_PORT;
    assert.equal(boardPort(), 9002);
    delete process.env.PORT;
    assert.equal(boardPort(), 7878);
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

test('the session API sits next to the deck port, with or without a board, unless set or already bound', () => {
  const keys = ['AW_PORT', 'AW_DECK_PORT', 'AW_DECK_ONLY', 'AW_SESSION_API_PORT'];
  const save = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    process.env.AW_PORT = '9001';
    assert.equal(deckPort(), 9002);
    assert.equal(sessionApiPort(), 9003);
    process.env.AW_DECK_ONLY = '1';
    process.env.AW_DECK_PORT = '9100';
    assert.equal(sessionApiPort(), 9101);
    process.env.AW_SESSION_API_PORT = '9200';
    assert.equal(sessionApiPort(), 9200);
    setSessionApiPort(9300);
    assert.equal(sessionApiPort(), 9300);
  } finally {
    setSessionApiPort(null);
    for (const k of keys) if (save[k] === undefined) delete process.env[k]; else process.env[k] = save[k];
  }
});
