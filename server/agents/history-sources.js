import fsp from 'node:fs/promises';
import path from 'node:path';
import { uuidFromName } from './codex-discover.js';

export async function claudeSources(root) {
  const out = [];
  let dirs;
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let files;
    try { files = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      // Only the top-level per-session transcripts. Sub-agent transcripts
      // (<session>/subagents/**) are artifacts of a session, not a conversation
      // you had — indexing them would surface the same work twice.
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      out.push({ file: path.join(dir, f.name), agent: 'claude', id: f.name.slice(0, -6) });
    }
  }
  return out;
}

export async function codexSources(root) {
  const out = [];
  async function walk(dir) {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        out.push({ file: full, agent: 'codex', id: uuidFromName(e.name) || e.name });
      }
    }
  }
  await walk(root);
  return out;
}

