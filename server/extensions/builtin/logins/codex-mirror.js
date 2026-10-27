import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EXCLUDED = ['auth.json', 'app-server-control', 'app-server-daemon', 'ipc', 'process_manager', 'tmp'];
export function excluded(name) { return EXCLUDED.includes(name) || name.endsWith('-locks'); }

export function refreshMirror(mirrorDir, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  fs.mkdirSync(mirrorDir, { recursive: true, mode: 0o700 });
  const linked = []; const kept = [];
  for (const name of fs.readdirSync(codexHome).sort()) {
    if (excluded(name)) continue;
    const target = path.join(mirrorDir, name);
    const existing = fs.lstatSync(target, { throwIfNoEntry: false });
    if (existing) {
      if (!existing.isSymbolicLink()) kept.push(name);
    } else {
      fs.symlinkSync(path.resolve(codexHome, name), target);
      linked.push(name);
    }
  }
  return { linked, kept };
}
