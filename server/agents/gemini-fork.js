#!/usr/bin/env node
// Forks a Gemini CLI conversation under an id we choose, so a fork, like a
// launch, knows its conversation id up front. Gemini 0.66 has no fork flag
// (`--session-file` imports a copy but mints its own id and drops tool calls),
// so the fork's pane runs this first and then `gemini --resume <newId>`:
//
//   node gemini-fork.js <sourceId> <newId> [prompt]
//
// It copies the source conversation into the chats folder Gemini resumes from
// for the current directory, renamed and re-headed with the new id, plus
// `forkedFrom`/`forkedAt` so usage bills only what the fork itself spends.
//
// A fork's first prompt cannot ride on the command line: Gemini 0.66 submits a
// `--prompt-interactive` prompt as soon as its client starts, racing the resume,
// and a prompt that wins is recorded into a second, headerless file. So with a
// prompt this also leaves a helper behind that types it into its own pane once
// the resumed conversation is open and the composer is idle.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GEMINI_TMP, findConversationSync, geminiHome, readProjects, shortId } from './gemini-files.js';

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

// Gemini's own file name stamp: the UTC minute, colons as dashes.
const stamp = (date) => date.toISOString().slice(0, 16).replace(/:/g, '-');

export function forkConversation({ sourceId, newId, cwd = process.cwd(), root = GEMINI_TMP, home = geminiHome(), now = new Date(), register } = {}) {
  if (!SAFE_ID.test(sourceId || '') || !SAFE_ID.test(newId || '')) throw new Error('fork needs a source and a new session id');
  const source = findConversationSync(sourceId, root);
  if (!source) throw new Error(`No Gemini conversation ${sourceId} to fork`);
  if (findConversationSync(newId, root)) throw new Error(`Gemini conversation ${newId} already exists`);
  let slug = readProjects(home)[cwd];
  // Gemini registers a directory the first time it runs there; a fork into one
  // it has never seen asks it to, so `--resume` looks where the copy lands.
  if (!slug && register) {
    register(cwd);
    slug = readProjects(home)[cwd];
  }
  const chats = slug ? path.join(home, 'tmp', slug, 'chats') : path.dirname(source);
  const [first, ...rest] = fs.readFileSync(source, 'utf8').split('\n');
  const head = JSON.parse(first);
  const at = now.toISOString();
  const forkedHead = {
    ...head, sessionId: newId, projectHash: crypto.createHash('sha256').update(cwd).digest('hex'),
    startTime: at, lastUpdated: at, forkedFrom: sourceId, forkedAt: at,
  };
  fs.mkdirSync(chats, { recursive: true });
  const file = path.join(chats, `session-${stamp(now)}-${shortId(newId)}.jsonl`);
  // A resume records the parent's id as a `$set`, which would rename the copy
  // back; dropped, so the header's new id stands and the copy's own resume
  // (which records it again) is what deliver() waits for.
  const body = rest.flatMap((line) => {
    if (!line.includes('"sessionId"')) return [line];
    try {
      const rec = JSON.parse(line);
      if (rec?.$set && typeof rec.$set.sessionId === 'string') {
        const { sessionId: _, ...others } = rec.$set;
        return Object.keys(others).length ? [JSON.stringify({ ...rec, $set: others })] : [];
      }
    } catch { /* a torn last line stays as it is */ }
    return [line];
  });
  fs.writeFileSync(file, [JSON.stringify(forkedHead), ...body].join('\n'), { flag: 'wx' });
  return file;
}

// Whether Gemini has opened `file` as the resumed conversation: resuming writes a
// `$set` of the session id into it.
export function resumedInto(text, id) {
  return text.includes(`{"$set":{"sessionId":${JSON.stringify(id)}}}`);
}

// Whether the pane shows an idle composer: no turn, hook or dialog running.
export function paneIdle(text) {
  const lines = String(text).split('\n').filter((l) => l.trim()).slice(-12).join('\n');
  return /Type your message/.test(lines) && !/Executing Hook|esc to cancel|Waiting for/i.test(lines);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deliver({ file, newId, prompt, pane }) {
  const tmux = (args, input) => spawnSync('tmux', args, { input, encoding: 'utf8', timeout: 10_000 });
  const deadline = Date.now() + 180_000;
  let resumed = false;
  while (Date.now() < deadline) {
    if (!resumed) {
      try { resumed = resumedInto(fs.readFileSync(file, 'utf8'), newId); } catch { /* not yet */ }
    } else if (paneIdle(tmux(['capture-pane', '-p', '-t', pane]).stdout || '')) {
      // Bracketed paste, so a multi-line prompt is one message, then Enter.
      tmux(['load-buffer', '-b', `aw-fork-${newId}`, '-'], prompt);
      tmux(['paste-buffer', '-p', '-d', '-b', `aw-fork-${newId}`, '-t', pane]);
      await sleep(400);
      tmux(['send-keys', '-t', pane, 'Enter']);
      return;
    }
    await sleep(500);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === '--deliver') {
    const [, , , file, newId, pane] = process.argv;
    await deliver({ file, newId, pane, prompt: process.env.AW_GEMINI_FORK_PROMPT || '' });
    process.exit(0);
  }
  const [sourceId, newId, prompt = ''] = process.argv.slice(2);
  try {
    const file = forkConversation({
      sourceId, newId,
      // The pane's own Gemini home (the board's) first, where the copy lands.
      root: [path.join(geminiHome(), 'tmp'), ...GEMINI_TMP],
      register: () => spawnSync('gemini', ['--skip-trust', '--list-sessions'], { stdio: 'ignore', timeout: 30_000 }),
    });
    if (prompt.trim() && process.env.TMUX_PANE) {
      const helper = spawn(process.execPath, [fileURLToPath(import.meta.url), '--deliver', file, newId, process.env.TMUX_PANE], {
        detached: true, stdio: 'ignore', env: { ...process.env, AW_GEMINI_FORK_PROMPT: prompt.trim() },
      });
      helper.unref();
    }
  } catch (err) {
    process.stderr.write(`Agent Wrangler could not fork the Gemini conversation: ${err.message}\n`);
    process.exit(1);
  }
}
