import test from 'node:test';
import assert from 'node:assert/strict';
import { noteMcpCaller, mcpSeenAt } from './mcp-activity.js';

test('a caller never seen has no timestamp', () => {
  assert.equal(mcpSeenAt('NEVER-SEEN'), 0);
});

test('noteMcpCaller records when that card id last spoke to /mcp', () => {
  noteMcpCaller('CARD-A', 1000);
  assert.equal(mcpSeenAt('CARD-A'), 1000);
  noteMcpCaller('CARD-A', 2000);
  assert.equal(mcpSeenAt('CARD-A'), 2000);
});

test('an unidentified request is ignored rather than recorded under a bogus key', () => {
  noteMcpCaller(null, 3000);
  noteMcpCaller('', 3000);
  assert.equal(mcpSeenAt(null), 0);
  assert.equal(mcpSeenAt(''), 0);
});
