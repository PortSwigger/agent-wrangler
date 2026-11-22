import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const FRONT_DATA = JSON.parse(readFileSync(new URL('../../../public/model-front-data.json', import.meta.url), 'utf8'));
import { rowsOf, derive, report, round, boardUsd, inputErrors, diffInputs, versionOf, newestInputs, dataOf, frontFor, EFFORTS } from './evaluate.js';
import { agy } from '../../../server/agents/agy.js';

const inputs = JSON.parse(readFileSync(new URL('./inputs-2026-10-28.json', import.meta.url), 'utf8'));
const skill = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8');
const tb = (agent, model, i = inputs) => i.models[agent][model]['terminal-bench'];
const row = (rows, agent, model) => EFFORTS.map((e) => rows[agent][model][e]);

test('the newest inputs reproduce every row and the credit in model-front-data.json exactly', () => {
  assert.deepEqual(dataOf(JSON.parse(readFileSync(newestInputs(), 'utf8'))), FRONT_DATA);
});

test('every source the inputs read is in SKILL.md’s licence table, with its links, and the credit names each', () => {
  for (const [id, s] of [inputs, JSON.parse(readFileSync(newestInputs(), 'utf8'))].flatMap((i) => Object.entries(i.sources))) {
    assert.match(skill, new RegExp(`^\\| \`${id}\` \\|`, 'm'), `${id} has a licence row`);
    for (const url of [s.url].flat()) assert.ok(skill.includes(url), `${id}: ${url} is in SKILL.md`);
  }
  for (const name of ['Terminal-Bench 4.0', 'Apache-2.0', 'Anthropic', 'OpenAI', 'list prices', inputs.read.slice(0, 4)]) assert.ok(inputs.credit.includes(name), name);
});

test('rounding is Python’s: exact ties to even, everything else to nearest', () => {
  assert.deepEqual([round(4.25, 1), round(4.45, 1), round(2.5, 0), round(3.5, 0), round(0.125, 2), round(0.375, 2), round(1.005, 2), round(2.675, 2)],
    [4.2, 4.5, 2, 4, 0.12, 0.38, 1, 2.67]);
});

test('a board model is anchored at max on the board and laddered by its vendor’s sweep, at list price', () => {
  const { board, sweep } = tb('claude', 'opus'), q = sweep.efforts, rows = rowsOf(inputs);
  const usd = boardUsd(board, inputs.models.claude.opus.price), mins = board.avg_trial_duration_sec / 60;
  assert.equal(round(usd, 2), 13.77, 'uncached input as a cache write, cached as a read, output as output, per trial');
  assert.deepEqual(row(rows, 'claude', 'opus'), EFFORTS.map((e) => {
    const r = q[e][1] / q.max[1];
    return [round(board.accuracy * q[e][0] / q.max[0], 0), round(usd * r, 2), round(mins * (0.25 + 0.75 * r), 1)];
  }));
  assert.deepEqual([rows.claude.opus.xhigh[0], rows.claude.opus.max[0]], [66, 65], 'Opus scores below xhigh at max, as Anthropic’s own sweep has it');
});

test('a model off the board stands on its vendor max as published', () => {
  const { anchors, calibration } = derive(inputs), at = (m) => anchors.find((a) => a.model === m);
  const cal = Object.fromEntries(calibration.map((c) => [c.agent, c]));
  assert.deepEqual(cal.claude.priced, ['opus', 'sonnet', 'fable']);
  assert.equal(cal.claude.k.toFixed(3), '1.225');
  assert.deepEqual([cal.codex.priced, cal.codex.k], [[], 1], 'Sol has no vendor cost, so Codex costs are taken as given');
  assert.equal(at('haiku').Q, tb('claude', 'haiku').sweep.efforts.max[0]);
  assert.equal(at('haiku').quality, 'vendor max 39.2');
  assert.equal(at('haiku').C, tb('claude', 'haiku').sweep.efforts.max[1] * cal.claude.k);
  assert.equal(at('haiku').minutes, 'like opus');
  assert.equal(at('gpt-6-astra').Q, tb('codex', 'gpt-6-astra').sweep.efforts.max[0]);
});

test('what a model lacks it borrows from its like chain, interpolating between swept efforts', () => {
  const rows = rowsOf(inputs), { anchors } = derive(inputs), at = (m) => anchors.find((a) => a.model === m);
  assert.equal(at('gpt-6.1-terra').cost, 'gpt-6.1-sol\'s board tokens at its own price');
  assert.equal(rows.codex['gpt-6.1-terra'].max[1], rows.codex['gpt-6.1-sol'].max[1] / 2, 'Sol’s tokens at half Sol’s price');
  assert.deepEqual(row(rows, 'codex', 'gpt-6.1-terra').map((r) => r[1]), row(rows, 'codex', 'gpt-6-astra').map((r, i) => round(rows.codex['gpt-6.1-terra'].max[1] * tb('codex', 'gpt-6-astra').sweep.efforts[EFFORTS[i]][1] / 10.35, 2)), 'Terra’s cost ladder is Astra’s, through Sol');
  const s = tb('codex', 'gpt-6.1-terra').sweep.efforts, p = (e) => s[e][0] / s.max[0], Q = at('gpt-6.1-terra').Q;
  assert.equal(rows.codex['gpt-6.1-terra'].high[0], round(Q * (p('medium') + (1 - p('medium')) / 3), 0), 'high is a third of the way from medium to max');
  const a = tb('codex', 'gpt-6-astra').sweep.efforts, sol = tb('codex', 'gpt-6.1-sol').sweep.efforts;
  assert.equal(rows.codex['gpt-6.1-sol'].low[0], round(58.18 * (a.low[0] / a.medium[0]) * (sol.medium[0] / sol.max[0]), 0), 'below Sol’s lowest sweep, Astra’s step down scaled to meet it');
  assert.equal(at('gpt-6-luna').ladder, 'from gpt-6.1-terra');
});

test('benchmarks average by weight, so a second one joins without touching the first', () => {
  const two = (weight, scale) => {
    const i = structuredClone(inputs);
    i.benchmarks.other = { name: 'Other', version: '1.0', weight };
    for (const ms of Object.values(i.models)) for (const m of Object.values(ms)) {
      const x = structuredClone(m['terminal-bench']);
      if (x.board) x.board.accuracy *= scale;
      if (x.sweep) for (const v of Object.values(x.sweep.efforts)) v[0] *= scale;
      m.other = x;
    }
    return rowsOf(i);
  };
  assert.deepEqual(two(0, 0.5), rowsOf(inputs), 'weight 0 changes nothing');
  assert.deepEqual(two(1, 1), rowsOf(inputs), 'the same numbers at weight 1 change nothing');
  assert.equal(two(1, 0.5).claude.opus.max[0], round(64.85 * 0.75, 0), 'half the accuracy at equal weight is three quarters of it');
});

test('malformed inputs are named, never turned into rows', () => {
  assert.deepEqual(inputErrors(inputs), []);
  const bad = structuredClone(inputs);
  tb('claude', 'opus', bad).board.total_tokens += 1;
  bad.models.claude.haiku.like = 'gpt-6.1-sol';
  delete bad.models.codex['gpt-6-astra']['terminal-bench'].sweep.efforts.max;
  tb('codex', 'gpt-6.1-terra', bad).sweep.source = 'blog';
  bad.models.codex['gpt-6-luna'].price.output = 0;
  delete bad.credit;
  const errs = inputErrors(bad).join('\n');
  for (const re of [/claude opus terminal-bench board: total_tokens is not/, /claude haiku: like names no other claude model/, /codex gpt-6-astra terminal-bench: neither a board row nor a vendor max/,
    /codex gpt-6.1-terra terminal-bench sweep: source blog is not in sources/, /codex gpt-6-luna: price needs/, /credit: missing/]) assert.match(errs, re);
  assert.throws(() => rowsOf(bad), /invalid inputs/);
  assert.match(inputErrors({ ...inputs, benchmarks: { 'terminal-bench': { ...inputs.benchmarks['terminal-bench'], weight: 0 } } }).join('\n'), /no benchmark with a weight above 0/);
});

test('the report lists the sources and their licences, flags what is unconfirmed, and finds nothing changed', () => {
  const { text, ok } = report(inputs, dataOf(inputs));
  assert.ok(ok);
  assert.doesNotMatch(text, /CHANGED|NEW|<- curated/);
  assert.match(text, /board +Terminal-Bench 4\.0 official leaderboard, Stanford, Laude Institute and Harbor: Apache-2\.0/);
  assert.match(text, /UNCONFIRMED: Taken from coverage crediting OpenAI/);
  assert.match(text, /claude haiku +Q 39\.20 vendor max 39\.2; /);
  assert.match(text, /Front, all \(19 points/);
});

test('front reporting is standalone and removes absent models', () => {
  const fresh = structuredClone(inputs);
  delete fresh.models.claude.fable;
  const { text, ok } = report(fresh, dataOf(inputs));
  assert.equal(ok, true);
  assert.match(text, /GONE +claude fable/);
  for (const set of ['all', 'claude', 'codex', 'gemini']) assert.match(text, new RegExp(`Front, ${set} \\(`));
  assert.doesNotMatch(text, /Programmes|curated/);
});

test('a fresh reading equal to the inputs is up to date, whatever day it was read', () => {
  const { status, text, changed } = diffInputs(inputs, { ...structuredClone(inputs), read: '2026-11-02' });
  assert.equal(status, 'up to date');
  assert.deepEqual(changed, []);
  assert.match(text, /^up to date: .*Terminal-Bench v4\.0/);
});

test('a changed number, a new board row, a new price, a newly measured model and a dropped one are numbers changed', () => {
  const fresh = structuredClone(inputs);
  tb('claude', 'opus', fresh).sweep.efforts.high = [65, 3.8843];
  tb('codex', 'gpt-6-luna', fresh).board.accuracy = 17.1;
  tb('claude', 'haiku', fresh).board = { ...tb('claude', 'opus').board, file: 'haiku.json' };
  fresh.models.codex['gpt-6.1-sol'].price.output = 8;
  fresh.models.claude.newt = fresh.models.claude.sonnet;
  delete fresh.models.claude.fable;
  const { status, text } = diffInputs(inputs, fresh);
  assert.equal(status, 'numbers changed');
  assert.match(text, /CHANGED {2}claude opus terminal-bench sweep high \[64\.2, 3\.8843\] -> \[65, 3\.8843\]/);
  assert.match(text, /CHANGED {2}codex gpt-6-luna terminal-bench board accuracy 16\.36 -> 17\.1/);
  assert.match(text, /NEW {6}claude haiku terminal-bench board \(newly on the board\)/);
  assert.match(text, /CHANGED {2}codex gpt-6\.1-sol price write 2\.5, read 0\.1, output 10 -> write 2\.5, read 0\.1, output 8/);
  assert.match(text, /NEW {6}claude newt/);
  assert.match(text, /GONE {5}claude fable/);
});

test('a version bump outranks changed numbers and lists both', () => {
  const fresh = structuredClone(inputs);
  fresh.benchmarks['terminal-bench'].version = '4.1';
  tb('claude', 'opus', fresh).board.accuracy = 66;
  const { status, bumped, text } = diffInputs(inputs, fresh);
  assert.equal(status, 'version bumped');
  assert.deepEqual(bumped, ['Terminal-Bench v4.0 -> v4.1']);
  assert.match(text, /newest version the board has run it on/);
  assert.match(text, /re-read every vendor sweep/);
  assert.match(text, /CHANGED {2}claude opus terminal-bench board accuracy 64\.85 -> 66/);
});

test('a superseded model lends its ladder to its successor and has no rows of its own', () => {
  const i = structuredClone(inputs);
  i.models.codex['gpt-new'] = { like: 'gpt-6-astra', price: i.models.codex['gpt-6-astra'].price, 'terminal-bench': { board: { ...tb('codex', 'gpt-6.1-sol', i).board, version: '4.1' } } };
  i.models.codex['gpt-6-astra'].supersededBy = 'gpt-new';
  const { rows } = derive(i), astra = tb('codex', 'gpt-6-astra', i).sweep.efforts, board = tb('codex', 'gpt-new', i).board;
  assert.equal(rows.codex['gpt-6-astra'], undefined);
  assert.equal(rows.codex['gpt-new'].low[0], round(board.accuracy * astra.low[0] / astra.max[0], 0));
  assert.equal(rows.codex['gpt-new'].max[2], round(board.avg_trial_duration_sec / 60, 1));
  const { text } = report(i, dataOf(inputs));
  assert.match(text, /codex gpt-6-astra +donor only, superseded by gpt-new/);
  assert.match(text, /codex gpt-new +Q \d+\.\d+ board 4\.1;/);
  assert.match(text, /GONE  codex gpt-6-astra/);
  i.models.codex['gpt-6-astra'].supersededBy = 'gpt-6-astra';
  tb('codex', 'gpt-new', i).board.version = 'next';
  const errs = inputErrors(i).join('\n');
  assert.match(errs, /codex gpt-6-astra: supersededBy names no other codex model/);
  assert.match(errs, /codex gpt-new terminal-bench board: version is not major.minor/);
});

test('a model moving to a newer board version, or being superseded, is a changed number', () => {
  const fresh = structuredClone(inputs);
  Object.assign(tb('claude', 'opus', fresh).board, { version: '4.1', minutes_file: 'original.json', hub_row: 'row-id' });
  fresh.sources.hub = { name: 'hub', by: 'hub', licence: 'cited', url: 'https://www.tbench.ai/' };
  tb('claude', 'opus', fresh).sweep.version = '4.0';
  fresh.models.codex['gpt-6-astra'].supersededBy = 'gpt-6.1-sol';
  const { status, text } = diffInputs(inputs, fresh);
  assert.equal(status, 'numbers changed');
  for (const re of [/claude opus terminal-bench board version undefined -> 4\.1/, /claude opus terminal-bench board minutes_file undefined -> original\.json/, /claude opus terminal-bench board hub_row undefined -> row-id/,
    /claude opus terminal-bench sweep version none -> 4\.0/, /codex gpt-6-astra supersededBy none -> gpt-6\.1-sol/]) assert.match(text, re);
});

test('a tbench.ai re-score names its row in the report and needs the hub source', () => {
  const i = structuredClone(inputs);
  Object.assign(tb('claude', 'opus', i).board, { version: '4.1', accuracy: 66, hub_row: 'row-id' });
  assert.match(inputErrors(i).join('\n'), /claude opus terminal-bench board: hub_row without a hub source/);
  i.sources.hub = { name: 'hub', by: 'hub', licence: 'cited', url: 'https://www.tbench.ai/' };
  assert.deepEqual(inputErrors(i), []);
  assert.match(report(i, dataOf(inputs)).text, /claude opus +Q 66\.00 board 4\.1 \(tbench\.ai; tokens and minutes from its GitHub run\); C \$\d+\.\d+ board tokens/);
});

test('a patch release keeps the scale; a missing version is a bump', () => {
  const tbWith = (version) => ({ ...inputs, benchmarks: { 'terminal-bench': { ...inputs.benchmarks['terminal-bench'], version } } });
  assert.equal(versionOf('v4.0.2'), '4.0');
  assert.equal(diffInputs(inputs, tbWith('4.0.2')).status, 'up to date');
  assert.equal(diffInputs(inputs, tbWith(undefined)).status, 'version bumped');
});

test('the newest inputs file is the base, never the fresh reading itself', () => {
  const newest = newestInputs();
  assert.match(newest, /inputs-\d{4}-\d\d-\d\d\.json$/);
  assert.ok(newest >= fileURLToPath(new URL('./inputs-2026-10-28.json', import.meta.url)));
  assert.notEqual(newestInputs(newest), newest);
});


test('front membership uses all three axes, keeps ties, and sorts cheapest first', () => {
  const rows = { claude: { sample: { low: [50, 1, 20], medium: [50, 2, 10], high: [50, 3, 20], max: [70, 4, 30] } }, codex: { sample: { low: [50, 1, 20] } } };
  const front = frontFor(rows, ['claude', 'codex']);
  assert.deepEqual(front.map((p) => [p.agent, p.effort]), [['claude', 'low'], ['codex', 'low'], ['claude', 'medium'], ['claude', 'max']]);
  assert.equal(frontFor(rows, ['codex']).length, 1);
});

test('source provenance and unresolved manual flags trigger a refresh without changing numbers', () => {
  const fresh = structuredClone(inputs);
  fresh.sources.openai.unconfirmed = 'Confirm the latest effort chart';
  assert.equal(diffInputs(inputs, fresh).status, 'numbers changed');
  fresh.manual = ['Read a newly published effort sweep'];
  assert.match(diffInputs(inputs, fresh).text, /manual source flags/);
});

test('an empty model set and a zero sweep denominator are rejected', () => {
  assert.throws(() => rowsOf({ ...inputs, models: {} }), /no models/);
  const bad = structuredClone(inputs);
  tb('claude', 'opus', bad).sweep.efforts.max[0] = 0;
  assert.throws(() => rowsOf(bad), /max accuracy must be positive/);
});

test('reordering the same manual source flags is no change', () => {
  assert.equal(diffInputs({ ...inputs, manual: ['Read sweep A', 'Read sweep B'] }, { ...inputs, manual: ['Read sweep B', 'Read sweep A'] }).status, 'up to date');
});

const gemini = JSON.parse(readFileSync(new URL('./inputs-2026-11-22.json', import.meta.url), 'utf8'));

test('an agy model is anchored at the effort the board ran it at, with rows only for the efforts it takes', () => {
  const { board, sweep } = tb('agy', 'gemini-4-hydrogen', gemini), q = sweep.efforts, rows = rowsOf(gemini);
  assert.equal(board.effort, 'high');
  const usd = boardUsd(board, gemini.models.agy['gemini-4-hydrogen'].price), mins = board.avg_trial_duration_sec / 60;
  assert.deepEqual(Object.keys(rows.agy['gemini-4-hydrogen']), ['low', 'medium', 'high', 'xhigh']);
  for (const e of ['low', 'medium', 'high', 'xhigh']) {
    const r = q[e][1] / q.high[1];
    assert.deepEqual(rows.agy['gemini-4-hydrogen'][e], [round(board.accuracy * q[e][0] / q.high[0], 0), round(usd * r, 2), round(mins * (0.25 + 0.75 * r), 1)], e);
  }
  assert.deepEqual(Object.keys(rows.agy['gemini-4-carbon']), ['low', 'medium', 'high'], 'Carbon stops at high, as agy offers it');
  assert.equal(rows.agy['gemini-4-neon'].xhigh[0], round(tb('agy', 'gemini-4-neon', gemini).board.accuracy, 0), 'Neon ran at xhigh, its top');
  assert.equal(rows.agy['gemini-4-neon'].high[0], rows.agy['gemini-4-neon'].xhigh[0], 'Hydrogen\'s ladder is flat from high to xhigh');
});

test('Gemini list prices bill fresh input at the input price, which reproduces the board\'s own cost', () => {
  const runs = { 'gemini-4-neon': 1922.24, 'gemini-4-carbon': 1358.25, 'gemini-4-hydrogen': 784.24 };
  for (const [id, total] of Object.entries(runs)) {
    const { board } = tb('agy', id, gemini);
    assert.equal(round(boardUsd(board, gemini.models.agy[id].price) * board.n_trials, 2), total, id);
  }
});

test('a Gemini model off the board stands on Google\'s figure at its top effort, priced on its donor\'s tokens', () => {
  const { anchors, rows } = derive(gemini), flash = anchors.find((a) => a.model === 'gemini-3.8-flash');
  assert.equal(flash.Q, 18.2);
  assert.equal(flash.quality, 'vendor max 18.2 at high');
  assert.equal(flash.cost, 'gemini-4-hydrogen\'s board tokens at its own price');
  assert.equal(flash.minutes, 'like gemini-4-hydrogen');
  assert.deepEqual(rows.agy['gemini-3.8-flash'].high, [18, round(boardUsd(tb('agy', 'gemini-4-hydrogen', gemini).board, gemini.models.agy['gemini-3.8-flash'].price), 2), rows.agy['gemini-4-hydrogen'].high[2]]);
});

test('the report prints a Gemini-only front next to Claude\'s and Codex\'s', () => {
  const { text } = report(gemini, dataOf(gemini)), front = text.split('Front, gemini (')[1];
  assert.match(front, /^\d+ points/);
  assert.match(front, /agy gemini-4-carbon high +65 pts/);
  assert.doesNotMatch(front, /claude|codex/);
  assert.match(text.split('Front, all (')[1], /agy gemini-4-carbon high/);
});

test('the measured agy models are ones agy offers, with the efforts it offers each', () => {
  for (const [id, m] of Object.entries(gemini.models.agy)) {
    assert.deepEqual(m.efforts, agy.effortsForModel(id).map((e) => e.value), id);
    assert.ok(agy.models.some((x) => x.value === id), id);
  }
});

test('an effort list or board effort the model cannot take is named', () => {
  const bad = structuredClone(gemini);
  bad.models.agy['gemini-4-carbon'].efforts = ['high', 'low'];
  tb('agy', 'gemini-4-argon', bad).board.effort = 'max';
  const errs = inputErrors(bad).join('\n');
  assert.match(errs, /agy gemini-4-carbon: efforts must be a non-empty, ascending list/);
  assert.match(errs, /agy gemini-4-argon terminal-bench board: effort max is not one the model takes/);
  const fresh = structuredClone(gemini);
  fresh.models.agy['gemini-4-carbon'].efforts = ['low', 'high'];
  tb('agy', 'gemini-4-neon', fresh).board.effort = 'high';
  const { text } = diffInputs(gemini, fresh);
  assert.match(text, /CHANGED {2}agy gemini-4-carbon efforts low, medium, high -> low, high/);
  assert.match(text, /CHANGED {2}agy gemini-4-neon terminal-bench board effort xhigh -> high/);
});
