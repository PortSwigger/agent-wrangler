import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseFieldType, checkValue, normaliseCatalogue, normaliseTelemetryDecl, checkEventData, checkEndpoint,
} from './telemetry-schema.js';

test('every written field type normalises to one canonical form, and nothing string-shaped exists', () => {
  assert.deepEqual(normaliseFieldType('bool').type, { t: 'bool', nullable: false });
  assert.deepEqual(normaliseFieldType({ type: 'ms', nullable: true }).type, { t: 'ms', nullable: true });
  assert.deepEqual(normaliseFieldType({ int: [0, 5] }).type, { t: 'int', min: 0, max: 5, nullable: false });
  assert.deepEqual(normaliseFieldType({ enum: ['a', 'b'], nullable: true }).type, { t: 'enum', values: ['a', 'b'], nullable: true });
  assert.deepEqual(normaliseFieldType({ repo: true }).type, { t: 'repo', nullable: false });
  assert.deepEqual(normaliseFieldType({ list: { enum: ['x'] }, max: 3 }).type, { t: 'list', values: ['x'], max: 3, nullable: false });
  for (const bad of ['string', 'text', { type: 'string' }, { enum: ['Has Space'] }, { enum: [] }, { int: [5, 1] }, { int: [0, 1], enum: ['a'] }, { repo: 'yes' }, { list: { enum: ['a'] } }, { int: [0, 1], extra: 1 }]) {
    assert.ok(normaliseFieldType(bad).error, JSON.stringify(bad));
  }
});

test('checkValue holds each type to its range, and null only where nullable', () => {
  const t = (raw) => normaliseFieldType(raw).type;
  assert.equal(checkValue(t('bool'), true), null);
  assert.ok(checkValue(t('bool'), 'true'));
  assert.equal(checkValue(t('ms'), 1000), null);
  assert.ok(checkValue(t('ms'), -1));
  assert.ok(checkValue(t('ms'), 1.5));
  assert.equal(checkValue(t('usd'), 1.25), null);
  assert.ok(checkValue(t('usd'), 1.255));
  assert.equal(checkValue(t({ int: [0, 3] }), 3), null);
  assert.ok(checkValue(t({ int: [0, 3] }), 4));
  assert.ok(checkValue(t({ enum: ['a'] }), 'b'));
  assert.equal(checkValue(t('ref'), '0123456789abcdef'), null);
  assert.ok(checkValue(t('ref'), 'my secret prompt'));
  assert.equal(checkValue(t({ repo: true }), 'acme/widgets'), null);
  assert.equal(checkValue(t({ repo: true }), 'other'), null);
  assert.ok(checkValue(t({ repo: true }), '/Users/me/src/widgets'));
  assert.equal(checkValue(t('model'), 'default'), null);
  assert.equal(checkValue(t('model'), 'claude-x', { isModel: (m) => m === 'claude-x' }), null);
  assert.ok(checkValue(t('model'), 'please leak this'));
  assert.equal(checkValue(t('version'), '1.2.3'), null);
  assert.ok(checkValue(t('version'), 'v1'));
  assert.equal(checkValue(t({ list: { enum: ['a', 'b'] }, max: 2 }), ['a', 'b']), null);
  assert.ok(checkValue(t({ list: { enum: ['a', 'b'] }, max: 1 }), ['a', 'b']));
  assert.ok(checkValue(t('bool'), null));
  assert.equal(checkValue(t({ type: 'bool', nullable: true }), null), null);
  assert.ok(checkValue(t({ type: 'bool', nullable: true }), undefined), 'missing is never the same as null');
});

test('a catalogue refuses bad names, envelope field names and bad versions', () => {
  assert.ok(normaliseCatalogue({ 'step.ended': { v: 1, fields: { n: 'bool' } } }).catalogue);
  assert.match(normaliseCatalogue({ 'Step Ended': { v: 1, fields: {} } }).error, /must match/);
  assert.match(normaliseCatalogue({ a: { v: 0, fields: {} } }).error, /v must be/);
  assert.match(normaliseCatalogue({ a: { v: 1, fields: { install: 'bool' } } }).error, /set by core/);
  assert.match(normaliseCatalogue({ a: { v: 1, fields: { 'bad-key': 'bool' } } }).error, /must match/);
  assert.match(normaliseCatalogue({ a: { v: 1, fields: { n: 'string' } } }).error, /unknown type/);
});

test('a collector URL must be https (http only to localhost) with no credentials, query or fragment', () => {
  assert.equal(checkEndpoint('https://collector.example.com/v1/events'), null);
  assert.equal(checkEndpoint('http://127.0.0.1:9999/v1/events'), null);
  assert.equal(checkEndpoint('http://localhost:9999/v1/events'), null);
  assert.match(checkEndpoint('http://collector.example.com/v1/events'), /https/);
  assert.match(checkEndpoint('https://u:p@collector.example.com/'), /credentials/);
  assert.match(checkEndpoint('https://collector.example.com/?k=v'), /query/);
  assert.match(checkEndpoint('https://collector.example.com/#x'), /query or fragment/);
});

test('telemetry.events needs telemetry:emit, and a manifest cannot name a destination', () => {
  const events = { a: { v: 1, fields: {} } };
  assert.match(normaliseTelemetryDecl({ events }, []).error, /telemetry:emit/);
  assert.ok(normaliseTelemetryDecl({ events }, ['telemetry:emit']).events.a);
  assert.deepEqual(normaliseTelemetryDecl(undefined, []), { events: null });
  assert.match(normaliseTelemetryDecl({ sinks: [{ endpoint: 'https://c.example.com/' }] }, ['telemetry:emit']).error, /telemetry\.sinks is not supported: core sends every event to its built-in collector/);
  assert.match(normaliseTelemetryDecl({ endpoint: 'x' }, []).error, /unknown key/);
});

test('checkEventData throws on undeclared or ill-typed fields at emit, and strips or drops at send', () => {
  const spec = normaliseCatalogue({ e: { v: 1, fields: { n: { int: [0, 9] }, ok: 'bool' } } }).catalogue.e;
  assert.deepEqual(checkEventData(spec, { n: 1, ok: true }), { n: 1, ok: true });
  assert.throws(() => checkEventData(spec, { n: 1, ok: true, prompt: 'secret' }), /"prompt" is not declared/);
  assert.throws(() => checkEventData(spec, { n: 10, ok: true }), /field n must be/);
  assert.throws(() => checkEventData(spec, { n: 1 }), /field ok is missing/);
  assert.deepEqual(checkEventData(spec, { n: 1, ok: true, prompt: 'secret' }, { strict: false }), { n: 1, ok: true });
  assert.equal(checkEventData(spec, { n: 10, ok: true }, { strict: false }), null);
});
