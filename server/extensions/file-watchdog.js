import fs from 'node:fs';
import path from 'node:path';
import { logError as defaultLogError } from '../log.js';

export function startExtensionFileWatchdog({
  list,
  intervalMs = 60000,
  stat = fs.statSync,
  logError = defaultLogError,
  onChange = () => {},
}) {
  let missing = new Map();
  const timer = setInterval(() => {
    const next = new Map();
    for (const entry of list()) {
      if (!entry.external || entry.quarantine || !entry.dir) continue;
      let absent = null;
      let checking = entry.dir;
      try {
        if (!stat(entry.dir).isDirectory()) absent = entry.dir;
        else {
          checking = path.join(entry.dir, 'index.js');
          if (!stat(checking).isFile()) absent = checking;
        }
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') absent = checking;
        else if (missing.has(entry.id)) next.set(entry.id, missing.get(entry.id));
      }
      if (!absent) continue;
      next.set(entry.id, { id: entry.id, label: entry.label || entry.id });
      if (!missing.has(entry.id)) logError(`[extension-files] Loaded extension ${entry.id} (${entry.label || entry.id}) has missing directory or manifest: ${absent}. Restore its files or reinstall the extension.`);
    }
    const changed = next.size !== missing.size || [...next.keys()].some((id) => !missing.has(id));
    missing = next;
    if (changed) onChange([...missing.values()]);
  }, intervalMs);
  timer.unref();
  return timer;
}
