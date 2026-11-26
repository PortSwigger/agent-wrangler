import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './data-dir.js';
import { ID_RE } from './extensions/provenance.js';

// Each extension's own data folder, DATA_DIR/ext-data/<id>/. Core creates it on
// first use (host.dataDir(), the store factory bag's dataDir()) and never reads
// what is inside. A Claude session an extension launched may be granted folders
// strictly inside it without a trust prompt (claude-trust.js extensionAddDirs).
export const extDataRoot = (dataDir = DATA_DIR) => path.join(dataDir, 'ext-data');

export function extDataDir(id, dataDir = DATA_DIR) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`Extension id must match ${ID_RE} (got ${JSON.stringify(id)})`);
  return path.join(extDataRoot(dataDir), id);
}

export function ensureExtDataDir(id, dataDir = DATA_DIR) {
  const dir = extDataDir(id, dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
