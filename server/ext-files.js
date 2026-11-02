import { checkPathShape, readSafeFile } from './safe-file.js';
import { canOpenPath } from '../public/file-types.js';

const MAX_PER_EXTENSION = 5000;

// The paths each extension has registered through `host.files` (capability
// `files:view`). In memory only: an extension re-registers what it reports, and
// a restart forgets the lot. Oldest entries go first past the cap.
export function createExtFiles({ max = MAX_PER_EXTENSION } = {}) {
  const sets = new Map(); // extId -> Set<path>, insertion-ordered

  function allow(extId, p) {
    if (!checkPathShape(p) || !canOpenPath(p)) return false;
    let set = sets.get(extId);
    if (!set) sets.set(extId, (set = new Set()));
    set.delete(p);
    set.add(p);
    while (set.size > max) set.delete(set.values().next().value);
    return true;
  }

  return {
    allow,
    forget: (extId, p) => sets.get(extId)?.delete(p) ?? false,
    has: (extId, p) => sets.get(extId)?.has(p) ?? false,
    clear: (extId) => { sets.delete(extId); },
    // The only way bytes leave: shape, then type (both lexical), then membership,
    // and only then the disk. Never throws.
    async open(extId, p) {
      if (!checkPathShape(p)) return { ok: false, reason: 'invalid-path' };
      if (!canOpenPath(p)) return { ok: false, reason: 'unsupported-type' };
      if (!sets.get(extId)?.has(p)) return { ok: false, reason: 'not-permitted' };
      return readSafeFile(p);
    },
  };
}
