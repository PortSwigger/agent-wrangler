#!/usr/bin/env node
// agy's SessionStart hook in the board's plugin (agy-config.js). It reads agy's JSON payload
// on stdin and answers on stdout; any failure prints nothing and exits 0, so a
// hook can never stop a session.
//   SessionStart: records the conversation id agy is on for this card
//     ($AW_AGY_IDS_DIR/<card>.json) and the folder it was launched in
//     ($AW_AGY_IDS_DIR/conversations/<id>.json), and on a conversation's first start hands
//     agy the launch's instructions ($AW_AGY_CONTEXT) as a system message.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function sessionStart(payload, env = process.env, now = Date.now()) {
  const id = payload?.conversationId;
  const card = env.AW_SESSION_ID;
  const dir = env.AW_AGY_IDS_DIR;
  if (!card || typeof id !== 'string' || !id) return null;
  let previous = null;
  if (dir) {
    const file = path.join(dir, `${path.basename(card)}.json`);
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first start */ }
    const cwd = env.AW_AGY_CWD || null;
    const write = (f, body) => {
      const tmp = `${f}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(body));
      fs.renameSync(tmp, f);
    };
    try {
      fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true });
      write(file, { conversationId: id, at: now, cwd });
      if (cwd && /^[\w-]+$/.test(id)) write(path.join(dir, 'conversations', `${id}.json`), { cwd });
    } catch { /* the board falls back to finding it by folder */ }
  }
  // A resume of the same conversation already holds the instructions.
  const context = env.AW_AGY_CONTEXT;
  if (!context || previous?.conversationId === id) return null;
  return { injectSteps: [{ systemMessage: { systemMessage: context } }] };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 1024 * 1024) break; }
  const payload = JSON.parse(input || '{}');
  const event = process.argv[2];
  const out = event === 'SessionStart' ? sessionStart(payload) : null;
  if (out) process.stdout.write(JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main().catch(() => {}).finally(() => process.exit(0));
