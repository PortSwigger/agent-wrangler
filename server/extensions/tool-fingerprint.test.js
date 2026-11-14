import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { extensionToolFingerprint } from './tool-fingerprint.js';

const tool = (inputSchema = { title: z.string() }) => ({ name: 'probe', extId: 'probe', description: 'Probe', inputSchema });

test('extension tool fingerprints track the advertised schemas and descriptions', () => {
  const original = extensionToolFingerprint([tool()]);
  assert.equal(original, extensionToolFingerprint([tool()]));
  assert.notEqual(original, extensionToolFingerprint([tool({ title: z.string(), options: z.array(z.string()).optional() })]));
  assert.notEqual(original, extensionToolFingerprint([{ ...tool(), description: 'New help' }]));
  assert.notEqual(original, extensionToolFingerprint([{ ...tool(), name: 'renamed' }]));
  assert.notEqual(original, extensionToolFingerprint([]));
  assert.equal(extensionToolFingerprint([]), extensionToolFingerprint([]));
});

test('extension tool fingerprints ignore registration order, property order, and handlers', () => {
  const a = tool({ title: z.string(), count: z.number() });
  const b = { ...tool(), name: 'other' };
  assert.equal(extensionToolFingerprint([a, b]), extensionToolFingerprint([b, { ...a, handler() {}, inputSchema: { count: z.number(), title: z.string() } }]));
});

test('extension tool fingerprints accept object schemas supported by the MCP server', () => {
  const shape = { title: z.string() };
  assert.equal(extensionToolFingerprint([tool(shape)]), extensionToolFingerprint([tool(z.object(shape))]));
});
