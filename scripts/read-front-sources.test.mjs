import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSources, anthropicSweeps, boardFile } from './read-front-sources.mjs';

const base = JSON.parse(readFileSync(new URL('../.claude/skills/evaluate-model/inputs-2026-10-28.json', import.meta.url)));
const prices = JSON.parse(readFileSync(new URL('../server/price-catalog.snapshot.json', import.meta.url)));
const chart = (series, version = '4.0') => ({ _type: 'chart', title: `Terminal-Bench ${version}`, data: 'series,x,y,label,labelPlacement\n' + series.flatMap((s) => ['Low', 'Med', 'High', 'Xhigh', 'Max'].map((e, i) => `${s},${i + 1},${20 + i},${e},hidden`)).join('\n') });
const page = (...charts) => `<script>self.__next_f.push(${JSON.stringify([1, '1:' + JSON.stringify({ body: charts }) + '\n'])})</script>`;
const pages = {
  'https://www.anthropic.com/claude-opus-5-5': page(chart(['gpt6astra'])),
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
  assert.deepEqual(inputs.models.codex['gpt-6.1-sol']['terminal-bench'].sweep, { ...base.models.codex['gpt-6.1-sol']['terminal-bench'].sweep, version: '4.0' });
  assert.deepEqual(inputs.models.claude.fable['terminal-bench'].sweep, { ...base.models.claude.fable['terminal-bench'].sweep, version: '4.0' }, 'Fable has no chart, so its sweep is carried');
  assert.equal(inputs.models.claude.opus['terminal-bench'].board.version, '4.0');
  assert.equal(inputs.models.claude.fable.price.write, prices.anthropic['claude-fable-5-2'].cacheWrite5m);
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

test('board files are matched in every naming the board uses, and never across models or harnesses', () => {
  assert.deepEqual(boardFile('2026-09-30-anthropic-claude-opus-5-5-max-claude-code.json', 'claude', 'claude-opus-5-5'), { name: '2026-09-30-anthropic-claude-opus-5-5-max-claude-code.json', date: '2026-09-30', version: null, regrade: false });
  assert.equal(boardFile('2026-11-06-haiku-5-5-max-claude-code.json', 'claude', 'claude-haiku-5-5')?.version, null);
  assert.deepEqual(boardFile('2026-11-12-4-1-0-haiku-5-5-max-claude-code-regrade.json', 'claude', 'claude-haiku-5-5'), { name: '2026-11-12-4-1-0-haiku-5-5-max-claude-code-regrade.json', date: '2026-11-12', version: '4.1', regrade: true });
  assert.equal(boardFile('2026-11-17-4-1-0-gpt-6-2-sol-max-codex.json', 'codex', 'gpt-6.2-sol')?.version, '4.1');
  for (const [name, agent, id] of [['2026-11-17-4-1-0-gpt-6-2-sol-max-codex.json', 'codex', 'gpt-6.2-astra'], ['2026-11-10-openrouter-moonshotai-kimi-k3-max-claude-code.json', 'claude', 'claude-k3'],
    ['2026-09-30-anthropic-claude-opus-5-5-max-claude-code.json', 'codex', 'claude-opus-5-5'], ['2026-08-26-anthropic-claude-fable-5-max-claude-code.json', 'claude', 'claude-fable-5-2']]) assert.equal(boardFile(name, agent, id), null, name);
});

test('each model scores on its newest board version, a regrade keeps its original run\'s minutes, and sweeps keep the newest charted version', async () => {
  const sol41 = '2026-11-17-4-1-0-gpt-6-1-sol-max-codex.json', opus41 = '2026-11-12-4-1-0-opus-5-5-max-claude-code-regrade.json';
  const opus = base.models.claude.opus['terminal-bench'].board, sol = base.models.codex['gpt-6.1-sol']['terminal-bench'].board;
  const { inputs } = await readSources({ ...options(), github: async (p) => {
    if (p.endsWith('/submissions')) return [...await github(p), { name: sol41 }, { name: opus41 }];
    if (p.endsWith(sol41)) return { metadata: { reasoning_effort: 'max', agent_display: { label: 'Codex' } }, metrics: { ...sol, accuracy: 60 } };
    if (p.endsWith(opus41)) return { metadata: { reasoning_effort: 'max', agent_display: { label: 'Claude Code' } }, metrics: { ...opus, accuracy: 70, avg_trial_duration_sec: 12 } };
    return github(p);
  } });
  assert.equal(inputs.benchmarks['terminal-bench'].version, '4.1');
  assert.deepEqual(inputs.models.codex['gpt-6.1-sol']['terminal-bench'].board, { ...sol, file: sol41, version: '4.1', accuracy: 60 });
  assert.deepEqual(inputs.models.claude.opus['terminal-bench'].board, { ...opus, file: opus41, version: '4.1', accuracy: 70, minutes_file: opus.file });
  assert.equal(inputs.models.claude.sonnet['terminal-bench'].board.version, '4.0');
  assert.equal(inputs.models.claude.sonnet['terminal-bench'].sweep.version, '4.0', 'Anthropic charts only 4.0, so the ladder keeps it');
  assert.match(inputs.credit, /Terminal-Bench 4\.1 or 4\.0, each model on the newest version/);
  assert.ok(inputs.manual.some((s) => s.includes(sol41)));
});

test('a newly measured catalog model gets a board-run flag without invented ladders', async () => {
  const file = '2026-10-29-openai-gpt-new-max-codex.json';
  const { inputs } = await readSources({ ...options(), catalog: { models: [{ slug: 'gpt-new', visibility: 'list' }] }, github: async (p) => p.endsWith('/submissions') ? [...await github(p), { name: file }] : github(p) });
  assert.ok(inputs.manual.some((s) => s.includes(file) && s.includes('OpenAI')));
  assert.equal(inputs.models.codex['gpt-new'], undefined);
});
