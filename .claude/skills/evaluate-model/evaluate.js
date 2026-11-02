import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const DATA_FILE = new URL('../../../public/model-front-data.json', import.meta.url);
const committedData = () => existsSync(DATA_FILE) ? JSON.parse(readFileSync(DATA_FILE, 'utf8')) : { models: {} };

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const SETS = { both: ['claude', 'codex'], claude: ['claude'], codex: ['codex'] };
const PRICES = ['write', 'read', 'output'];
const BOARD = ['accuracy', 'n_trials', 'uncached_input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens', 'avg_trial_duration_sec'];

// Python's round(), which the rows were first made with: the double's exact decimal value, a
// tie to even (4.25 is exactly representable, so 4.2, where toFixed says 4.3).
export function round(x, dp) {
  const s = x.toFixed(100), dot = s.indexOf('.'), n = Number(x.toFixed(dp));
  return /^50*$/.test(s.slice(dot + 1 + dp)) && s[dp ? dot + dp : dot - 1] % 2 === 0 ? Number((n - 10 ** -dp).toFixed(dp)) : n;
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

// One board trial at list price. The board's uncached_input_tokens counts every input token (its
// total_tokens is that plus output), so the cached share is priced as a read and the rest as a
// cache write, which is what an agent's fresh context costs.
export const boardUsd = (b, p) => ((b.uncached_input_tokens - b.cached_input_tokens) * p.write + b.cached_input_tokens * p.read + b.output_tokens * p.output) / 1e6 / b.n_trials;

const isNum = (v, min = 0) => typeof v === 'number' && Number.isFinite(v) && v >= min;
// Everything the derivation leans on, so a misread page is named here and never becomes a row.
export function inputErrors(inputs) {
  const errs = [], err = (at, what) => errs.push(`${at}: ${what}`);
  if (!/^\d{4}-\d\d-\d\d$/.test(inputs?.read ?? '')) err('read', 'not a YYYY-MM-DD date');
  if (typeof inputs?.credit !== 'string' || !inputs.credit.trim()) err('credit', 'missing');
  const sources = inputs?.sources || {}, benches = inputs?.benchmarks || {};
  for (const [id, s] of Object.entries(sources)) for (const f of ['name', 'by', 'licence', 'url']) if (!s?.[f]) err(`sources.${id}`, `no ${f}`);
  if (!Object.keys(sources).length) err('sources', 'none');
  for (const [b, x] of Object.entries(benches)) {
    if (!x?.name) err(`benchmarks.${b}`, 'no name');
    if (!versionOf(x?.version)) err(`benchmarks.${b}`, 'no major.minor version');
    if (!isNum(x?.weight)) err(`benchmarks.${b}`, 'weight is not a number >= 0');
  }
  if (!Object.values(benches).some((x) => x?.weight > 0)) err('benchmarks', 'no benchmark with a weight above 0');
  if (!Object.values(inputs?.models || {}).some((models) => Object.keys(models || {}).length)) err('models', 'no models');
  for (const [agent, models] of Object.entries(inputs?.models || {})) for (const [id, m] of Object.entries(models)) {
    const at = `${agent} ${id}`;
    if (m.like != null && (m.like === id || !models[m.like])) err(at, `like names no other ${agent} model`);
    if (!PRICES.every((p) => isNum(m.price?.[p]) && m.price[p] > 0)) err(at, `price needs ${PRICES.join(', ')} per million tokens`);
    for (const [b, x] of Object.entries(m)) {
      if (b === 'like' || b === 'price') continue;
      if (!benches[b]) { err(at, `${b} is not a benchmark`); continue; }
      const { board, sweep } = x || {};
      if (board) {
        if (!board.file) err(`${at} ${b} board`, 'no file');
        for (const f of BOARD) if (!isNum(board[f])) err(`${at} ${b} board`, `${f} is not a number`);
        if (!(board.accuracy <= 100) || !(board.n_trials > 0)) err(`${at} ${b} board`, 'accuracy over 100 or no trials');
        if (board.cached_input_tokens > board.uncached_input_tokens) err(`${at} ${b} board`, 'more cached input than input');
        if (board.total_tokens !== board.uncached_input_tokens + board.output_tokens) err(`${at} ${b} board`, 'total_tokens is not uncached_input_tokens + output_tokens, so the input count is misread');
      }
      if (sweep) {
        if (sweep.efforts?.max && !(sweep.efforts.max[0] > 0)) err(`${at} ${b} sweep`, 'max accuracy must be positive');
        if (!sources[sweep.source]) err(`${at} ${b} sweep`, `source ${sweep.source} is not in sources`);
        for (const [e, v] of Object.entries(sweep.efforts || {})) {
          if (!EFFORTS.includes(e)) err(`${at} ${b} sweep`, `${e} is not an effort`);
          else if (!Array.isArray(v) || v.length !== 2 || !isNum(v[0]) || v[0] > 100 || !(v[1] === null || (isNum(v[1]) && v[1] > 0))) err(`${at} ${b} sweep ${e}`, 'not [accuracy, usd or null]');
        }
      }
      if (!board && !sweep?.efforts?.max) err(`${at} ${b}`, 'neither a board row nor a vendor max of its own: never borrow quality');
    }
  }
  return errs;
}

// One benchmark's rows before rounding, and how each model got them. Each model is anchored at max
// (Q points, C dollars, T minutes) and laddered down by its vendor's sweep as a share of that
// vendor's max: the board's level, the vendor's shape. A model the board has not run takes its
// vendor's max plus the vendor's median gap to the board; what a model lacks it borrows from `like`.
function benchRows(inputs, bench) {
  const rows = {}, anchors = [], calibration = [];
  for (const [agent, models] of Object.entries(inputs.models)) {
    const at = (id) => models[id]?.[bench];
    const chain = (id, has) => { for (const seen = new Set(); id && models[id] && !seen.has(id); seen.add(id), id = models[id].like) if (has(at(id))) return id; return null; };
    const both = Object.keys(models).filter((id) => at(id)?.board && at(id)?.sweep?.efforts?.max);
    const priced = both.filter((id) => at(id).sweep.efforts.max[1] != null);
    const dq = median(both.map((id) => at(id).board.accuracy - at(id).sweep.efforts.max[0])) ?? 0;
    const k = median(priced.map((id) => boardUsd(at(id).board, models[id].price) / at(id).sweep.efforts.max[1])) ?? 1;
    calibration.push({ agent, dq, k, from: both, priced });
    // Column i (0 accuracy, 1 cost) as a share of max: its own sweep, interpolated between swept
    // efforts; below its lowest, the `like` model's ladder scaled to meet it; none, the `like` model's.
    const ladder = (id, i, seen = new Set()) => {
      if (!id || !models[id] || seen.has(id)) return null;
      seen.add(id);
      const s = at(id)?.sweep?.efforts, v = (e) => s?.[e]?.[i] ?? null;
      if (v('max') == null) return ladder(models[id].like, i, seen);
      const own = EFFORTS.map((e) => (v(e) == null ? null : v(e) / v('max'))), lo = own.findIndex((x) => x != null);
      const donor = lo > 0 ? ladder(models[id].like, i, seen) : null;
      if (lo > 0 && !donor) throw new Error(`${agent} ${id}: ${bench} sweep starts at ${EFFORTS[lo]} and its like chain has nothing lower`);
      return own.map((x, j) => {
        if (x != null) return x;
        if (j < lo) return donor[j] / donor[lo] * own[lo];
        const a = own.findLastIndex((y, n) => n < j && y != null), b = own.findIndex((y, n) => n > j && y != null);
        return own[a] + (own[b] - own[a]) * (j - a) / (b - a);
      });
    };
    rows[agent] = {};
    for (const [id, m] of Object.entries(models)) {
      const own = at(id), vmax = own?.sweep?.efforts?.max, timed = chain(id, (x) => x?.board);
      if (!own) throw new Error(`${agent} ${id}: no ${bench} entry`);
      if (!timed) throw new Error(`${agent} ${id}: no ${bench} board row in its like chain for minutes`);
      const Q = own.board ? own.board.accuracy : vmax[0] + dq;
      const [C, cost] = own.board ? [boardUsd(own.board, m.price), 'board tokens']
        : vmax[1] != null ? [vmax[1] * k, `vendor max $${vmax[1]} ×${k.toFixed(3)}`]
          : [boardUsd(at(timed).board, m.price), `${timed}'s board tokens at its own price`];
      const T = at(timed).board.avg_trial_duration_sec / 60;
      const P = ladder(id, 0), R = ladder(id, 1);
      if (!P || !R) throw new Error(`${agent} ${id}: no ${bench} ${P ? 'cost' : 'accuracy'} ladder in its like chain`);
      rows[agent][id] = Object.fromEntries(EFFORTS.map((e, j) => [e, [Q * P[j], C * R[j], T * (0.25 + 0.75 * R[j])]]));
      const swept = EFFORTS.filter((e) => own.sweep?.efforts?.[e]);
      anchors.push({ bench, agent, model: id, Q, C, T,
        quality: own.board ? 'board' : `vendor max ${vmax[0]} ${dq < 0 ? '-' : '+'}${Math.abs(dq).toFixed(2)}`, cost, minutes: timed === id ? 'board' : `like ${timed}`,
        ladder: swept.length ? `${own.sweep.source}: ${swept.join(', ')}${swept.length < EFFORTS.length || swept.some((e) => own.sweep.efforts[e][1] == null) ? ` (rest from ${m.like})` : ''}` : `from ${m.like}` });
    }
  }
  return { rows, anchors, calibration };
}

// Each row is the weighted mean of the benchmarks' rows, rounded once: quality to an integer,
// usd to 2dp, minutes to 1dp.
export function derive(inputs) {
  const errs = inputErrors(inputs);
  if (errs.length) throw new Error(`invalid inputs:\n  ${errs.join('\n  ')}`);
  const weighted = Object.entries(inputs.benchmarks).filter(([, b]) => b.weight > 0), total = weighted.reduce((s, [, b]) => s + b.weight, 0);
  const each = weighted.map(([id, b]) => ({ w: b.weight, ...benchRows(inputs, id) }));
  const rows = Object.fromEntries(Object.entries(inputs.models).map(([agent, models]) => [agent, Object.fromEntries(Object.keys(models).map((model) => [model,
    Object.fromEntries(EFFORTS.map((e) => {
      const [q, c, t] = [0, 1, 2].map((i) => each.reduce((s, x) => s + x.w * x.rows[agent][model][e][i], 0) / total);
      return [e, [round(q, 0), round(c, 2), round(t, 1)]];
    }))]))]));
  return { rows, anchors: each.flatMap((x) => x.anchors), calibration: each.flatMap((x, i) => x.calibration.map((c) => ({ bench: weighted[i][0], ...c }))) };
}
export const rowsOf = (inputs) => derive(inputs).rows;

export const dataOf = (inputs) => ({ read: inputs.read, credit: inputs.credit, benchmarks: inputs.benchmarks, models: rowsOf(inputs) });

// Kept local to the evaluator so refreshing data does not depend on the client API.
export function frontFor(rows, ids) {
  const points = Object.entries(rows).filter(([agent]) => ids.includes(agent)).flatMap(([agent, models]) =>
    Object.entries(models).flatMap(([model, efforts]) => Object.entries(efforts).map(([effort, [quality, usd, minutes]]) => ({ agent, model, effort, quality, usd, minutes }))));
  return points.filter((b) => !points.some((a) => a.quality >= b.quality && a.usd <= b.usd && a.minutes <= b.minutes
    && (a.quality > b.quality || a.usd < b.usd || a.minutes < b.minutes)))
    .sort((a, b) => a.usd - b.usd || b.quality - a.quality || a.minutes - b.minutes);
}

const key = (k) => (/^[a-z_$][\w$]*$/i.test(k) ? k : `'${k}'`);
const cell = (v) => `[${v.map(String).join(', ')}]`;
const line = (model, efforts) => `      ${key(model)}: { ${Object.entries(efforts).map(([e, v]) => `${e}: ${cell(v)}`).join(', ')} },`;
const pt = (p) => `${`${p.agent} ${p.model} ${p.effort}`.padEnd(26)} ${String(p.quality).padStart(3)} pts  $${p.usd.toFixed(2).padStart(5)}  ${String(p.minutes).padStart(4)} min`;
const urls = (u) => [u].flat().join(' ');

export function report(inputs, data = committedData()) {
  const { rows, anchors, calibration } = derive(inputs), out = [];
  const ok = true;
  out.push(`Sources read ${inputs.read}:`);
  for (const [id, s] of Object.entries(inputs.sources)) out.push(`  ${id.padEnd(10)} ${s.name}, ${s.by}: ${s.licence}`, `  ${''.padEnd(10)} ${urls(s.url)}`, ...(s.unconfirmed ? [`  ${''.padEnd(10)} UNCONFIRMED: ${s.unconfirmed}`] : []));
  out.push(...(inputs.manual || []).map((s) => `MANUAL: ${s}`));
  out.push('', 'Anchors at max (Q points, C dollars, T minutes) and ladders:');
  for (const c of calibration) out.push(`  ${c.bench} ${c.agent}: vendor to board ${c.dq < 0 ? '-' : '+'}${Math.abs(c.dq).toFixed(2)} pts (from ${c.from.join(', ') || 'none'}), ×${c.k.toFixed(3)} cost (from ${c.priced.join(', ') || 'none'})`);
  for (const a of anchors) out.push(`  ${`${a.agent} ${a.model}`.padEnd(20)} Q ${a.Q.toFixed(2).padStart(5)} ${a.quality}; C $${a.C.toFixed(2)} ${a.cost}; T ${a.T.toFixed(1)} ${a.minutes}; ladder ${a.ladder}`);
  out.push('', `Rows from inputs read ${inputs.read}, for public/model-front-data.json:`);
  for (const [agent, ms] of Object.entries(rows)) out.push(`    ${agent}: {`, ...Object.entries(ms).map(([m, es]) => line(m, es)), '    },');
  out.push('', 'Against the file:', `  ${data.credit === inputs.credit ? 'same' : 'CHANGED'}  credit ${JSON.stringify(inputs.credit)}${data.credit === inputs.credit ? '' : ` (file ${JSON.stringify(data.credit ?? null)})`}`);
  for (const [agent, ms] of Object.entries(rows)) for (const [model, es] of Object.entries(ms)) for (const [e, v] of Object.entries(es)) {
    const was = data.models[agent]?.[model]?.[e];
    out.push(`  ${was && cell(was) === cell(v) ? 'same' : was ? 'CHANGED' : 'NEW'}  ${agent} ${model} ${e} ${cell(v)}${was && cell(was) !== cell(v) ? ` (file ${cell(was)})` : ''}`);
  }
  for (const [agent, ms] of Object.entries(data.models)) for (const model of Object.keys(ms)) if (!rows[agent]?.[model]) out.push(`  GONE  ${agent} ${model}`);
  for (const [set, ids] of Object.entries(SETS)) {
    const front = frontFor(rows, ids);
    out.push('', `Front, ${set} (${front.length} points, cheapest first):`, ...front.map((p) => `  ${pt(p)}`));
  }
  return { text: out.join('\n'), ok };
}

// The scale is the major.minor: a patch (4.0.x) keeps it, anything else makes every row new.
export const versionOf = (v) => /^v?(\d+\.\d+)/.exec(String(v ?? ''))?.[1] ?? null;
const keysOf = (...os) => [...new Set(os.flatMap((o) => Object.keys(o || {})))];
const priceText = (p) => (p ? PRICES.map((k) => `${k} ${p[k]}`).join(', ') : 'none');

// base: the newest committed inputs; fresh: what the sources show now, in the same shape.
export function diffInputs(base, fresh) {
  const bumped = [], changed = [];
  for (const b of keysOf(base.benchmarks, fresh.benchmarks)) {
    const x = base.benchmarks?.[b], y = fresh.benchmarks?.[b], name = y?.name || x?.name || b, was = versionOf(x?.version), now = versionOf(y?.version);
    if (was !== now) bumped.push(`${name} v${was ?? '?'} -> v${now ?? '?'}`);
    if (x && y && x.weight !== y.weight) changed.push(`  CHANGED  ${name} weight ${x.weight} -> ${y.weight}`);
  }
  for (const agent of keysOf(base.models, fresh.models)) for (const model of keysOf(base.models[agent], fresh.models[agent])) {
    const a = base.models[agent]?.[model], b = fresh.models[agent]?.[model], at = `${agent} ${model}`;
    if (!a) { changed.push(`  NEW      ${at} (newly measured)`); continue; }
    if (!b) { changed.push(`  GONE     ${at} (not in the fresh reading)`); continue; }
    if ((a.like ?? null) !== (b.like ?? null)) changed.push(`  CHANGED  ${at} like ${a.like ?? 'none'} -> ${b.like ?? 'none'}`);
    if (priceText(a.price) !== priceText(b.price)) changed.push(`  CHANGED  ${at} price ${priceText(a.price)} -> ${priceText(b.price)}`);
    for (const bench of keysOf(a, b).filter((k) => k !== 'like' && k !== 'price')) {
      const x = a[bench] || {}, y = b[bench] || {};
      if (!x.board !== !y.board) changed.push(`  ${y.board ? 'NEW      ' : 'GONE     '}${at} ${bench} board ${y.board ? '(newly on the board)' : '(off the board)'}`);
      else if (x.board) for (const f of ['file', ...BOARD]) if (x.board[f] !== y.board[f]) changed.push(`  CHANGED  ${at} ${bench} board ${f} ${x.board[f]} -> ${y.board[f]}`);
      if ((x.sweep?.source ?? null) !== (y.sweep?.source ?? null)) changed.push(`  CHANGED  ${at} ${bench} sweep source ${x.sweep?.source ?? 'none'} -> ${y.sweep?.source ?? 'none'}`);
      for (const e of keysOf(x.sweep?.efforts, y.sweep?.efforts)) {
        const p = x.sweep?.efforts?.[e], q = y.sweep?.efforts?.[e];
        if (!p || !q || cell(p) !== cell(q)) changed.push(`  CHANGED  ${at} ${bench} sweep ${e} ${p ? cell(p) : 'none'} -> ${q ? cell(q) : 'none'}`);
      }
    }
  }
  if (JSON.stringify(base.sources) !== JSON.stringify(fresh.sources)) changed.push('  CHANGED  source provenance (see sources in the fresh inputs)');
  if (JSON.stringify([...(base.manual ?? [])].sort()) !== JSON.stringify([...(fresh.manual ?? [])].sort())) changed.push(`  CHANGED  manual source flags ${JSON.stringify(fresh.manual ?? [])}`);
  const status = bumped.length ? 'version bumped' : changed.length ? 'numbers changed' : 'up to date';
  const head = {
    'up to date': `up to date: the reading of ${fresh.read} matches the inputs read ${base.read} (${Object.values(fresh.benchmarks || {}).map((b) => `${b.name} v${versionOf(b.version)}`).join(', ')}).`,
    'numbers changed': `numbers changed since the inputs read ${base.read} (${changed.length}): rescore from the fresh reading.`,
    'version bumped': `version bumped since the inputs read ${base.read}: ${bumped.join(', ')}. Rows from two versions never mix: re-read every model at the new version, not only the changes below.`,
  }[status];
  return { status, bumped, changed, text: [head, ...changed].join('\n') };
}

const SKILL_DIR = fileURLToPath(new URL('.', import.meta.url));
export const newestInputs = (except) => readdirSync(SKILL_DIR).filter((f) => /^inputs-\d{4}-\d\d-\d\d\.json$/.test(f))
  .map((f) => resolve(SKILL_DIR, f)).filter((f) => f !== (except && resolve(except))).sort().at(-1);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--diff') {
      const [fresh, base = newestInputs(fresh)] = process.argv.slice(3);
      if (!fresh || !base) throw new Error('usage: evaluate.js --diff <fresh.json> [base.json]');
      const f = readJson(fresh), b = readJson(base);
      for (const inputs of [f, b]) {
        const errors = inputErrors(inputs);
        if (errors.length) throw new Error(errors.join('\n'));
      }
      const { text, status } = diffInputs(b, f);
      console.log(text);
      process.exitCode = { 'up to date': 0, 'numbers changed': 1, 'version bumped': 2 }[status];
    } else {
      const args = process.argv.slice(2), write = args.includes('--write');
      const file = args.find((arg) => !arg.startsWith('--')) || newestInputs(), inputs = readJson(file);
      console.log(report(inputs).text);
      if (write) {
        writeFileSync(DATA_FILE, `${JSON.stringify(dataOf(inputs), null, 2)}\n`);
        console.log('Wrote public/model-front-data.json');
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 3;
  }
}
