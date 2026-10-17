import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForComposerReady, ensureSubmitted, composerHoldsText, pasteImages, composerImageCount } from './pane-ready.js';

const ESC = '';
// Byte-exact against ghost-suggestion.js's own markers — paneComposerIsEmpty
// compares the composer line for EQUALITY, so an approximation reads as "not
// empty" and this file would pass while asserting nothing (a bug this file
// really did have once).
const codexEmpty = `${ESC}[1m›${ESC}[0m ${ESC}[2mAsk Codex to do anything${ESC}[0m`;
const claudeEmpty = `${ESC}[0m❯ `;
const booting = 'Loading…';
const working = '• Working (3s • esc to interrupt)';
const nowait = () => Promise.resolve();
const MSG = 'wake up please';
const codexHolding = `${ESC}[1m›${ESC}[0m ${MSG}`;

// classify()'s Codex self-update menu — a numbered list whose bare-Enter default
// is "Update now", which kills the session.
const updateMenu = [
  'Update available!',
  '1. Update now (runs `brew upgrade --cask codex`)',
  '2. Skip',
  '3. Skip until next version',
  'press enter to continue',
].join('\n');

test('waitForComposerReady resolves true as soon as the composer paints', async () => {
  let calls = 0;
  const ok = await waitForComposerReady('cx_a', '/s', 'codex', {
    capture: async () => { calls += 1; return calls < 3 ? booting : codexEmpty; },
    sleep: nowait,
  });
  assert.equal(ok, true);
  assert.equal(calls, 3);
});

test('resume readiness waits for input to paint but accepts Codex already working', async () => {
  let captures = 0;
  const ready = await waitForComposerReady('cx_a', '/s', 'codex', {
    capture: async () => {
      captures += 1;
      return captures < 3 ? booting : `${working}\n${codexEmpty}`;
    },
    sleep: nowait,
  });
  assert.equal(ready, true);
  assert.equal(captures, 3);
});

test('active-turn resume readiness still rejects drafts, dialogs and unreadable input', async () => {
  for (const pane of [
    `${working}\n${codexHolding}`,
    `${updateMenu}\n${codexEmpty}`,
    `${working}\n› Ask Codex to do anything`,
    '',
  ]) {
    assert.equal(await waitForComposerReady('cx_a', '/s', 'codex', {
      capture: async () => pane, timeoutMs: 0, sleep: nowait,
    }), false);
  }
});

test('waitForComposerReady is agent-aware (a Codex composer is not a Claude one)', async () => {
  assert.equal(await waitForComposerReady('cc_a', '/s', 'claude', {
    capture: async () => claudeEmpty, sleep: nowait,
  }), true);
  assert.equal(await waitForComposerReady('cc_a', '/s', 'claude', {
    capture: async () => codexEmpty, timeoutMs: 0, sleep: nowait,
  }), false);
});

// A timeout must leave delivery unconfirmed without bypassing the input guard.
test('waitForComposerReady returns false on timeout rather than throwing', async () => {
  assert.equal(await waitForComposerReady('cx_a', '/s', 'codex', {
    capture: async () => booting, timeoutMs: 0, sleep: nowait,
  }), false);
});

test('composerHoldsText reads the LAST marked line, so a submitted turn\'s echo is not mistaken for the composer', () => {
  // Exactly the shape a real pane takes after a successful send: the turn is
  // echoed back into the scrollback with the same prompt mark, and the empty
  // composer sits below it.
  const afterSubmit = `${codexHolding}\n• ACK\n${codexEmpty}`;
  assert.equal(composerHoldsText(afterSubmit, 'codex', MSG), false);
  assert.equal(composerHoldsText(`boot\n${codexHolding}`, 'codex', MSG), true);
});

test('composerHoldsText fails safe on an unparseable pane or empty text', () => {
  assert.equal(composerHoldsText('', 'codex', MSG), false);
  assert.equal(composerHoldsText(null, 'codex', MSG), false);
  assert.equal(composerHoldsText(codexHolding, 'codex', ''), false);
  assert.equal(composerHoldsText('no mark here at all', 'codex', MSG), false);
});

test('ensureSubmitted is a no-op once the pane reports working', async () => {
  const keys = [];
  const ok = await ensureSubmitted('cx_a', '/s', {
    text: MSG, agent: 'codex',
    capture: async () => working,
    sendKeys: (n, k) => { keys.push(k); return Promise.resolve(); },
    sleep: nowait,
  });
  assert.equal(ok, true);
  assert.deepEqual(keys, []);
});

// The measured failure: the paste lands in the composer but the CR that follows
// it is dropped, so the text sits there unsent. A bare Enter repairs exactly
// that, and re-pasting must never be used — the text IS already in the composer.
test('ensureSubmitted repairs a stranded paste with a bare Enter (never a re-paste)', async () => {
  const keys = [];
  let pane = codexHolding;
  const ok = await ensureSubmitted('cx_a', '/s', {
    text: MSG, agent: 'codex', windowMs: 0,
    capture: async () => pane,
    sendKeys: (n, k) => { keys.push(k); pane = working; return Promise.resolve(); },
    sleep: nowait,
  });
  assert.equal(ok, true);
  assert.deepEqual(keys, [['Enter']]);
});

// THE regression this redesign exists for. paneComposerIsEmpty deliberately
// strips faint runs, so a Claude composer holding nothing but a ghost suggestion
// reads as EMPTY — while pressing Enter on ghost text submits it
// (ghost-suggestion.js says so). Gating the repair on "we saw an empty composer
// before sending" would therefore fire here and start an unsolicited turn in
// text nobody wrote. Gating on our own text being present cannot.
test('ensureSubmitted never presses Enter on a ghost suggestion', async () => {
  const keys = [];
  const ghost = `${ESC}[0m❯ ${ESC}[2mshall I run the tests?${ESC}[0m`;
  const ok = await ensureSubmitted('cc_a', '/s', {
    text: MSG, agent: 'claude', windowMs: 0,
    capture: async () => ghost,
    sendKeys: (n, k) => { keys.push(k); return Promise.resolve(); },
    sleep: nowait,
  });
  assert.equal(ok, false, 'unconfirmed, so the caller reports unknown');
  assert.deepEqual(keys, [], 'a ghost suggestion must never be submitted');
});

// A dialog can appear AFTER the pre-send readiness check, so "we saw an empty
// composer earlier" proves nothing here. classify() already calls the Codex
// self-update menu needs-you; the loop must stop on it rather than press the
// Enter that would choose "Update now".
test('ensureSubmitted stops dead on a needs-you dialog and sends no keys', async () => {
  const keys = [];
  const ok = await ensureSubmitted('cx_a', '/s', {
    text: MSG, agent: 'codex',
    capture: async () => updateMenu,
    sendKeys: (n, k) => { keys.push(k); return Promise.resolve(); },
    sleep: nowait,
  });
  assert.equal(ok, false);
  assert.deepEqual(keys, []);
});

test('ensureSubmitted does not confirm updater activity as a submitted turn', async () => {
  const keys = [];
  const ok = await ensureSubmitted('cx_a', '/s', {
    text: MSG, agent: 'codex', windowMs: 0,
    capture: async () => `${working}\nUpdating Codex via \`brew upgrade --cask codex\`...\n==> Upgrading codex`,
    sendKeys: async (name, pressed) => { keys.push(pressed); },
    sleep: nowait,
  });
  assert.equal(ok, false);
  assert.deepEqual(keys, []);
});

// A turn that submitted and finished inside the observation window leaves an
// empty composer. That is deliberately NOT read as success (pre-paste looks
// identical), but it must not earn an Enter either.
test('ensureSubmitted sends no Enter against an empty composer', async () => {
  const keys = [];
  const ok = await ensureSubmitted('cx_a', '/s', {
    text: MSG, agent: 'codex', windowMs: 0,
    capture: async () => codexEmpty,
    sendKeys: (n, k) => { keys.push(k); return Promise.resolve(); },
    sleep: nowait,
  });
  assert.equal(ok, false);
  assert.deepEqual(keys, []);
});

// Another paste path (pane-deferral's drain, a mail announcement) can land in
// the same pane. Its text is not ours, so the repair must keep its hands off
// rather than submit someone else's half-delivered content.
test('ensureSubmitted will not submit a competing paste it did not write', async () => {
  const keys = [];
  const other = `${ESC}[1m›${ESC}[0m [Agent Wrangler] PR #12 checks passing`;
  const ok = await ensureSubmitted('cx_a', '/s', {
    text: MSG, agent: 'codex', windowMs: 0,
    capture: async () => other,
    sendKeys: (n, k) => { keys.push(k); return Promise.resolve(); },
    sleep: nowait,
  });
  assert.equal(ok, false);
  assert.deepEqual(keys, []);
});

// "Stranded" is judged only after the full window: immediately post-sendText the
// text is legitimately in the composer with the original Enter still in flight,
// and pressing again there races the TUI into two turns of the same prompt.
test('ensureSubmitted gives the original Enter its full window before repairing', async () => {
  const keys = [];
  let polls = 0;
  const ok = await ensureSubmitted('cx_a', '/s', {
    text: MSG, agent: 'codex', windowMs: 1000, pollMs: 300,
    capture: async () => { polls += 1; return polls < 3 ? codexHolding : working; },
    sendKeys: (n, k) => { keys.push(k); return Promise.resolve(); },
    sleep: nowait,
  });
  assert.equal(ok, true);
  assert.deepEqual(keys, [], 'the original Enter landed; no repair needed');
});

test('ensureSubmitted gives up after its attempt budget', async () => {
  const keys = [];
  const ok = await ensureSubmitted('cx_a', '/s', {
    text: MSG, agent: 'codex', attempts: 2, windowMs: 0,
    capture: async () => codexHolding,
    sendKeys: (n, k) => { keys.push(k); return Promise.resolve(); },
    sleep: nowait,
  });
  assert.equal(ok, false);
  assert.equal(keys.length, 2);
});

test('ensureSubmitted never captures or sends when handed no pane', async () => {
  let touched = false;
  const ok = await ensureSubmitted('', '/s', {
    text: MSG,
    capture: async () => { touched = true; return ''; },
    sendKeys: () => Promise.resolve(),
    sleep: nowait,
  });
  assert.equal(ok, false);
  assert.equal(touched, false);
});

test('waitForCompactionEnd: idle pane returns immediately; compacting pane waits, then reports finished; stuck times out', async () => {
  const { waitForCompactionEnd } = await import('./pane-ready.js');
  const compacting = '✻ Compacting conversation… (12s · esc to interrupt)\n';
  const idle = '❯ \n';
  assert.equal(await waitForCompactionEnd('p', '', { capture: async () => idle, sleep: async () => {} }), 'idle');
  const frames = [compacting, compacting, idle];
  assert.equal(await waitForCompactionEnd('p', '', { capture: async () => frames.shift() ?? idle, sleep: async () => {} }), 'finished');
  assert.equal(await waitForCompactionEnd('p', '', { capture: async () => compacting, sleep: async () => {}, timeoutMs: -1 }), 'timeout');
});

test('startup readiness accepts a working composer and an existing draft without requiring emptiness', async () => {
  for (const pane of [`${working}\n${codexEmpty}`, codexHolding, claudeComposer('restored draft'), claudeComposer('\u00a0')]) {
    assert.equal(await waitForComposerReady('p', '', pane.includes('❯') ? 'claude' : 'codex', {
      requireEmpty: false, capture: async () => pane, timeoutMs: 0, sleep: nowait,
    }), true);
  }
});

test('startup readiness needs a composer even when a working status is present', async () => {
  for (const pane of [booting, working, `${updateMenu}\n${codexEmpty}`]) {
    assert.equal(await waitForComposerReady('p', '', 'codex', {
      requireEmpty: false, capture: async () => pane, timeoutMs: 0, sleep: nowait,
    }), false);
  }
});

const claudeRule = '─'.repeat(60);
const claudeComposer = (draft = '') => `${claudeRule}\n${claudeEmpty}${draft}\n${claudeRule}\nHaiku 5.5\nauto mode on`;

test('startup readiness rejects selection cursors and history echoes', async () => {
  const panes = [
    ['Resume this session?', '❯ 1. Resume from summary (recommended)', '  2. Resume full session as-is', "  3. Don't ask me again"].join('\n'),
    ['Resume this session?', '❯ Resume from summary (recommended)', '  Resume full session as-is', "  Don't ask me again"].join('\n'),
    ['Allow this tool?', '❯ 1. Yes', '  2. No'].join('\n'),
    ['❯ fix the flaky test', '⏺ Done'].join('\n'),
  ];
  for (const pane of panes) {
    assert.equal(await waitForComposerReady('p', '', 'claude', {
      requireEmpty: false, capture: async () => pane, timeoutMs: 0,
    }), false, pane);
  }
  assert.equal(await waitForComposerReady('p', '', 'codex', {
    requireEmpty: false, capture: async () => `${ESC}[1;2m› old prompt${ESC}[0m\nDone`, timeoutMs: 0,
  }), false);
});

test('startup readiness accepts a framed Claude draft with several wrapped lines', async () => {
  assert.equal(await waitForComposerReady('p', '', 'claude', {
    requireEmpty: false,
    capture: async () => claudeComposer('first line\n  second line\n  third line\n  fourth line\n  fifth line'),
    timeoutMs: 0,
  }), true);
});

test('startup readiness rejects styled Codex startup and selection menus', async () => {
  const panes = [
    `Trust this folder?\n${ESC}[1m› 1. Trust and continue${ESC}[0m\n  2. Quit\n  enter continue · esc quit`,
    `Background server settings differ\n  1. Run without daemon this time\n  2. Restart with these settings\n${ESC}[1;7m› 3. Cancel${ESC}[0m`,
    `${codexEmpty}\n  ? for shortcuts\nReplace goal?\n${ESC}[1m› 1. Replace current goal${ESC}[0m\n  2. Cancel\n  enter select · esc back`,
  ];
  for (const pane of panes) {
    assert.equal(await waitForComposerReady('p', '', 'codex', {
      requireEmpty: false, capture: async () => pane, timeoutMs: 0,
    }), false, pane);
  }
});

test('startup readiness accepts a numbered Codex draft and selection hints quoted inside it', async () => {
  const pane = `${ESC}[1m›${ESC}[0m 1. first item\n  2. second item\n  enter continue · esc quit\n  GPT-6-Luna medium · /tmp/example\n  warnings`;
  assert.equal(await waitForComposerReady('p', '', 'codex', {
    requireEmpty: false, capture: async () => pane, timeoutMs: 0,
  }), true);
});

test('composerImageCount reads only the live composer, not echoed turns', () => {
  const pane = [`${ESC}[0m❯ look at [Image #1]`, '⏺ ok', '─────', `${ESC}[0m❯ [Image #2] [Image #3]`, '─────'].join('\n');
  assert.equal(composerImageCount(pane), 2);
  assert.equal(composerImageCount(`${ESC}[0m❯ `), 0);
  assert.equal(composerImageCount(booting), null);
});

test('pasteImages holds each paste until its marker appears, counting from a draft', async () => {
  const log = [];
  let composer = '❯ draft [Image #4]';
  let pending = null;
  let polls = 0;
  const ok = await pasteImages('cc_a', '/s', 'claude', ['/p/1.png', '/p/2.png'], {
    prefill: async (n, p) => { log.push(p); pending = p; polls = 0; },
    // Each image attaches on the third poll after its paste.
    capture: async () => {
      if (pending && (polls += 1) === 3) { composer += ` [Image #${5 + log.filter((l) => l.startsWith('/')).indexOf(pending)}]`; pending = null; }
      return composer;
    },
    sleep: async () => log.push(`wait:${composer.match(/\[Image/g).length}`),
  });
  assert.equal(ok, true);
  assert.deepEqual(log, ['/p/1.png', 'wait:1', 'wait:1', '/p/2.png', 'wait:2', 'wait:2'],
    'the second image is not pasted until the first has attached');
  assert.equal(composer, '❯ draft [Image #4] [Image #5] [Image #6]');
});

test('pasteImages gives up on a marker that never comes, but still pastes every image', async () => {
  const pasted = [];
  let now = 0;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const ok = await pasteImages('cc_a', '/s', 'claude', ['/p/1.png', '/p/2.png'], {
      timeoutMs: 1000,
      prefill: async (n, p) => { pasted.push(p); },
      capture: async () => '❯ ',
      sleep: async (ms) => { now += ms; },
    });
    assert.equal(ok, false);
    assert.deepEqual(pasted, ['/p/1.png', '/p/2.png']);
  } finally { Date.now = realNow; }
});

test('pasteImages does not wait on Codex or on a pane it cannot read', async () => {
  for (const [agent, pane] of [['codex', codexEmpty], ['claude', '']]) {
    const pasted = [];
    let slept = 0;
    const ok = await pasteImages('x', '/s', agent, ['/p/1.png'], {
      prefill: async (n, p) => { pasted.push(p); },
      capture: async () => pane,
      sleep: async () => { slept += 1; },
    });
    assert.deepEqual(pasted, ['/p/1.png']);
    assert.equal(slept, 0);
    assert.equal(ok, agent === 'codex');
  }
});
