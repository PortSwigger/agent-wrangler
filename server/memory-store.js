import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import chokidar from 'chokidar';
import { DATA_DIR } from './data-dir.js';

// Per-task freeform markdown memory, edited interchangeably by the human (in the
// dashboard or their own editor) and by the agent running under that task. Each
// task gets its OWN folder so the agent can be granted only that folder — never
// the whole memory tree. The agent reaches its memory through a per-session
// *directory* symlink the server repoints on every assignment change, so both
// the path injected at launch (AW_TASK_MEMORY) and the granted dir (--add-dir)
// resolve to the current task's folder — even after a running session is
// reassigned, because Claude re-resolves the link on each file access (verified).
// On disk under ~/.agent-wrangler/memory/:
//   tasks/<taskId>/memory.md       canonical per-task memory (human + agent edit)
//   scratch/<sessionId>/memory.md  per-session fallback used while unassigned
//   by-session/<sessionId>         DIR SYMLINK → tasks/<taskId> or scratch/<sessionId>
export const MEMORY_DIR = path.join(DATA_DIR, 'memory');

// The stable path injected as AW_TASK_MEMORY: memory.md inside the per-session
// directory symlink. Pure (no instance) so session-manager can build the launch
// command without a circular import.
export function linkPathFor(sessionId) {
  return path.join(MEMORY_DIR, 'by-session', sessionId, 'memory.md');
}

// The directory passed as --add-dir: the per-session symlink itself, which
// resolves to the current task's folder. Scopes the agent to ONLY that task's
// memory (sibling task folders stay out of the allowed set), yet follows a
// reassignment because Claude re-resolves the link on each access.
export function addDirFor(sessionId) {
  return path.join(MEMORY_DIR, 'by-session', sessionId);
}

// taskId/sessionId become path segments, and a client can send arbitrary values
// over the control socket (get/set-memory, task-assign, resume, remove). Reject
// anything that isn't a single safe segment before it reaches the filesystem, so
// a value like `../../x` can't escape the memory dir to read it, clobber an
// arbitrary file (write), or delete an arbitrary tree (forget's recursive remove).
function isSafeSegment(s) {
  return typeof s === 'string' && s.length > 0 && s !== '.' && s !== '..' &&
    !s.includes('/') && !s.includes('\\') && !s.includes('\0');
}

export class MemoryStore {
  constructor(dir = MEMORY_DIR) {
    this.dir = dir;
    // taskId → bool, the "has content" dot. Populated lazily and invalidated by
    // write() and the watcher, so a rebuild every few seconds never re-reads every
    // task file from disk.
    this._hasMemory = new Map();
    for (const sub of ['tasks', 'scratch', 'by-session'])
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }

  taskDir(taskId) {
    return path.join(this.dir, 'tasks', taskId);
  }

  taskPath(taskId) {
    return path.join(this.taskDir(taskId), 'memory.md');
  }

  scratchDir(sessionId) {
    return path.join(this.dir, 'scratch', sessionId);
  }

  scratchPath(sessionId) {
    return path.join(this.scratchDir(sessionId), 'memory.md');
  }

  linkPath(sessionId) {
    return path.join(this.dir, 'by-session', sessionId);
  }

  // Point the session's by-session directory symlink at its current target: the
  // task folder when assigned, else the session's scratch folder (so the link is
  // always a real, writable directory — never dangling). Ensures the target folder
  // and an empty memory.md exist, then atomically repoints the relative symlink.
  // Idempotent: a no-op when the link already resolves to the right target. An
  // unsafe taskId falls back to scratch rather than building a dir from it.
  bindSession(sessionId, taskId) {
    if (!isSafeSegment(sessionId)) return;
    const targetDir = isSafeSegment(taskId) ? this.taskDir(taskId) : this.scratchDir(sessionId);
    fs.mkdirSync(targetDir, { recursive: true });
    const file = path.join(targetDir, 'memory.md');
    if (!fs.existsSync(file)) fs.writeFileSync(file, '');
    const link = this.linkPath(sessionId);
    // Relative so the memory dir stays movable; resolves from the link's own dir.
    const rel = path.relative(path.dirname(link), targetDir);
    let current = null;
    try { current = fs.readlinkSync(link); } catch { /* no link yet */ }
    if (current === rel) return;
    // symlink-then-rename so a concurrent reader never sees a missing link.
    const tmp = `${link}.tmp`;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* none */ }
    fs.symlinkSync(rel, tmp);
    fs.renameSync(tmp, link);
  }

  read(taskId) {
    if (!isSafeSegment(taskId)) return '';
    try { return fs.readFileSync(this.taskPath(taskId), 'utf8'); } catch { return ''; }
  }

  write(taskId, md) {
    if (!isSafeSegment(taskId)) return;
    const p = this.taskPath(taskId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, md);
    this._hasMemory.delete(taskId);
  }

  // Append (never read-modify-write) a chunk to the task's memory.md — the
  // archive-review runner's write path. A single synchronous O_APPEND syscall
  // can't race set-memory's whole-file write() or a concurrent append: both
  // land intact regardless of interleaving, unlike write()'s read-then-replace
  // shape, which would silently drop whichever writer finished first.
  append(taskId, md) {
    if (!isSafeSegment(taskId)) return;
    const p = this.taskPath(taskId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, md);
    this._hasMemory.delete(taskId);
  }

  // True iff the task file exists and has non-whitespace content. Drives the
  // tile's "has memory" dot without shipping the content in the graph. Cached
  // (invalidated by write()/the watcher) and statSize-gated so the common empty
  // case never costs a content read.
  hasMemory(taskId) {
    if (!isSafeSegment(taskId)) return false;
    if (this._hasMemory.has(taskId)) return this._hasMemory.get(taskId);
    let val = false;
    try {
      const p = this.taskPath(taskId);
      val = fs.statSync(p).size > 0 && fs.readFileSync(p, 'utf8').trim().length > 0;
    } catch { val = false; }
    this._hasMemory.set(taskId, val);
    return val;
  }

  // Drop a session's symlink and scratch folder (on permanent remove). The task
  // folder is shared and left untouched.
  forget(sessionId) {
    if (!isSafeSegment(sessionId)) return;
    try { fs.unlinkSync(this.linkPath(sessionId)); } catch { /* none */ }
    try { fs.rmSync(this.scratchDir(sessionId), { recursive: true, force: true }); } catch { /* none */ }
  }

  // Map a changed path under this.dir to its taskId iff it's a canonical
  // `tasks/<taskId>/memory.md` (not a by-session/ symlink or scratch/ file), else
  // null. Used by the watcher to ignore symlink/scratch churn.
  taskIdForFile(filePath) {
    const parts = path.relative(this.dir, filePath).split(path.sep);
    if (parts.length === 3 && parts[0] === 'tasks' && parts[2] === 'memory.md') return parts[1];
    return null;
  }

  // chokidar's `ignored` predicate: true ⇒ don't watch (and don't descend into)
  // this path. chokidar 4 has no fsevents, so it opens ONE fd per watched entry
  // (per-file `fs.watch`); watching the whole tree therefore held an fd for every
  // scratch dir + every agent-written file, growing until the process hit its fd
  // limit and every PTY spawn failed with "posix_spawnp failed" (restart-only).
  // The watcher only ever acts on tasks/<id>/memory.md (see taskIdForFile), so
  // confine it to that: watch `tasks/`, each `tasks/<id>/`, and the memory.md
  // inside — skip scratch/, by-session/, and any other file in a task dir.
  watchIgnored(filePath) {
    const rel = path.relative(this.dir, filePath);
    if (rel === '' || rel === '.') return false; // the watched root itself
    const parts = rel.split(path.sep);
    if (parts[0] !== 'tasks') return true;       // scratch/, by-session/, stray top-level entries
    if (parts.length <= 2) return false;         // 'tasks' and each 'tasks/<id>' dir
    if (parts.length === 3) return parts[2] !== 'memory.md'; // only memory.md within a task dir
    return true;                                 // anything deeper (e.g. tasks/<id>/sdd/…)
  }

  // Watch the memory dir and emit 'change' with the changed taskId. Mirrors
  // state-reader's chokidar config (ignoreInitial + awaitWriteFinish + debounce)
  // but carries the taskId payload and ignores symlink/scratch churn so an open
  // editor can live-refresh just the task that moved. followSymlinks:false keeps
  // a by-session link from re-reporting its target's edits a second time.
  createWatcher() {
    const emitter = new EventEmitter();
    const timers = new Map();
    const watcher = chokidar.watch(this.dir, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (p) => this.watchIgnored(p),
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 },
    });
    watcher.on('all', (_event, filePath) => {
      const taskId = this.taskIdForFile(filePath);
      if (!taskId) return;
      this._hasMemory.delete(taskId); // recompute the dot from disk on next read
      clearTimeout(timers.get(taskId));
      timers.set(taskId, setTimeout(() => { timers.delete(taskId); emitter.emit('change', taskId); }, 150));
    });
    emitter.close = () => watcher.close();
    return emitter;
  }
}
