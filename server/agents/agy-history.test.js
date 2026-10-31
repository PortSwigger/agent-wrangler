import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAgySteps, agyHistory, analyzeAgy, saveAgyLineage } from './agy-history.js';
import { _setFetchedForTest } from '../price-catalog.js';
const line = (step_index, type, content, more = {}) => JSON.stringify({ step_index, type, content, created_at: '2026-10-29T12:00:00Z', ...more });
test('JSONL rewind drops abandoned steps, preserves user markup and strips only harness wrappers', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-history-'));
  const write = (id, lines) => { const dir = path.join(home, id, '.system_generated/logs'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'transcript_full.jsonl'), lines.join('\n') + '\n'); };
  try {
    write('parent', [line(0, 'USER_INPUT', '<USER_REQUEST>hello <b>world</b></USER_REQUEST><ADDITIONAL_METADATA>hidden</ADDITIONAL_METADATA>'), line(1, 'PLANNER_RESPONSE', 'parent answer', { model: 'gemini-3.8-flash', input_tokens: 100, output_tokens: 10, cache_read_tokens: 20 }), line(2, 'USER_INPUT', 'abandoned'), line(2, 'USER_INPUT', 'replacement'), '{partial']);
    assert.deepEqual((await readAgySteps('parent', { brainDir: home })).map((s) => s.content), ['hello <b>world</b>', 'parent answer', 'replacement']);
    await saveAgyLineage('child', { parentId: 'parent', forkStep: 1 }, { brainDir: home });
    write('child', [line(2, 'USER_INPUT', 'child only'), line(3, 'PLANNER_RESPONSE', 'child answer', { model: 'unknown', input_tokens: 5, output_tokens: 2 })]);
    const files = await agyHistory.findFiles('child', { brainDir: home });
    const scanner = agyHistory.createScanner();
    const tagged = [];
    for (const file of files) await agyHistory.forEachLine(file, (l) => tagged.push(scanner.pushTagged(l)));
    assert.deepEqual(scanner.selectLive(tagged).map((e) => e.text), ['hello <b>world</b>', 'parent answer', 'child only', 'child answer']);
    assert.equal((await analyzeAgy('child', { brainDir: home })).usd, null);
    const rate = { input: 1, output: 2, cacheRead: 0.1 };
    _setFetchedForTest({ gemini: { 'gemini-3.8-flash': rate } });
    const first = await analyzeAgy('parent', { brainDir: home });
    assert.ok(first.usd > 0);
    assert.equal(first.tokens.input, 80);
    _setFetchedForTest({ gemini: { 'gemini-3.8-flash': { ...rate, input: 5 } } });
    assert.ok((await analyzeAgy('parent', { brainDir: home })).usd > first.usd);
  } finally { fs.rmSync(home, { recursive: true, force: true }); _setFetchedForTest(null); }
});

test('context tiers price each request rather than applying a lifetime token threshold', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tier-'));
  const logs = path.join(home, 'tier', '.system_generated/logs'); fs.mkdirSync(logs, { recursive: true });
  const rows = [0, 1].map((step_index) => line(step_index, 'PLANNER_RESPONSE', 'small request', { model: 'gemini-3.8-flash', input_tokens: 100, output_tokens: 0, cache_read_tokens: 0 }));
  fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), rows.join('\n') + '\n');
  try {
    _setFetchedForTest({ gemini: { 'gemini-3.8-flash': { input: 1, output: 2, cacheRead: 0.1, long: { threshold: 150, input: 10, output: 20, cacheRead: 1 } } } });
    const result = await analyzeAgy('tier', { brainDir: home });
    assert.equal(result.tokens.input, 200); assert.equal(result.usd, 0.0002);
  } finally { _setFetchedForTest(null); fs.rmSync(home, { recursive: true, force: true }); }
});
