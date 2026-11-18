#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { inputErrors, versionOf } from '../.claude/skills/evaluate-model/evaluate.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BOARD_PATH = 'repos/harbor-framework/terminal-bench/contents/leaderboard';
const CLAUDE = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', fable: 'claude-fable-5-2', haiku: 'claude-haiku-5-5' };
const CHARTS = [
  ['https://www.anthropic.com/claude-opus-5-5', { gpt6astra: ['codex', 'gpt-6-astra'] }],
  ['https://www.anthropic.com/claude-sonnet-5-5', { opus55: ['claude', 'opus'] }],
  ['https://www.anthropic.com/claude-haiku-5-5', { haiku55: ['claude', 'haiku'], sonnet55: ['claude', 'sonnet'] }],
];
const HUB = 'https://www.tbench.ai/';
const METRICS = ['accuracy', 'n_trials', 'uncached_input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens', 'avg_trial_duration_sec'];
const EXCLUDED = new Set(['gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.5-sol', 'gpt-5.5-terra']);
const newer = (a, b) => { const [x, y] = [a, b].map((v) => v.split('.').map(Number)); return x[0] - y[0] || x[1] - y[1]; };
// A board file named for this model at max in its vendor's harness, in either naming the board has
// used: 2026-09-30-anthropic-claude-opus-5-5-max-claude-code.json, 2026-11-06-haiku-5-5-max-claude-code.json
// (the leaderboard.yaml version) or 2026-11-17-4-1-0-gpt-6-2-sol-max-codex(-regrade).json (version 4.1).
export function boardFile(name, agent, priceId) {
  const slug = priceId.replace(/^claude-/, '').replaceAll('.', '-').replace(/[^\w-]/g, '');
  const m = new RegExp(`^(\\d{4}-\\d\\d-\\d\\d)-(?:(\\d+)-(\\d+)-\\d+-)?(?:${agent === 'claude' ? 'anthropic-claude-' : 'openai-'})?${slug}-max-${agent === 'claude' ? 'claude-code' : 'codex'}(-regrade)?\\.json$`).exec(name);
  return m && { name, date: m[1], version: m[2] ? `${m[2]}.${m[3]}` : null, regrade: !!m[4] };
}

// The leaderboard tbench.ai renders, as the Harbor Hub query its page embeds: Terminal-Bench's
// newest version, including re-scores of runs the GitHub board has only at an older version.
export function hubLeaderboard(html) {
  let found = null;
  const walk = (v) => {
    if (!v || typeof v !== 'object' || found) return;
    if (Array.isArray(v.queries)) {
      for (const q of v.queries) if (Array.isArray(q?.queryKey) && q.queryKey[0] === 'leaderboard' && q.queryKey[1] === 'terminal-bench/terminal-bench') found = q.state?.data;
      return;
    }
    for (const x of Object.values(v)) walk(x);
  };
  for (const record of flightRecords(html)) walk(record);
  const version = /^Terminal-Bench (\d+\.\d+)$/.exec(found?.leaderboard?.title ?? '')?.[1];
  if (!version || !found.leaderboard.name || !Array.isArray(found.rows)) throw new Error('tbench.ai: no Terminal-Bench leaderboard data on the page');
  return { name: found.leaderboard.name, version, rows: found.rows };
}

// tbench.ai's label for a model: claude-opus-5-5 is "Opus 5.5", gpt-6.2-sol is "GPT-6.2 Sol".
export function hubLabel(priceId) {
  const claude = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(priceId), gpt = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/.exec(priceId);
  const cap = (w) => w[0].toUpperCase() + w.slice(1);
  return claude ? `${cap(claude[1])} ${claude[2].replaceAll('-', '.')}` : gpt ? `GPT-${gpt[1]} ${cap(gpt[2])}` : null;
}

// Next's flight records contain JSON, not executable page code.
function flightRecords(html) {
  const flight = [...html.matchAll(/self\.__next_f\.push\((.*?)\)<\/script>/gs)]
    .map((m) => JSON.parse(m[1])?.[1]).filter((s) => typeof s === 'string').join('');
  const records = [];
  for (const line of flight.split('\n')) {
    const value = line.slice(line.indexOf(':') + 1);
    if (!/^[\[{]/.test(value)) continue;
    try { records.push(JSON.parse(value)); } catch { /* Non-JSON flight records are not data. */ }
  }
  return records;
}

export function anthropicSweeps(html, version, series) {
  const charts = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (v._type === 'chart' && v.title === `Terminal-Bench ${version}`) charts.push(v);
    for (const x of Object.values(v)) walk(x);
  };
  for (const record of flightRecords(html)) walk(record);
  if (!charts.length) throw new Error(`Anthropic: no Terminal-Bench ${version} chart`);
  const result = {};
  for (const chart of charts) {
    if (typeof chart.data !== 'string' || !chart.data.startsWith('series,x,y,label')) throw new Error('Anthropic: invalid CSV header');
    for (const line of chart.data.split(/\r?\n/).slice(1).filter(Boolean)) {
      const [id, cost, quality, label] = line.split(',');
      if (!series.includes(id)) continue;
      const effort = { low: 'low', med: 'medium', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }[label?.toLowerCase()];
      if (!effort || !cost?.trim() || !quality?.trim() || !(Number(cost) > 0) || !Number.isFinite(Number(cost)) || !(Number(quality) >= 0 && Number(quality) <= 100)) throw new Error(`Anthropic: invalid ${id} CSV row`);
      const efforts = result[id] ||= {};
      if (efforts[effort]) throw new Error(`Anthropic: duplicate ${id} ${effort}`);
      efforts[effort] = [Number(quality), Number(cost)];
    }
  }
  for (const id of series) if (Object.keys(result[id] || {}).length !== 5) throw new Error(`Anthropic: missing efforts for ${id}`);
  return result;
}

export async function readSources({ base, prices, catalog, github, fetchText, today = new Date().toISOString().slice(0, 10) }) {
  const inputs = structuredClone(base), log = [], manual = [...(base.manual || []).filter((s) => s.startsWith('Read OpenAI effort results by hand for new board run'))];
  const yaml = await github(`${BOARD_PATH}/leaderboard.yaml`);
  const listed = /^title:\s*['"]?Terminal-Bench\s+(\d+\.\d+(?:\.\d+)?)/m.exec(yaml)?.[1];
  if (!listed) throw new Error('board: cannot read version from leaderboard.yaml');
  // Each model is scored on the newest Terminal-Bench version the board has run it on; a vendor
  // sweep only shapes the ladder below max, so it comes from the newest version its vendor charts.
  const baseVersion = versionOf(base.benchmarks['terminal-bench'].version);
  for (const ms of Object.values(inputs.models)) for (const m of Object.values(ms)) if (m['terminal-bench'].sweep) m['terminal-bench'].sweep.version ??= baseVersion;
  inputs.read = today;
  log.push(`board: leaderboard.yaml lists Terminal-Bench ${listed}; newer versions are read from submission names`);
  const files = await github(`${BOARD_PATH}/submissions`);
  if (!Array.isArray(files) || !files.length || files.length >= 1000 || files.some((f) => typeof f.name !== 'string')) throw new Error('board: unreadable, empty or truncated submissions');
  const harnessed = async (file, agent) => {
    const row = await github(`${BOARD_PATH}/submissions/${file}`);
    if (row.metadata?.reasoning_effort !== 'max' || row.metadata?.agent_display?.label !== (agent === 'claude' ? 'Claude Code' : 'Codex')) throw new Error(`board: ${file} is not max effort in the vendor harness`);
    return row;
  };
  const hub = hubLeaderboard(await fetchText(HUB));
  log.push(`hub: ${HUB} embeds the Harbor Hub ${hub.name} leaderboard (Terminal-Bench ${hub.version}, ${hub.rows.length} rows)`);
  const versions = new Set();
  for (const [agent, models] of Object.entries(inputs.models)) for (const [id, model] of Object.entries(models)) {
    const priceId = agent === 'claude' ? CLAUDE[id] : id;
    const price = prices[agent === 'claude' ? 'anthropic' : 'openai']?.[priceId];
    if (!price || !['cacheWrite5m', 'cacheRead', 'output'].every((k) => Number.isFinite(price[k]) && price[k] > 0)) throw new Error(`prices: no usable LiteLLM price for ${agent} ${id}`);
    model.price = { write: price.cacheWrite5m, read: price.cacheRead, output: price.output };
    const runs = files.map((f) => boardFile(f.name, agent, priceId)).filter(Boolean).map((r) => ({ ...r, version: r.version ?? versionOf(listed) }))
      .sort((a, b) => newer(a.version, b.version) || a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
    const run = runs.at(-1), entry = model['terminal-bench'], old = entry.board;
    delete entry.board;
    if (!run) continue;
    const row = await harnessed(run.name, agent);
    entry.board = { file: run.name, version: run.version, ...Object.fromEntries(METRICS.map((k) => [k, row.metrics?.[k]])) };
    // A regrade re-scores an earlier run's trajectories against the new tests: its tokens are that
    // run's, but its trial time is the regrading's, so minutes come from the newest original run.
    if (run.regrade) {
      const original = runs.filter((r) => !r.regrade).at(-1);
      if (!original) throw new Error(`board: ${run.name} is a regrade with no original run for its trial time`);
      entry.board.minutes_file = original.name;
      entry.board.avg_trial_duration_sec = (await harnessed(original.name, agent)).metrics?.avg_trial_duration_sec;
    }
    // The Hub re-scores a run's trajectories on a newer version without a GitHub file. Same tokens
    // means the same trajectories: accuracy comes from the Hub, tokens and minutes from the run.
    if (newer(hub.version, run.version) > 0) {
      const label = hubLabel(priceId), harness = agent === 'claude' ? 'Claude Code' : 'Codex';
      const rescore = hub.rows.find((r) => r.status === 'display' && r.metadata?.model_display?.label === label && r.metadata?.agent_display?.label === harness && r.metadata?.reasoning_effort === 'max');
      const same = rescore && ['n_trials', 'uncached_input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens'].every((k) => rescore.metrics?.[k] === entry.board[k]);
      if (same) Object.assign(entry.board, { version: hub.version, accuracy: rescore.metrics.accuracy, hub_row: rescore.id });
      else if (rescore) manual.push(`Read by hand: tbench.ai lists ${label} (${harness}, max) on Terminal-Bench ${hub.version} with tokens other than ${run.name}, so it scores on ${run.version}.`);
    }
    versions.add(entry.board.version);
    log.push(`board: ${agent} ${id}: ${run.name} (Terminal-Bench ${run.version})${run.regrade ? `, minutes from ${entry.board.minutes_file}` : ''}${entry.board.hub_row ? `; accuracy ${entry.board.accuracy} on Terminal-Bench ${hub.version} from tbench.ai row ${entry.board.hub_row}` : ''}`);
    if (agent === 'codex' && old?.file !== run.name) manual.push(`Read OpenAI effort results by hand for new board run ${run.name}; ${entry.sweep ? 'retained the committed sweep' : `no sweep yet, so its ladder comes from ${model.like}`}.`);
  }
  const version = [...versions, baseVersion].sort(newer).at(-1);
  inputs.benchmarks['terminal-bench'].version = version;
  for (const [url, mapping] of CHARTS) {
    const html = await fetchText(url);
    // The newest version the page charts: the board's, else the one its sweeps were last read at.
    const carried = Object.values(mapping).map(([agent, id]) => inputs.models[agent][id]['terminal-bench'].sweep?.version);
    const tried = [...new Set([version, ...carried, baseVersion].filter(Boolean))].sort(newer).reverse();
    const charted = tried.find((v) => html.includes(`Terminal-Bench ${v}`)) ?? version;
    const sweeps = anthropicSweeps(html, charted, Object.keys(mapping));
    for (const [series, [agent, id]] of Object.entries(mapping)) inputs.models[agent][id]['terminal-bench'].sweep = { source: 'anthropic', version: charted, efforts: sweeps[series] };
    log.push(`anthropic: ${url}: Terminal-Bench ${charted} CSV (${Object.keys(mapping).join(', ')})`);
  }
  if (!Array.isArray(catalog?.models) || !catalog.models.every((m) => typeof m.slug === 'string')) throw new Error('codex: unreadable model catalog');
  for (const m of catalog.models.filter((m) => m.visibility === 'list' && !EXCLUDED.has(m.slug))) {
    if (!inputs.models.codex[m.slug]) {
      const file = files.map((f) => boardFile(f.name, 'codex', m.slug)?.name).filter(Boolean).sort().at(-1);
      if (file) manual.push(`Read OpenAI effort results by hand for new board run ${file}; add a measured model only with a verified ladder.`);
    }
    if (!inputs.models.codex[m.slug]?.['terminal-bench']?.sweep) manual.push(`Read OpenAI effort results by hand: catalog model ${m.slug} has no sweep; no quality is invented.`);
  }
  const { board, ...others } = inputs.sources;
  inputs.sources = { board: { ...board, name: 'Terminal-Bench official leaderboard, GitHub submissions' }, hub: undefined, ...others };
  inputs.sources.hub = {
    name: `Terminal-Bench ${hub.version} leaderboard on tbench.ai (Harbor Hub ${hub.name})`, by: 'Stanford, Laude Institute and Harbor',
    licence: 'Published by the maintainers of the Apache-2.0 board above; tbench.ai states no terms restricting reuse. Cite Terminal-Bench.', url: HUB,
    gives: `Terminal-Bench ${hub.version} accuracy at max for runs the GitHub board has only at an older version, re-scored on the same trajectories (same tokens); tokens and minutes stay from the GitHub run`,
  };
  inputs.sources.prices = {
    name: 'LiteLLM model price catalog, standard tier', by: 'LiteLLM', licence: 'MIT; published list-price facts',
    url: prices.source, gives: 'server/price-catalog.snapshot.json: cacheWrite5m, cacheRead and output per million tokens for both vendors; refreshed with npm run gen:catalog',
  };
  const used = (pick) => [...new Set(Object.values(inputs.models).flatMap((ms) => Object.values(ms)).flatMap((m) => pick(m['terminal-bench']) ?? []))].sort(newer).reverse().join(' or ');
  inputs.credit = `Scores: Terminal-Bench ${used((x) => x.board?.version)}, each model on the newest version the board has run it on (tbench.ai, Apache-2.0), with effort results published by Anthropic and OpenAI on Terminal-Bench ${used((x) => x.sweep?.version)}. Prices: Anthropic and OpenAI list prices from the LiteLLM catalog (MIT), read ${today}.`;
  inputs.manual = [...new Set(manual)].sort();
  const errors = inputErrors(inputs);
  if (errors.length) throw new Error(`sources: invalid reading:\n${errors.join('\n')}`);
  log.push(`prices: server/price-catalog.snapshot.json (LiteLLM, MIT): ${Object.values(inputs.models).reduce((n, ms) => n + Object.keys(ms).length, 0)} models`,
    `retained OpenAI sweeps from inputs read ${base.read}; no OpenAI posts fetched`, ...inputs.manual.map((s) => `MANUAL: ${s}`));
  return { inputs, log };
}

const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
export function newestCommittedInputs() {
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', '.claude/skills/evaluate-model/'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter((s) => /inputs-\d{4}-\d\d-\d\d\.json$/.test(s)).sort();
  if (!files.length) throw new Error('no committed inputs; pass --base inputs.json for the initial port');
  return resolve(ROOT, files.at(-1));
}
async function github(path) {
  const value = JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
  if (Array.isArray(value)) return value;
  if (value.encoding !== 'base64' || !value.content) throw new Error(`GitHub: unreadable ${path}`);
  const decoded = Buffer.from(value.content, 'base64').toString('utf8');
  return path.endsWith('.yaml') ? decoded : JSON.parse(decoded);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), option = (name) => { const i = args.indexOf(name); if (i >= 0 && (!args[i + 1] || args[i + 1].startsWith('--'))) throw new Error(`missing value for ${name}`); return i < 0 ? undefined : args[i + 1]; };
    const explicitBase = option('--base'), base = explicitBase || newestCommittedInputs();
    const baseline = explicitBase ? json(base) : JSON.parse(execFileSync('git', ['show', `HEAD:${relative(ROOT, base)}`], { cwd: ROOT, encoding: 'utf8' }));
    const { inputs, log } = await readSources({ base: baseline, prices: json(new URL('../server/price-catalog.snapshot.json', import.meta.url)),
      catalog: json(new URL('../server/agents/codex-models.snapshot.json', import.meta.url)), github,
      fetchText: async (url) => {
        const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return response.text();
      } });
    const out = option('--out') || resolve(ROOT, `.claude/skills/evaluate-model/inputs-${inputs.read}.json`);
    writeFileSync(out, `${JSON.stringify(inputs, null, 2)}\n`);
    console.log([...log, `Wrote ${out}`].join('\n'));
  } catch (error) { console.error(`read-front-sources: ${error.message}`); process.exitCode = 3; }
}
