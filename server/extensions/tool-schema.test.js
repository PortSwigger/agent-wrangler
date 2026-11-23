import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/v4';
import * as schemas from './tool-schema.js';

function probe(name, extId = 'demo', error = 'broken schema') {
  const inputSchema = z.object({});
  inputSchema._zod.toJSONSchema = () => { throw new Error(error); };
  return { name, extId, inputSchema };
}

test('board schema failures group tools by extension, update and clear on recovery', (t) => {
  t.mock.method(console, 'warn', () => {});
  const a = probe('first');
  const b = probe('second');
  const c = probe('third', 'other', 'other error');
  const expected = [{ extId: 'demo' }, { extId: 'other' }];
  assert.deepEqual(schemas.extensionToolSchemaFailures([a]), [{ extId: 'demo' }]);
  assert.deepEqual(schemas.extensionToolSchemaFailures([c, b, a]), expected);
  assert.deepEqual(schemas.extensionToolSchemaFailures([a, b, c]), expected);
  a.inputSchema = z.object({});
  assert.deepEqual(schemas.extensionToolSchemaFailures([a, b]), [{ extId: 'demo' }]);
  b.inputSchema = z.object({});
  assert.deepEqual(schemas.extensionToolSchemaFailures([a, b]), []);
  assert.deepEqual(schemas.extensionToolSchemaFailures([]), []);
});

test('a recovered schema can fail again without duplicate process diagnostics', (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const tool = probe('recovery', 'repeated');
  schemas.extensionToolSchemaFailures([tool]);
  tool.inputSchema = z.object({});
  assert.deepEqual(schemas.extensionToolSchemaFailures([tool]), []);
  tool.inputSchema = probe('recovery').inputSchema;
  assert.deepEqual(schemas.extensionToolSchemaFailures([tool]), [{ extId: 'repeated' }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /repeated\/recovery/);
  assert.equal(warnings[0][1].message, 'broken schema');
});

test('schema factory errors omit only the failing tool', (t) => {
  t.mock.method(console, 'warn', () => {});
  const hostApiFor = () => ({ id: 'demo' });
  for (const inputSchema of [
    ({ host }) => ({ title: host.schema.z.string() }),
    () => { throw new Error('factory failed'); },
    () => undefined,
    () => [],
    () => Promise.resolve({}),
    () => Promise.reject(new Error('async factory failed')),
  ]) {
    const tool = { name: 'factory_probe', extId: 'demo', inputSchema };
    assert.equal(schemas.toolInputSchema(tool, hostApiFor), null);
    assert.deepEqual(schemas.extensionToolSchemaFailures([tool], hostApiFor), [{ extId: 'demo' }]);
  }
});
