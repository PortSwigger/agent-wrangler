import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSources, anthropicSweeps, boardFile, hubLeaderboard, hubLabel, arenaLeaderboard, arenaScores, arenaPage as arenaUrl } from './read-front-sources.mjs';

const base = JSON.parse(readFileSync(new URL('../.claude/skills/evaluate-model/inputs-2026-10-28.json', import.meta.url)));
const prices = JSON.parse(readFileSync(new URL('../server/price-catalog.snapshot.json', import.meta.url)));
const chart = (series, version = '4.0') => ({ _type: 'chart', title: `Terminal-Bench ${version}`, data: 'series,x,y,label,labelPlacement\n' + series.flatMap((s) => ['Low', 'Med', 'High', 'Xhigh', 'Max'].map((e, i) => `${s},${i + 1},${20 + i},${e},hidden`)).join('\n') });
const page = (...charts) => `<script>self.__next_f.push(${JSON.stringify([1, '1:' + JSON.stringify({ body: charts }) + '\n'])})</script>`;
const hubPage = (rows = [], title = 'Terminal-Bench 4.1') => `<script>self.__next_f.push(${JSON.stringify([1, '1d:' + JSON.stringify({ state: { queries: [{ queryKey: ['leaderboard', 'terminal-bench/terminal-bench', '4-1-0'], state: { data: { leaderboard: { name: '4-1-0', title }, rows } } }] } }) + '\n'])})</script>`;
const arenaRow = (model_name, score, row = {}) => ({ row: { model_name, organization: 'x', license: 'Proprietary', score, category: 'overall', leaderboard_publish_date: '2026-10-28', ...row } });
const arenaJson = (rows, total = rows.length) => JSON.stringify({ num_rows_total: total, rows });
const arenaRows = [arenaRow('Claude Opus 5.5 (Max)', 0.19), arenaRow('Claude Opus 5.5 (High)', 0.14), arenaRow('Claude Opus 5 (Max)', 0.06), arenaRow('Claude Sonnet 5.5 (Max)', 0.15),
  arenaRow('Claude Haiku 5.5 (High)', -0.004), arenaRow('GPT-6.1 Sol (Medium)', 0.08), arenaRow('GPT-6 Luna (Ultra)', 0.9), arenaRow('Gemini 3.1 Pro Preview', -0.05), arenaRow('Claude Fable 5.2 (Max)', 0.5, { category: 'coding' })];
const pages = {
  'https://www.tbench.ai/': hubPage(),
  [arenaUrl(0)]: arenaJson(arenaRows),
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
  assert.ok(!url.includes('openai.com'), 'never fetch OpenAI');
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

const hubRow = (id, label, harness, metrics, effort = 'max') => ({ id, status: 'display', metadata: { reasoning_effort: effort, agent_display: { label: harness }, model_display: { label } }, metrics });
const withHub = (rows) => async (url) => (url === 'https://www.tbench.ai/' ? hubPage(rows) : options().fetchText(url));

test('a tbench.ai re-score of the same trajectories scores on its version, keeping the GitHub run\'s tokens and minutes', async () => {
  const opus = base.models.claude.opus['terminal-bench'].board, sonnet = base.models.claude.sonnet['terminal-bench'].board;
  const { inputs, log } = await readSources({ ...options(), fetchText: withHub([
    hubRow('opus-row', 'Opus 5.5', 'Claude Code', { ...opus, accuracy: 66, avg_trial_duration_sec: 1 }),
    hubRow('opus-high', 'Opus 5.5', 'Claude Code', { ...opus, accuracy: 99 }, 'high'),
    hubRow('opus-other-harness', 'Opus 5.5', 'Terminus', { ...opus, accuracy: 99 }),
    hubRow('sonnet-new-run', 'Sonnet 5.5', 'Claude Code', { ...sonnet, accuracy: 70, output_tokens: 1, total_tokens: sonnet.uncached_input_tokens + 1 }),
  ]) });
  assert.deepEqual(inputs.models.claude.opus['terminal-bench'].board, { ...opus, version: '4.1', accuracy: 66, hub_row: 'opus-row' });
  assert.deepEqual(inputs.models.claude.sonnet['terminal-bench'].board, { ...sonnet, version: '4.0' }, 'other tokens are another run, so it is not mixed with the GitHub one');
  assert.ok(inputs.manual.some((s) => s.includes('Sonnet 5.5') && s.includes('tbench.ai')));
  assert.equal(inputs.benchmarks['terminal-bench'].version, '4.1');
  assert.deepEqual(Object.keys(inputs.sources).slice(0, 2), ['board', 'hub']);
  assert.match(inputs.sources.hub.name, /Terminal-Bench 4\.1 leaderboard on tbench\.ai/);
  assert.match(log.join('\n'), /accuracy 66 on Terminal-Bench 4\.1 from tbench\.ai row opus-row/);
});

test('tbench.ai leaderboard data is read from the page or fails loudly, and labels follow its naming', async () => {
  assert.equal(hubLeaderboard(hubPage([{ id: 'x' }])).version, '4.1');
  assert.throws(() => hubLeaderboard(page(chart(['opus55']))), /tbench\.ai/);
  assert.throws(() => hubLeaderboard(hubPage([], 'Something else')), /tbench\.ai/);
  await assert.rejects(readSources({ ...options(), fetchText: async (url) => (url === 'https://www.tbench.ai/' ? '<html></html>' : options().fetchText(url)) }), /tbench\.ai/);
  assert.deepEqual(['claude-opus-5-5', 'claude-fable-5-2', 'gpt-6.2-sol', 'gpt-6-luna', 'gpt-6.1-terra', 'o3'].map(hubLabel), ['Opus 5.5', 'Fable 5.2', 'GPT-6.2 Sol', 'GPT-6 Luna', 'GPT-6.1 Terra', null]);
});

test('Anthropic sweeps fall back to the version they were read at when the base is already newer', async () => {
  const newerBase = structuredClone(base);
  newerBase.benchmarks['terminal-bench'].version = '4.1';
  for (const ms of Object.values(newerBase.models)) for (const m of Object.values(ms)) if (m['terminal-bench'].sweep) m['terminal-bench'].sweep.version = '4.0';
  const { inputs } = await readSources({ ...options(), base: newerBase });
  assert.equal(inputs.models.claude.opus['terminal-bench'].sweep.version, '4.0');
  assert.deepEqual(inputs.models.claude.opus['terminal-bench'].sweep.efforts.low, [20, 1]);
});

const geminiBase = JSON.parse(readFileSync(new URL('../.claude/skills/evaluate-model/inputs-2026-11-22.json', import.meta.url)));

test('agy runs are matched in the board\'s Antigravity CLI namings, at their own effort, and never across models', () => {
  assert.deepEqual(boardFile('2026-11-20-4-1-0-gemini-gemini-4-neon-xhigh-antigravity-cli.json', 'agy', 'gemini-4-neon'), { name: '2026-11-20-4-1-0-gemini-gemini-4-neon-xhigh-antigravity-cli.json', date: '2026-11-20', version: '4.1', regrade: false });
  assert.deepEqual(boardFile('2026-11-13-4-0-0-gemini-4-argon-high-antigravity-cli-1-5-2.json', 'agy', 'gemini-4-argon'), { name: '2026-11-13-4-0-0-gemini-4-argon-high-antigravity-cli-1-5-2.json', date: '2026-11-13', version: '4.0', regrade: false });
  assert.equal(boardFile('2026-11-13-4-1-0-gemini-4-argon-high-antigravity-cli-regrade.json', 'agy', 'gemini-4-argon')?.regrade, true);
  assert.equal(boardFile('2026-11-15-4-1-0-gemini-3-1-pro-regrade.json', 'agy', 'gemini-3.1-pro')?.regrade, true);
  for (const [name, id] of [['2026-09-01-gemini-gemini-3-8-flash-high-mini-swe-agent.json', 'gemini-3.8-flash'], ['2026-11-20-4-1-0-gemini-gemini-4-neon-xhigh-antigravity-cli.json', 'gemini-4-hydrogen'],
    ['2026-11-14-4-1-0-gemini-gemini-4-carbon-high-antigravity-cli.json', 'gemini-4']]) assert.equal(boardFile(name, 'agy', id), null, name);
  assert.equal(boardFile('2026-11-20-4-1-0-gemini-gemini-4-neon-xhigh-antigravity-cli.json', 'codex', 'gemini-4-neon'), null);
  assert.deepEqual(['gemini-4-neon', 'gemini-3.8-flash', 'gemini-3.1-pro'].map(hubLabel), ['Gemini 4 Neon', 'Gemini 3.8 Flash', 'Gemini 3.1 Pro']);
});

test('agy models read their Antigravity CLI run at its effort, Gemini input prices, and Google flags', async () => {
  const runs = Object.values(geminiBase.models).flatMap((ms) => Object.values(ms)).flatMap((m) => m['terminal-bench'].board ? [m['terminal-bench'].board] : []);
  const all = [...runs, ...runs.filter((b) => b.minutes_file).map((b) => ({ ...b, file: b.minutes_file }))];
  const seed = structuredClone(geminiBase);
  for (const ms of Object.values(seed.models)) for (const m of Object.values(ms)) delete m['terminal-bench'].board;
  delete seed.models.agy['gemini-4-neon'];
  const geminiGithub = async (path, effortOf = (b) => b.effort ?? 'max') => {
    if (path.endsWith('leaderboard.yaml')) return 'title: Terminal-Bench 4.0\n';
    if (path.endsWith('/submissions')) return all.map((b) => ({ name: b.file }));
    const board = all.find((b) => path.endsWith(b.file));
    assert.ok(board, path);
    return { metadata: { reasoning_effort: effortOf(board), agent_display: { label: board.file.includes('antigravity') || board.file.includes('gemini') ? 'Antigravity CLI' : board.file.includes('openai') || board.file.includes('gpt') ? 'Codex' : 'Claude Code' } }, metrics: board };
  };
  const run = (github) => readSources({ ...options(), base: seed, github, fetchText: async (url) => (url === 'https://www.tbench.ai/' ? hubPage() : pages[url] ?? page(chart(['gpt6astra', 'opus55', 'haiku55', 'sonnet55'], '4.0'))) });
  const { inputs } = await run(geminiGithub);
  const argon = inputs.models.agy['gemini-4-argon']['terminal-bench'].board;
  assert.deepEqual(argon, geminiBase.models.agy['gemini-4-argon']['terminal-bench'].board, 'the regrade, at high, with its original run\'s minutes');
  assert.deepEqual(inputs.models.agy['gemini-4-carbon'].price, { write: prices.gemini['gemini-4-carbon'].input, read: prices.gemini['gemini-4-carbon'].cacheRead, output: prices.gemini['gemini-4-carbon'].output });
  assert.equal(inputs.models.agy['gemini-3.1-pro'].price.output, prices.gemini['gemini-3.1-pro-preview'].output, 'LiteLLM lists 3.1 Pro as a preview');
  assert.equal(inputs.models.agy['gemini-3.8-flash']['terminal-bench'].board, undefined, 'its only run is in mini-SWE-agent');
  assert.ok(inputs.manual.some((s) => s.startsWith('Read Google effort results by hand for new board run 2026-11-14-4-1-0-gemini-gemini-4-carbon')));
  assert.match(inputs.credit, /published by Anthropic, OpenAI and Google/);
  await assert.rejects(run((p) => geminiGithub(p, (b) => (b.file.includes('carbon') ? 'xhigh' : b.effort ?? 'max'))), /carbon.*not an effort the model takes/);
});

test('Arena rows join as a quality-only benchmark, matched by model and effort, credited under CC BY 4.0', async () => {
  const withSuperseded = structuredClone(base);
  withSuperseded.models.codex['gpt-6.1-sol'].supersededBy = 'gpt-6.1-terra';
  const { inputs, log } = await readSources({ ...options(), base: withSuperseded });
  assert.deepEqual(inputs.benchmarks.arena, { name: 'Arena agent leaderboard', published: '2026-10-28', weight: 1, onto: 'terminal-bench' });
  assert.deepEqual(inputs.models.claude.opus.arena, { scores: { high: 0.14, max: 0.19 } }, 'ascending efforts; Opus 5 is another model');
  assert.deepEqual(inputs.models.claude.haiku.arena, { scores: { high: -0.004 } });
  assert.equal(inputs.models.claude.fable.arena, undefined, 'only the overall category counts');
  assert.equal(inputs.models.codex['gpt-6.1-sol'].arena, undefined, 'a superseded model has no rows to score');
  assert.equal(inputs.models.codex['gpt-6-luna'].arena, undefined, 'an effort the model does not take is skipped');
  assert.match(log.join('\n'), /arena: codex gpt-6-luna: skipped GPT-6 Luna \(Ultra\)/);
  assert.match(log.join('\n'), /published 2026-10-28 \(8 rows\); no row for claude fable/);
  assert.equal(inputs.sources.arena.url, 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset');
  assert.match(inputs.sources.arena.licence, /^CC BY 4\.0/);
  assert.match(inputs.credit, /Arena's agent leaderboard published 2026-10-28 \(Arena, lmarena-ai\/leaderboard-dataset, CC BY 4\.0\), rescaled to Terminal-Bench points/);
  const tuned = structuredClone(base);
  tuned.benchmarks.arena = { ...inputs.benchmarks.arena, weight: 0.5 };
  assert.equal((await readSources({ ...options(), base: tuned })).inputs.benchmarks.arena.weight, 0.5, 'a weight set in the inputs is carried');
});

test('Arena names follow its "Model (Effort)" form for every agent', () => {
  const rows = [arenaRow('GPT-6.1 Sol (Max)', 0.1).row, arenaRow('Gemini 4 Neon (High)', 0.2).row, arenaRow('Gemini 4 Neon (xHigh)', 0.3).row, arenaRow('Claude Fable 5.2 (Max)', 0.27).row];
  assert.deepEqual(arenaScores(rows, 'codex', 'gpt-6.1-sol', ['low', 'medium', 'high', 'xhigh', 'max']), { name: 'GPT-6.1 Sol', scores: { max: 0.1 }, skipped: [] });
  assert.deepEqual(arenaScores(rows, 'agy', 'gemini-4-neon', ['low', 'medium', 'high', 'xhigh']), { name: 'Gemini 4 Neon', scores: { high: 0.2, xhigh: 0.3 }, skipped: [] });
  assert.deepEqual(arenaScores(rows, 'claude', 'fable', ['low', 'medium', 'high', 'xhigh', 'max']).scores, { max: 0.27 });
});

test('Arena pages are read to the end, and an unreadable leaderboard fails the reader', async () => {
  const many = Array.from({ length: 150 }, (_, i) => arenaRow(`Model ${i} (Max)`, i / 1000));
  const paged = { [arenaUrl(0)]: arenaJson(many.slice(0, 100), 150), [arenaUrl(100)]: arenaJson(many.slice(100), 150) };
  assert.equal((await arenaLeaderboard(async (url) => paged[url])).rows.length, 150);
  const failing = async (rows, total) => readSources({ ...options(), fetchText: async (url) => (url === arenaUrl(0) ? arenaJson(rows, total) : options().fetchText(url)) });
  await assert.rejects(failing([], 0), /Arena: no readable overall rows/);
  await assert.rejects(failing([arenaRow('A (Max)', 0.1)], 5), /Arena: unreadable rows page/);
  await assert.rejects(failing([arenaRow('A (Max)', null)]), /Arena: no readable overall rows/);
  await assert.rejects(failing([arenaRow('A (Max)', 0.1), arenaRow('B (Max)', 0.1, { leaderboard_publish_date: '2026-10-29' })]), /mixes publish dates/);
  await assert.rejects(failing([arenaRow('A (Max)', 0.1), arenaRow('A (Max)', 0.2)]), /listed twice/);
  await assert.rejects(readSources({ ...options(), fetchText: async (url) => { if (url === arenaUrl(0)) throw new Error(`${url}: HTTP 502`); return options().fetchText(url); } }), /HTTP 502/);
  await assert.rejects(readSources({ ...options(), fetchText: async (url) => (url === arenaUrl(0) ? '<html>' : options().fetchText(url)) }), /JSON/);
});

test('the reader never reads arena.ai, only the Hugging Face dataset', async () => {
  const seen = [];
  await readSources({ ...options(), fetchText: async (url) => { seen.push(url); return options().fetchText(url); } });
  assert.ok(seen.includes(arenaUrl(0)));
  assert.ok(!seen.some((url) => /arena\.ai|lmarena\.ai/.test(new URL(url).hostname)));
});
