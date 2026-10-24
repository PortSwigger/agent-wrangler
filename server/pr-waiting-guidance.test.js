import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { codex } from './agents/codex.js';
import { claude, shellQuote } from './agents/claude.js';
import { tomlString } from './codex-notify-config.js';
import { setLinksTool } from './mcp/tools/set-links.js';
import { getLinksTool } from './mcp/tools/get-links.js';

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const nudge = read('../agent-skills/skills/mail/WRANGLER.md').trim();

// Exercise the real builders, including their shell/TOML encoding. The entire
// sidecar must survive each always-on prompt path, not just the skill catalog.
for (const [name, adapter] of [['Codex', codex], ['Claude', claude]]) {
  for (const phase of ['Launch', 'Resume', 'Fork']) {
    test(`${name} ${phase.toLowerCase()} always-on prompt includes the full PR waiting guidance`, () => {
      const cmd = adapter[`build${phase}`]({
        sessionId: 'CARD', resumeId: 'LIVE', sourceId: 'SOURCE', liveSessionId: 'FORK',
      });
      assert.ok(cmd.includes(name === 'Codex' ? 'developer_instructions=' : '--append-system-prompt'));
      const encoded = name === 'Codex' ? shellQuote(tomlString(nudge).slice(1, -1)).slice(1, -1) : shellQuote(nudge).slice(1, -1);
      assert.ok(cmd.includes(encoded), 'full sidecar survives prompt encoding');
    });
  }
}

// These are documentation contracts: protect the operational caveats that make
// yielding safe, without pinning the prose or banning diagnostic commands.
const contracts = [
  ['yield instead of watching', /end (?:your|their) turn/i, /gh pr checks --watch/, /one-off diagnostics/i],
  ['failure can precede completion', /failures? (?:can|may) arrive (?:while|early)|other checks may still be running/i],
  ['passing means mergeable', /passing.{0,20}mergeable|mergeable.{0,20}passing/i],
  ['green awaiting review is separate', /awaiting.review/i],
  ['deduplication and same-head reruns', /deduplicated by status and head/i, /same-head rerun/i, /no new notice/i],
  ['scope and standalone Actions limits', /task links only (?:produce board )?toast/i, /standalone Actions/i, /not watched/i],
  ['disabled gate and fallback', /Auto-fix PR checks disabled/i, /session.{0,30}(?:override|setting)/i, /installation default/i, /hand back/i, /without authorization/i],
  ['silence is not success', /silence is not success/i],
];
for (const [name, file] of [
  ['always-on sidecar', '../agent-skills/skills/mail/WRANGLER.md'],
  ['links skill', '../agent-skills/skills/links/SKILL.md'],
  ['PR docs', '../docs/reviews-and-prs.md'],
]) {
  test(`${name} covers notification meanings, reliability and disabled-setting handoff`, () => {
    const text = read(file).replaceAll('**', '').replace(/\s+/g, ' ');
    for (const [meaning, ...patterns] of contracts) {
      for (const pattern of patterns) assert.match(text, pattern, meaning);
    }
  });
}

test('MCP link descriptions point agents to waiting guidance and preserve one-off diagnostics', () => {
  assert.match(setLinksTool.description, /read the links skill/i);
  assert.match(setLinksTool.description, /effective Auto-fix PR checks enabled/);
  assert.match(setLinksTool.description, /hand back/);
  assert.match(setLinksTool.description, /One-off diagnostics/);
  assert.match(getLinksTool.description, /not a fresh GitHub status check/);
  assert.match(getLinksTool.description, /do not repeatedly call it to wait/);
});
