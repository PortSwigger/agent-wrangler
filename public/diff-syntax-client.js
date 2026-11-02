import { LIMITS, languageForPath, projectHunk, admittedSource, validTokenLines } from './diff-syntax.js';
import { decorateTextEl } from './diff-dom.js';

// One lazy worker, one request at a time. A timeout kills regex execution, not
// merely the promise waiting for it. Failed entries are cached too.
export class SyntaxHighlighter {
  constructor(makeWorker = () => new Worker(new URL('./diff-syntax-worker.js', import.meta.url))) {
    this.makeWorker = makeWorker;
    this.cache = new Map();
    this.bytes = 0;
    this.tail = Promise.resolve();
  }
  async start() {
    if (this.worker) return;
    this.worker = this.makeWorker();
    await this.receive(2000, (data) => data?.ready === true);
  }
  receive(ms, valid) {
    return new Promise((resolve, reject) => {
      const worker = this.worker;
      const fail = () => { clearTimeout(timer); worker.terminate(); if (this.worker === worker) this.worker = null; reject(new Error('Highlight unavailable')); };
      const timer = setTimeout(fail, ms);
      worker.onerror = fail;
      worker.onmessage = ({ data }) => {
        if (!valid(data)) { fail(); return; }
        clearTimeout(timer); worker.onerror = null; worker.onmessage = null; resolve(data);
      };
    });
  }
  highlight(language, source, current = () => true) {
    const key = JSON.stringify(['prism-1.30.0', language, source]);
    const job = this.tail.then(async () => {
      if (!current()) return null;
      if (this.cache.has(key)) {
        const entry = this.cache.get(key); this.cache.delete(key); this.cache.set(key, entry);
        return entry.lines;
      }
      let lines = null;
      try {
        await this.start();
        const result = this.receive(200, (data) => data && Object.hasOwn(data, 'lines'));
        this.worker.postMessage({ language, source });
        const data = await result;
        if (validTokenLines(data.lines, source)) lines = data.lines;
      } catch { /* Keep the original plain text. */ }
      const bytes = (key.length + JSON.stringify(lines).length) * 2;
      this.cache.set(key, { lines, bytes }); this.bytes += bytes;
      while (this.bytes > LIMITS.cache && this.cache.size) {
        const first = this.cache.keys().next().value;
        this.bytes -= this.cache.get(first).bytes; this.cache.delete(first);
      }
      return lines;
    });
    this.tail = job.catch(() => null);
    return job;
  }
}

// Rendering creates targets synchronously. Async work decorates only those exact
// text elements, without replacing rows, anchors, selection or editor siblings.
export class DiffSyntax {
  constructor(highlighter = new SyntaxHighlighter()) { this.highlighter = highlighter; this.generation = 0; }
  cancel() { this.generation++; }
  async decorate(jobs, canApply) {
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    let budget = LIMITS.diff;
    let remaining = 128;
    let segmentsRemaining = LIMITS.renderSegments;
    for (const { file, hunk, targets } of jobs) {
      if (!current()) return;
      for (const side of ['new', 'old']) {
        const destinations = targets.filter((t) => t.side === side);
        if (!destinations.length) continue;
        const language = languageForPath(side === 'old' ? file.oldPath || file.path : file.path);
        if (!language) continue;
        const projection = projectHunk(hunk.lines, side);
        const source = admittedSource(projection);
        if (source == null || source.length * 2 > budget) continue;
        if (--remaining < 0) return;
        budget -= source.length * 2;
        const lines = await this.highlighter.highlight(language, source, current);
        if (!current()) return;
        if (!lines || !canApply()) continue;
        const segments = lines.reduce((n, line) => n + line.length, 0);
        if (segments > segmentsRemaining) continue;
        segmentsRemaining -= segments;
        const indexed = new Map(projection.map((ln, i) => [ln, lines[i]]));
        for (const target of destinations) {
          if (target.el.isConnected && target.el.textContent === target.ln.text) {
            decorateTextEl(target.el, target.ln.text, indexed.get(target.ln));
          }
        }
      }
    }
  }
}
