import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-json.js';
export function ensureAgyTrust(cwd, { home = os.homedir(), enabled = false } = {}) {
  if (!enabled || !path.isAbsolute(cwd)) return false;
  const file = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
  for (let n = 0; n < 3; n++) {
    let before = '{}';
    try { before = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') return false; }
    let cfg; try { cfg = JSON.parse(before); } catch { return false; }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || (cfg.trustedWorkspaces && !Array.isArray(cfg.trustedWorkspaces))) return false;
    const trusted = cfg.trustedWorkspaces || [];
    if (trusted.includes(cwd)) return true;
    let now = '{}'; try { now = fs.readFileSync(file, 'utf8'); } catch {}
    if (now !== before) continue;
    writeJsonAtomic(file, { ...cfg, trustedWorkspaces: [...trusted, cwd] }, { trailingNewline: true });
    return true;
  }
  return false;
}
