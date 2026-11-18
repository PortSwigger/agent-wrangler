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
  const expected = [{ extId: 'demo', tools: [{ name: 'first', error: 'broken schema' }, { name: 'second', error: 'broken schema' }] }, { extId: 'other', tools: [{ name: 'third', error: 'other error' }] }];
  assert.deepEqual(schemas.extensionToolSchemaFailures([a]), [ { extId: 'demo', tools: [{ name: 'first', error: 'broken schema' }] } ]);
  assert.deepEqual(schemas.extensionToolSchemaFailures([c, b, a]), expected);
  assert.deepEqual(schemas.extensionToolSchemaFailures([a, b, c]), expected);
  a.inputSchema = z.object({});
  assert.deepEqual(schemas.extensionToolSchemaFailures([a, b]), [{ extId: 'demo', tools: [{ name: 'second', error: 'broken schema' }] }]);
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
  assert.equal(schemas.extensionToolSchemaFailures([tool])[0].tools[0].name, 'recovery');
  assert.equal(warnings.length, 1);
});
