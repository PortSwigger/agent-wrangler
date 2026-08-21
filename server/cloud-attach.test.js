import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cloudAttachSupported, recordAttachRefusal, recordAttachSuccess, CLOUD_ATTACH_UNSUPPORTED_MSG,
} from './cloud-attach.js';

// Injected config: `node --test` runs files in parallel against the developer's
// REAL ~/.agent-wrangler, so no test may read-modify-write the shared config.json.
function fakeConfig(initial = {}) {
  const store = { ...initial };
  const writes = [];
  return {
    store,
    writes,
    read: () => ({ ...store }),
    write: (patch) => {
      writes.push(patch);
      Object.assign(store, patch);
      return { ...store };
    },
  };
}

// The module keeps an in-process memo; recordAttachSuccess is its public reset.
const clearMemo = () => recordAttachSuccess(fakeConfig());

test('cloudAttachSupported: unknown means unsupported', () => {
  clearMemo();
  assert.equal(cloudAttachSupported({}), false);
});

test('cloudAttachSupported: an explicit cloudAttach boolean always wins', () => {
  clearMemo();
  // ON beats both the sticky recorded refusal and an in-process one — that is the
  // "flip one flag" rollout lever.
  assert.equal(cloudAttachSupported({ cloudAttach: true }), true);
  assert.equal(cloudAttachSupported({ cloudAttach: true, cloudAttachRefusedAt: 1700000000000 }), true);
  const cfg = fakeConfig();
  recordAttachRefusal(cfg);
  assert.equal(cloudAttachSupported({ cloudAttach: true }), true);
  // OFF beats the absence of any evidence.
  assert.equal(cloudAttachSupported({ cloudAttach: false }), false);
  clearMemo();
});

test('cloudAttachSupported: a non-boolean cloudAttach is not an override', () => {
  clearMemo();
  assert.equal(cloudAttachSupported({ cloudAttach: 'yes' }), false);
  assert.equal(cloudAttachSupported({ cloudAttach: 1 }), false);
});

test('recordAttachRefusal: persists a sticky timestamp, is idempotent, closes the gate', () => {
  clearMemo();
  const cfg = fakeConfig();
  assert.equal(recordAttachRefusal({ ...cfg, now: () => 1700000000000 }), true);
  assert.deepEqual(cfg.writes, [{ cloudAttachRefusedAt: 1700000000000 }]);
  assert.equal(cloudAttachSupported(cfg.read()), false);
  // Second refusal must not churn config.json.
  assert.equal(recordAttachRefusal({ ...cfg, now: () => 1800000000000 }), false);
  assert.equal(cfg.writes.length, 1);
  assert.equal(cfg.store.cloudAttachRefusedAt, 1700000000000);
  // The memo answers even for a config that never got the write (e.g. it failed).
  assert.equal(cloudAttachSupported({}), false);
  clearMemo();
});

test('recordAttachSuccess: clears the sticky flag, and no-ops when there is none', () => {
  const cfg = fakeConfig({ cloudAttachRefusedAt: 1700000000000 });
  assert.equal(recordAttachSuccess(cfg), true);
  assert.deepEqual(cfg.writes, [{ cloudAttachRefusedAt: null }]);
  assert.equal(cfg.store.cloudAttachRefusedAt, null);
  assert.equal(recordAttachSuccess(cfg), false);
  assert.equal(cfg.writes.length, 1);
});

test('the refusal message is toast-safe and names both ways out', () => {
  assert.match(CLOUD_ATTACH_UNSUPPORTED_MSG, /claude\.ai/);
  assert.match(CLOUD_ATTACH_UNSUPPORTED_MSG, /Teleport/);
  assert.ok(!CLOUD_ATTACH_UNSUPPORTED_MSG.includes('\n'));
});

// ── "one question, one answer" ────────────────────────────────────────────────
// The attach gate is only a single flag to flip if nothing else forms its own
// opinion, so the set of modules allowed to import it is pinned here. This is an
// ALLOWLIST, not a checklist: a member that doesn't exist (or doesn't import it)
// yet is fine — what must never happen is an importer outside the list.
//
// If you are here because this test just failed: do NOT widen the list to make it
// pass unless the new caller genuinely has to ask the question itself. The usual
// right answer is to read the already-computed `cloudAttachSupported` graph field
// (client side) or to take the answer from one of the callers below. If it really
// is a fourth legitimate asker, add it here AND to the "exactly three callers"
// comment in cloud-attach.js so the two never drift.
const ALLOWED_IMPORTERS = [
  'server/session-manager.js',   // _doResume's cloud branch: refuse, or build --cloud <id>
  'server/cloud-launch-watch.js', // the only producer of recordAttachRefusal
  'server/index.js',              // emits the graph-level cloudAttachSupported field
  'server/cloud-attach.test.js',  // this file
];
// Deliberately NOT on the list: cloud-steer.js, message-delivery.js and
// mailbox-delivery.js all need the answer, and all read it off the graph-level
// `cloudAttachSupported` field instead. That indirection IS the property this test
// protects — every consumer of the answer is a consumer, not a second opinion.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function jsFilesUnder(dir) {
  const out = [];
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (dirent.name === 'node_modules' || dirent.name.startsWith('.')) continue;
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) out.push(...jsFilesUnder(full));
    else if (/\.(?:js|mjs|cjs)$/.test(dirent.name)) out.push(full);
  }
  return out;
}

test('nothing outside the allowlist imports cloud-attach.js', () => {
  const specifier = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
  const offenders = [];
  for (const dir of ['server', 'public']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of jsFilesUnder(abs)) {
      const rel = path.relative(ROOT, file);
      if (ALLOWED_IMPORTERS.includes(rel)) continue;
      const src = fs.readFileSync(file, 'utf8');
      for (const [, spec] of src.matchAll(specifier)) {
        if (/(?:^|\/)cloud-attach(?:\.js)?$/.test(spec)) offenders.push(`${rel} → ${spec}`);
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    `cloud-attach.js must have exactly one answer to one question. Unexpected importer(s):\n  ${offenders.join('\n  ')}\n`
      + 'Read the graph-level cloudAttachSupported field instead, or justify a new entry in ALLOWED_IMPORTERS (and in cloud-attach.js\'s "exactly three callers" comment).',
  );
});
