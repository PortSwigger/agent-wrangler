import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// How Codex is authenticated decides what its usage means in money: under ChatGPT
// auth it draws on plan allowance/credits and nothing is billed per token; under an
// API key it is billed at API rates. Read once per launch and recorded on the card,
// never re-read later to reinterpret old usage. Only `auth_mode` is read — the file
// also holds tokens, which must never be touched or logged.
export function readCodexAuthMode(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  let mode;
  try { mode = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'))?.auth_mode; } catch { return null; }
  if (typeof mode !== 'string') return null;
  if (/api/i.test(mode)) return 'apikey';
  if (/chatgpt/i.test(mode)) return 'chatgpt';
  return null;
}

// Append this launch's auth route to a card's history, only when it changed.
export function withCodexAuthLaunch(launches, mode, at) {
  const list = Array.isArray(launches) ? launches : [];
  if (list.length && list[list.length - 1].mode === mode) return list;
  return [...list, { at, mode }];
}

// The auth route behind one usage entry: the route recorded at the launch in force at
// that time is the authority. A ChatGPT plan type on the checkpoint is only a fallback
// for usage with no launch record (history from before launches were recorded, or a
// thread the wrangler never launched).
export function codexAuthAt(launches, ts, plan) {
  let mode = null;
  for (const l of Array.isArray(launches) ? launches : []) {
    if (ts == null || l.at <= ts) mode = l.mode;
  }
  if (mode) return mode;
  return plan ? 'chatgpt' : 'unknown';
}
