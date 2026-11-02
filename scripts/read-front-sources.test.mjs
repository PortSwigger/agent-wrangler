import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSources, anthropicSweeps } from './read-front-sources.mjs';

const base = JSON.parse(readFileSync(new URL('../.claude/skills/evaluate-model/inputs-2026-10-28.json', import.meta.url)));
const prices = JSON.parse(readFileSync(new URL('../server/price-catalog.snapshot.json', import.meta.url)));
const chart = (series, version = '4.0') => ({ _type: 'chart', title: `Terminal-Bench ${version}`, data: 'series,x,y,label,labelPlacement\n' + series.flatMap((s) => ['Low', 'Med', 'High', 'Xhigh', 'Max'].map((e, i) => `${s},${i + 1},${20 + i},${e},hidden`)).join('\n') });
const page = (...charts) => `<script>self.__next_f.push(${JSON.stringify([1, '1:' + JSON.stringify({ body: charts }) + '\n'])})</script>`;
const pages = {
  'https://www.anthropic.com/claude-opus-5-5': page(chart(['fable51', 'gpt6astra'])),
  'https://www.anthropic.com/claude-sonnet-5-5': page(chart(['opus55'])),
  'https://www.anthropic.com/claude-haiku-5-5': page(chart(['haiku55', 'sonnet55', 'sonnet55old'])),
};
const boards = Object.values(base.models).flatMap((ms) => Object.values(ms)).flatMap((m) => m['terminal-bench'].board ? [m['terminal-bench'].board] : []);
const github = async (path) => {
  if (path.endsWith('leaderboard.yaml')) return 'title: Terminal-Bench 4.0\n';
  if (path.endsWith('/submissions')) return boards.map((b) => ({ name: b.file }));
  const board = boards.find((b) => path.endsWith(b.file));
  assert.ok(board, path);
  return { metadata: { reasoning_effort: 'max', agent_display: { label: board.file.includes('openai') ? 'Codex' : 'Claude Code' } }, metrics: board };
};
const options = () => ({ base, prices, catalog: { models: [] }, github, fetchText: async (url) => {
  assert.ok(url.startsWith('https://www.anthropic.com/'), 'never fetch OpenAI');
  assert.ok(pages[url], url);
  return pages[url];
}, today: '2026-10-29' });

test('reader uses board version, precise Anthropic CSVs and LiteLLM, retaining OpenAI sweeps', async () => {
  const { inputs, log } = await readSources(options());
  assert.equal(inputs.benchmarks['terminal-bench'].version, '4.0');
  assert.deepEqual(inputs.models.codex['gpt-6.1-sol']['terminal-bench'].sweep, base.models.codex['gpt-6.1-sol']['terminal-bench'].sweep);
  assert.deepEqual(inputs.models.claude.sonnet['terminal-bench'].sweep.efforts.medium, [21, 2]);
  assert.equal(inputs.models.claude.opus.price.write, prices.anthropic['claude-opus-5-5'].cacheWrite5m);
  assert.equal(inputs.models.codex['gpt-6.1-sol'].price.write, prices.openai['gpt-6.1-sol'].cacheWrite5m);
  assert.match(inputs.credit, /LiteLLM/);
  assert.match(log.join('\n'), /retained OpenAI/);
});

test('only matching Terminal-Bench charts are read; malformed or wrong-version CSVs fail', () => {
  assert.deepEqual(anthropicSweeps(page({ ...chart(['opus55']), title: 'Other' }, chart(['opus55'])), '4.0', ['opus55']).opus55.low, [20, 1]);
  assert.throws(() => anthropicSweeps(page(chart(['opus55'], '4.1')), '4.0', ['opus55']), /Terminal-Bench 4.0/);
  const bad = chart(['opus55']); bad.data = bad.data.replace('opus55,1,20', 'opus55,no,20');
  assert.throws(() => anthropicSweeps(page(bad), '4.0', ['opus55']), /invalid/);
  assert.throws(() => anthropicSweeps(page(chart(['opus55'])), '4.0', ['missing']), /missing/);
});

test('source failures are loud, including HTTP, board metadata, prices and empty submissions', async () => {
  await assert.rejects(readSources({ ...options(), fetchText: async () => { throw new Error('HTTP 503'); } }), /503/);
  await assert.rejects(readSources({ ...options(), prices: {} }), /price/);
  await assert.rejects(readSources({ ...options(), github: async (p) => p.endsWith('leaderboard.yaml') ? 'bad yaml' : [] }), /version/);
  await assert.rejects(readSources({ ...options(), github: async (p) => p.endsWith('/submissions') ? [] : github(p) }), /submissions/);
  await assert.rejects(readSources({ ...options(), github: async (p) => p.endsWith('.json') ? { metadata: {}, metrics: {} } : github(p) }), /max|harness/);
});

test('a new Codex board run and missing catalog sweeps are flagged for a person', async () => {
  const newFile = '2026-10-29-openai-gpt-6-1-sol-max-codex.json';
  const { inputs } = await readSources({ ...options(), catalog: { models: [{ slug: 'new-model', visibility: 'list' }] }, github: async (p) => {
    if (p.endsWith('/submissions')) return [...await github(p), { name: newFile }];
    if (p.endsWith(newFile)) return github('submissions/' + base.models.codex['gpt-6.1-sol']['terminal-bench'].board.file);
    return github(p);
  } });
  assert.ok(inputs.manual.some((s) => s.includes('new-model') && s.includes('sweep')));
  assert.ok(inputs.manual.some((s) => s.includes(newFile) && s.includes('OpenAI')));
  assert.equal(inputs.models.codex['gpt-6.1-sol']['terminal-bench'].board.file, newFile);
});

test('a benchmark version change never carries old vendor sweeps onto the new scale', async () => {
  await assert.rejects(readSources({ ...options(), github: async (p) => p.endsWith('leaderboard.yaml') ? 'title: Terminal-Bench 4.1' : github(p) }), /version.*4.0.*4.1.*manual/i);
});

test('a newly measured catalog model gets a board-run flag without invented ladders', async () => {
  const file = '2026-10-29-openai-gpt-new-max-codex.json';
  const { inputs } = await readSources({ ...options(), catalog: { models: [{ slug: 'gpt-new', visibility: 'list' }] }, github: async (p) => p.endsWith('/submissions') ? [...await github(p), { name: file }] : github(p) });
  assert.ok(inputs.manual.some((s) => s.includes(file) && s.includes('OpenAI')));
  assert.equal(inputs.models.codex['gpt-new'], undefined);
});
