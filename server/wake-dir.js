import fs from 'node:fs';
import os from 'node:os';
import { resolveResumeDir } from './transcript-reader.js';

// The dir an unattended wake resumes a dormant card in. A cleaned-up launch dir
// on this machine is recreated (there is no prompt to ask), falling back to
// home. A location card's folder is a path where it runs, so it is passed
// through untouched and nothing is created here.
export async function wakeDir(entry, id, resolve = resolveResumeDir) {
  if (entry?.location !== undefined) return entry.cwd || null;
  let dir = await resolve(entry?.liveSessionId || id, { entryCwd: entry?.cwd });
  if (!dir || !fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { dir = os.homedir(); }
  }
  return dir;
}
