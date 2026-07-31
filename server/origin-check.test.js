import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedOrigin, isAllowedHost } from './origin-check.js';

const PORT = 7878;

test('isAllowedOrigin: absent Origin is allowed (non-browser CLI/MCP clients)', () => {
  assert.equal(isAllowedOrigin(undefined, PORT), true);
  assert.equal(isAllowedOrigin(null, PORT), true);
  assert.equal(isAllowedOrigin('', PORT), true);
});

test('isAllowedOrigin: the app\'s own loopback origins on its port are allowed', () => {
  assert.equal(isAllowedOrigin(`http://localhost:${PORT}`, PORT), true);
  assert.equal(isAllowedOrigin(`http://127.0.0.1:${PORT}`, PORT), true);
});

test('isAllowedOrigin: a foreign origin is rejected', () => {
  assert.equal(isAllowedOrigin('http://evil.example', PORT), false);
  assert.equal(isAllowedOrigin('https://localhost', PORT), false);
});

test('isAllowedOrigin: wrong-port loopback is rejected (port-specific)', () => {
  // Port-specific by design: another loopback service on a different port is a
  // distinct origin and the browser sends its real port, so we pin to ours.
  assert.equal(isAllowedOrigin('http://localhost:9999', PORT), false);
  assert.equal(isAllowedOrigin('http://127.0.0.1:1234', PORT), false);
});

test('isAllowedOrigin: AW_ALLOWED_ORIGINS widens the set without losing the default', () => {
  const prev = process.env.AW_ALLOWED_ORIGINS;
  process.env.AW_ALLOWED_ORIGINS = 'http://board.local, http://other:1';
  try {
    assert.equal(isAllowedOrigin('http://board.local', PORT), true);
    assert.equal(isAllowedOrigin('http://other:1', PORT), true);
    assert.equal(isAllowedOrigin(`http://localhost:${PORT}`, PORT), true);
    assert.equal(isAllowedOrigin('http://evil.example', PORT), false);
  } finally {
    if (prev === undefined) delete process.env.AW_ALLOWED_ORIGINS;
    else process.env.AW_ALLOWED_ORIGINS = prev;
  }
});

test('isAllowedHost: the app\'s own loopback authorities on its port are allowed', () => {
  assert.equal(isAllowedHost(`localhost:${PORT}`, PORT), true);
  assert.equal(isAllowedHost(`127.0.0.1:${PORT}`, PORT), true);
  assert.equal(isAllowedHost(`[::1]:${PORT}`, PORT), true);
  assert.equal(isAllowedHost(`LOCALHOST:${PORT}`, PORT), true); // case-insensitive
});

test('isAllowedHost: absent Host is rejected (unlike Origin)', () => {
  assert.equal(isAllowedHost(undefined, PORT), false);
  assert.equal(isAllowedHost('', PORT), false);
});

test('isAllowedHost: a rebound/foreign Host is rejected', () => {
  assert.equal(isAllowedHost('evil.example:7878', PORT), false);
  assert.equal(isAllowedHost(`evil.example:${PORT}`, PORT), false);
  assert.equal(isAllowedHost(`localhost:9999`, PORT), false); // wrong port
});

test('isAllowedHost: AW_ALLOWED_ORIGINS hosts are allowed too', () => {
  const prev = process.env.AW_ALLOWED_ORIGINS;
  process.env.AW_ALLOWED_ORIGINS = 'http://board.local, http://other:1';
  try {
    assert.equal(isAllowedHost('board.local', PORT), true);
    assert.equal(isAllowedHost('other:1', PORT), true);
    assert.equal(isAllowedHost(`localhost:${PORT}`, PORT), true);
    assert.equal(isAllowedHost('evil.example', PORT), false);
  } finally {
    if (prev === undefined) delete process.env.AW_ALLOWED_ORIGINS;
    else process.env.AW_ALLOWED_ORIGINS = prev;
  }
});
