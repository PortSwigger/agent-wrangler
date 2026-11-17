import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { z as z4 } from 'zod/v4';
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

test('a schema the host cannot convert still fingerprints instead of throwing', () => {
  const broken = (description = 'Probe') => {
    const schema = z4.object({ title: z4.string() });
    schema._zod.toJSONSchema = () => { throw new TypeError("Cannot read properties of undefined (reading 'ref')"); };
    return { ...tool(schema), description };
  };
  const fingerprint = extensionToolFingerprint([broken(), tool()]);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint, extensionToolFingerprint([broken(), tool()]));
  assert.equal(fingerprint, extensionToolFingerprint([broken('New help'), tool()]));
  assert.equal(fingerprint, extensionToolFingerprint([tool()]));
});

test('normalization failures cannot block fingerprinting', () => {
  const schema = Object.defineProperty({}, '_zod', { get() { throw new Error('normalization failed'); } });
  assert.equal(extensionToolFingerprint([tool(schema)]), extensionToolFingerprint([]));
});

test('unconvertible tools are omitted from the advertised fingerprint', () => {
  const title = z4.string();
  title._zod.toJSONSchema = () => { throw new Error('broken raw shape'); };
  assert.equal(extensionToolFingerprint([tool({ title })]), extensionToolFingerprint([]));
});

for (const [name, value] of [['BigInt', 1n], ['circular', (() => { const x = {}; x.self = x; return x; })()]]) {
  test(`non-JSON ${name} conversion results cannot block fingerprinting`, () => {
    const schema = z4.object({});
    schema._zod.toJSONSchema = () => ({ type: 'object', value });
    assert.equal(extensionToolFingerprint([tool(schema)]), extensionToolFingerprint([]));
  });
}
