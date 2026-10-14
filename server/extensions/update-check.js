import fs from 'node:fs';
import path from 'node:path';
import { readProvenance } from './provenance.js';
import { lsRemoteHead, countCommitsBehind } from './install.js';

// The background half of "Check all": run by the core update service's
// scheduled tick in Notify or Auto mode, and NOTIFY ONLY. Nothing here clones,
// installs or touches a working tree; an extension update always goes through
// its consent screen from the Extensions panel, whatever the mode.
//
// Built-in extensions have no remote, and a hand-placed one has no recorded
// origin, so both are left out of the result entirely rather than reported up
// to date. A failed check is kept on its own entry (the row shows it) but never
// counts towards `outdated`.
export function createExtensionUpdateCheck({
  list,
  provenance = readProvenance,
  lsRemote = lsRemoteHead,
  count = countCommitsBehind,
  hasGitDir = (dir) => fs.existsSync(path.join(dir, '.git')),
} = {}) {
  // `id@installed..remote` -> { commits, capped }, so an unmoved remote head is
  // never fetched again: one ls-remote per extension per tick is the steady state.
  const counted = new Map();

  async function countOnce(entry, record, remoteSha) {
    const key = `${entry.id}@${record.sha}..${remoteSha}`;
    if (counted.has(key)) return counted.get(key);
    let result;
    try {
      // No .git means git would walk up into whatever repo holds DATA_DIR.
      if (!entry.dir || !hasGitDir(entry.dir)) throw new Error('no clone to count in');
      result = await count(entry.dir, record.sha, record.originUrl);
    } catch {
      // The heads differ, so it is at least one change; say no more than that.
      return { commits: 1, capped: true };
    }
    for (const k of counted.keys()) if (k.startsWith(`${entry.id}@`)) counted.delete(k);
    counted.set(key, result);
    return result;
  }

  return async function checkExtensions() {
    const records = provenance();
    const extensions = [];
    for (const entry of list()) {
      if (!entry.external) continue;
      const record = records[entry.id];
      if (!record?.originUrl || !record.sha) continue;
      const base = { id: entry.id, label: entry.label || entry.id, updatable: true, originUrl: record.originUrl, sha: record.sha };
      try {
        const remoteSha = await lsRemote(record.originUrl);
        const behind = remoteSha !== record.sha;
        extensions.push({ ...base, remoteSha, behind, ...(behind ? await countOnce(entry, record, remoteSha) : {}) });
      } catch (err) {
        extensions.push({ ...base, error: String(err?.message || err) });
      }
    }
    return summarizeExtensionUpdates(extensions);
  };
}

export function summarizeExtensionUpdates(extensions) {
  const outdated = extensions.filter((e) => e.behind && !e.error);
  return {
    extensions,
    outdated: outdated.length,
    commitsBehind: outdated.reduce((n, e) => n + (e.commits || 0), 0),
    capped: outdated.some((e) => e.capped),
  };
}

// The last published result as it stands now: an extension updated (or
// uninstalled) since that check would otherwise read as out of date on every
// reconnect until the next tick.
export function currentExtensionUpdates(summary, records = readProvenance()) {
  if (!summary) return null;
  const still = summary.extensions.filter((e) => records[e.id]?.sha === e.sha);
  return { ...summarizeExtensionUpdates(still), checkedAt: summary.checkedAt };
}
