#!/usr/bin/env node
// Spike harness for the conversation search index: build (or top up) the corpus,
// then time a set of queries against it. Prints the numbers the Search tab shows,
// without needing a server or a browser.
//
//   node scripts/search-bench.mjs                       # build + default queries
//   node scripts/search-bench.mjs --rebuild             # from scratch
//   node scripts/search-bench.mjs "needle" "other one"  # your own queries
//
// AW_DATA_DIR is honoured, so it can be pointed at a throwaway index.

import { updateIndex, statsOf, readMeta, PATHS, _resetPool } from '../server/search/corpus.js';
import { search, _resetQueryPool } from '../server/search/query.js';

const args = process.argv.slice(2);
const rebuild = args.includes('--rebuild');
const queries = args.filter((a) => !a.startsWith('--'));

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const ms = (n) => `${n.toFixed(1)} ms`;

const t0 = Date.now();
const res = await updateIndex({
  rebuild,
  onProgress: (p) => process.stderr.write(`\r  indexing ${p.done}/${p.total} files · ${mb(p.corpusBytes)} corpus · ${p.records} messages   `),
});
process.stderr.write('\r\x1b[K');

console.log(`index ${rebuild ? 'rebuild' : 'update'}: ${res.filesRead} files read (${mb(res.bytesRead)} of transcript) in ${(res.ms / 1000).toFixed(2)}s`);
console.log(`corpus: ${mb(res.corpusBytes)} across ${res.records.toLocaleString()} messages in ${res.docs} conversations (${PATHS.dir})`);

const DEFAULTS = ['worktree', 'the', 'Buffer.indexOf', 'needs-you', 'zzz-no-such-string-zzz'];
for (const q of queries.length ? queries : DEFAULTS) {
  // Two runs: cold shows the page-cache miss, warm is what an interactive
  // keystroke actually costs.
  const cold = await search({ query: q, limit: 50 });
  const warm = await search({ query: q, limit: 50 });
  const ci = await search({ query: q, caseSensitive: true, limit: 50 });
  const ww = await search({ query: q, wholeWord: true, limit: 50 });
  console.log(
    `\n"${q}"  ${warm.matches.toLocaleString()} matches in ${warm.groups.length} shown conversations` +
    `\n   scan ${mb(warm.scannedBytes)} · mode ${warm.mode}${warm.workers ? ` (${warm.workers} workers)` : ''}` +
    `\n   cold ${ms(cold.ms)} · warm ${ms(warm.ms)} · case-sensitive ${ms(ci.ms)} (${ci.matches.toLocaleString()}) · whole-word ${ms(ww.ms)} (${ww.matches.toLocaleString()})`
  );
  const top = warm.groups[0];
  if (top && top.hits[0]) {
    const h = top.hits[0];
    const flat = h.snippet.replace(/\s+/g, ' ');
    console.log(`   e.g. [${h.role}] ${top.title || top.sessionId.slice(0, 8)}: …${flat.slice(0, 150)}…`);
  }
}

const meta = readMeta();
console.log(`\nindex on disk: ${mb(meta.corpusBytes * 2)} (text + folded) + ${mb(meta.recordCount * 20)} records`);
console.log(statsOf(meta));

await _resetQueryPool();
await _resetPool();
console.log(`\ntotal harness wall-clock: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
