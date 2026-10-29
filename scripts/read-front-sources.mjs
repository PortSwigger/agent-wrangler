#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { inputErrors, versionOf } from '../.claude/skills/evaluate-model/evaluate.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BOARD_PATH = 'repos/harbor-framework/terminal-bench/contents/leaderboard';
const CLAUDE = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', fable: 'claude-fable-5-1', haiku: 'claude-haiku-5-5' };
const CHARTS = [
  ['https://www.anthropic.com/claude-opus-5-5', { fable51: ['claude', 'fable'], gpt6astra: ['codex', 'gpt-6-astra'] }],
  ['https://www.anthropic.com/claude-sonnet-5-5', { opus55: ['claude', 'opus'] }],
  ['https://www.anthropic.com/claude-haiku-5-5', { haiku55: ['claude', 'haiku'], sonnet55: ['claude', 'sonnet'] }],
];
const METRICS = ['accuracy', 'n_trials', 'uncached_input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens', 'avg_trial_duration_sec'];
const EXCLUDED = new Set(['gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.5-sol', 'gpt-5.5-terra']);

export function anthropicSweeps(html, version, series) {
  const charts = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (v._type === 'chart' && v.title === `Terminal-Bench ${version}`) charts.push(v);
    for (const x of Object.values(v)) walk(x);
  };
  // Next's flight records contain JSON, not executable page code.
  const flight = [...html.matchAll(/self\.__next_f\.push\((.*?)\)<\/script>/gs)]
    .map((m) => JSON.parse(m[1])?.[1]).filter((s) => typeof s === 'string').join('');
  for (const line of flight.split('\n')) {
    const value = line.slice(line.indexOf(':') + 1);
    if (!/^[\[{]/.test(value)) continue;
    try { walk(JSON.parse(value)); } catch { /* Non-JSON flight records are not chart data. */ }
  }
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
  const version = /^title:\s*['"]?Terminal-Bench\s+(\d+\.\d+(?:\.\d+)?)/m.exec(yaml)?.[1];
  if (!version) throw new Error('board: cannot read version from leaderboard.yaml');
  const before = versionOf(base.benchmarks['terminal-bench'].version);
  if (versionOf(version) !== before) throw new Error(`board version ${before} -> ${version}: manual reading of all vendor sweeps required; old and new scales cannot mix`);
  inputs.read = today;
  inputs.benchmarks['terminal-bench'].version = version;
  log.push(`board: Terminal-Bench ${version} (leaderboard.yaml via GitHub API)`);
  const files = await github(`${BOARD_PATH}/submissions`);
  if (!Array.isArray(files) || !files.length || files.length >= 1000 || files.some((f) => typeof f.name !== 'string')) throw new Error('board: unreadable, empty or truncated submissions');
  for (const [agent, models] of Object.entries(inputs.models)) for (const [id, model] of Object.entries(models)) {
    const priceId = agent === 'claude' ? CLAUDE[id] : id;
    const price = prices[agent === 'claude' ? 'anthropic' : 'openai']?.[priceId];
    if (!price || !['cacheWrite5m', 'cacheRead', 'output'].every((k) => Number.isFinite(price[k]) && price[k] > 0)) throw new Error(`prices: no usable LiteLLM price for ${agent} ${id}`);
    model.price = { write: price.cacheWrite5m, read: price.cacheRead, output: price.output };
    const suffix = `-${agent === 'claude' ? 'anthropic' : 'openai'}-${priceId.replaceAll('.', '-')}-max-${agent === 'claude' ? 'claude-code' : 'codex'}.json`;
    const file = files.map((f) => f.name).filter((f) => /^\d{4}-\d\d-\d\d-/.test(f) && f.endsWith(suffix)).sort().at(-1);
    const entry = model['terminal-bench'], old = entry.board;
    delete entry.board;
    if (file) {
      const row = await github(`${BOARD_PATH}/submissions/${file}`);
      if (row.metadata?.reasoning_effort !== 'max' || row.metadata?.agent_display?.label !== (agent === 'claude' ? 'Claude Code' : 'Codex')) throw new Error(`board: ${file} is not max effort in the vendor harness`);
      entry.board = { file, ...Object.fromEntries(METRICS.map((k) => [k, row.metrics?.[k]])) };
      log.push(`board: ${agent} ${id}: ${file}`);
      if (agent === 'codex' && old?.file !== file) manual.push(`Read OpenAI effort results by hand for new board run ${file}; retained the committed sweep.`);
    }
  }
  for (const [url, mapping] of CHARTS) {
    const sweeps = anthropicSweeps(await fetchText(url), versionOf(version), Object.keys(mapping));
    for (const [series, [agent, id]] of Object.entries(mapping)) inputs.models[agent][id]['terminal-bench'].sweep = { source: 'anthropic', efforts: sweeps[series] };
    log.push(`anthropic: ${url}: Terminal-Bench ${versionOf(version)} CSV (${Object.keys(mapping).join(', ')})`);
  }
  if (!Array.isArray(catalog?.models) || !catalog.models.every((m) => typeof m.slug === 'string')) throw new Error('codex: unreadable model catalog');
  for (const m of catalog.models.filter((m) => m.visibility === 'list' && !EXCLUDED.has(m.slug))) {
    if (!inputs.models.codex[m.slug]) {
      const file = files.map((f) => f.name).filter((f) => f.endsWith(`-openai-${m.slug.replaceAll('.', '-')}-max-codex.json`)).sort().at(-1);
      if (file) manual.push(`Read OpenAI effort results by hand for new board run ${file}; add a measured model only with a verified ladder.`);
    }
    if (!inputs.models.codex[m.slug]?.['terminal-bench']?.sweep) manual.push(`Read OpenAI effort results by hand: catalog model ${m.slug} has no sweep; no quality is invented.`);
  }
  inputs.sources.prices = {
    name: 'LiteLLM model price catalog, standard tier', by: 'LiteLLM', licence: 'MIT; published list-price facts',
    url: prices.source, gives: 'server/price-catalog.snapshot.json: cacheWrite5m, cacheRead and output per million tokens for both vendors; refreshed with npm run gen:catalog',
  };
  inputs.credit = `Scores: Terminal-Bench ${versionOf(version)} (tbench.ai, Apache-2.0), with effort results published by Anthropic and OpenAI. Prices: Anthropic and OpenAI list prices from the LiteLLM catalog (MIT), read ${today}.`;
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
