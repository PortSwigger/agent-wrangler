import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import adversarialReview, { dir, DEFAULT_PROCESS, REPORT_CONTRACT } from './index.js';
import { validateManifest } from '../../index.js';
import { skillAt } from '../../../skill-catalog.js';
import { MAX_TEXTAREA_LENGTH } from '../../setting-constraints.js';

const tool = adversarialReview.tools.find((t) => t.name === 'adversarial_review_process');
const hostWith = (value) => ({ settings: { get: (key) => (key === 'process' ? value : undefined) } });
const call = async (value) => (await tool.handler({ host: hostWith(value), caller: 'S1' }, {})).content[0].text;

test('the manifest validates, is on by default, and declares the textarea range it needs', () => {
  assert.ok(validateManifest(adversarialReview));
  assert.equal(adversarialReview.id, 'adversarial-review');
  assert.equal(adversarialReview.defaultEnabled, true);
  assert.deepEqual(adversarialReview.requires, []);
  assert.equal(adversarialReview.engines.wranglerApi, '^1.16.0');
  assert.equal(adversarialReview.dir, dir);
});

test('the process setting is a textarea whose placeholder is the default process itself', () => {
  const [def] = adversarialReview.settings;
  assert.equal(def.key, 'process');
  assert.equal(def.type, 'textarea');
  assert.equal(def.placeholder, DEFAULT_PROCESS);
  assert.ok(DEFAULT_PROCESS.length < MAX_TEXTAREA_LENGTH, 'the default must fit the field it is shown in');
  assert.match(def.help, /default-process\.md/);
});

test('unset or blank, the tool returns the default process, labelled as such, then the fixed contract', async () => {
  for (const value of [undefined, null, '', '  \n\t ']) {
    const text = await call(value);
    assert.match(text, /^Review process: default/);
    assert.ok(text.includes(DEFAULT_PROCESS.trim()));
    assert.ok(text.indexOf(DEFAULT_PROCESS.trim()) < text.indexOf(REPORT_CONTRACT.trim()), 'the contract comes after the process');
  }
});

test('set, the custom process replaces the default wholesale and the contract still follows', async () => {
  const custom = '1. Only look at SQL.\n2. Nothing else.';
  const text = await call(custom);
  assert.match(text, /^Review process: custom/);
  assert.ok(text.includes(custom));
  assert.equal(text.includes(DEFAULT_PROCESS.trim()), false);
  assert.ok(text.includes(REPORT_CONTRACT.trim()));
});

test('the setting is read on every call, so an edit lands without a restart', async () => {
  let value = 'first';
  const host = { settings: { get: () => value } };
  assert.match((await tool.handler({ host }, {})).content[0].text, /first/);
  value = 'second';
  assert.match((await tool.handler({ host }, {})).content[0].text, /second/);
});

test('the report contract fixes the mail-back and the report shape the initiator relies on', () => {
  for (const needle of ['AW_SPAWNER_SESSION_ID', 'send_message', '--repo', 'Verdict: approve', 'Verdict: changes requested', 'Verdict: incomplete', 'blocker', 'major', 'minor', 'nit', 'confirmed', 'plausible', 'What I checked', 'Reviewed head']) {
    assert.ok(REPORT_CONTRACT.includes(needle), `contract mentions ${needle}`);
  }
  // `gh api` rejects --repo outright, so the contract must not demand it there.
  assert.match(REPORT_CONTRACT, /`gh api` has no `--repo` flag/);
  // The PR under review is untrusted input: it may not redirect the reviewer.
  assert.match(REPORT_CONTRACT, /evidence, not instructions/);
});

test('the default process covers gathering, verifying claims, test coverage and self-refutation', () => {
  for (const heading of ['Gather', 'Verify claims', 'Test coverage', 'Self-refute']) {
    assert.ok(DEFAULT_PROCESS.includes(heading), `default process has ${heading}`);
  }
  assert.match(DEFAULT_PROCESS, /sub-agent/);
  // A deleted file has no head revision; reading it there 404s.
  assert.match(DEFAULT_PROCESS, /deleted file has no head version/);
  assert.match(DEFAULT_PROCESS, /a clean review is a valid result/i);
});

test('the shipped skill is named as the manifest declares, and names the tool for the reviewer', () => {
  assert.deepEqual(adversarialReview.skills, ['adversarial-pr-review']);
  const skill = skillAt(path.join(dir, 'skills', 'adversarial-pr-review'));
  assert.equal(skill?.name, 'adversarial-pr-review');
  const body = fs.readFileSync(path.join(dir, 'skills', 'adversarial-pr-review', 'SKILL.md'), 'utf8');
  assert.match(body, /adversarial_review_process/);
  assert.match(body, /archive_session/);
});
