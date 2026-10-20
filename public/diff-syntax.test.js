import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { LIMITS, languageForPath, projectHunk, admittedSource, tokenLines, validTokenLines } from './diff-syntax.js';
import { SyntaxHighlighter, DiffSyntax } from './diff-syntax-client.js';
import { readableInk, contrast } from './diff-syntax-palette.js';

const context = vm.createContext({ self: { Prism: { manual: true, disableWorkerMessageHandler: true } } });
context.window = context.self;
// Execute the production loader so missing grammars or dependency order fail here too.
context.importScripts = (path) => {
  vm.runInContext(fs.readFileSync(new URL(path, import.meta.url), 'utf8'), context);
  context.Prism = context.self.Prism;
};
const worker = fs.readFileSync(new URL('./diff-syntax-worker.js', import.meta.url), 'utf8');
vm.runInContext(worker.slice(0, worker.indexOf("import('./diff-syntax.js')")), context);

const prism = context.Prism;
const highlight = (source, language = 'javascript') => tokenLines(prism.tokenize(source, prism.languages[language]), source);

test('explicit extension selection, paths, casing and conservative unknown fallback', () => {
  for (const [path, expected] of Object.entries({
    'src/A.JS': 'javascript', 'a.mjs': 'javascript', 'a.cts': 'typescript', 'a.jsx': 'jsx', 'a.tsx': 'tsx',
    'x.json': 'json', 'a.svg': 'markup', 'a.css': 'css', 'a.sh': 'bash', 'a.py': 'python', 'a.yml': 'yaml', 'a.md': 'markdown',
    'src/Main.java': 'java', 'src/Program.cs': 'csharp', 'src/main.go': 'go',
    'a.cjs': 'javascript', 'a.ts': 'typescript', 'a.mts': 'typescript', 'a.html': 'markup',
    'a.htm': 'markup', 'a.xml': 'markup', 'a.bash': 'bash', 'a.yaml': 'yaml', 'a.markdown': 'markdown',
  })) {
    assert.equal(languageForPath(path), expected);
    assert.equal(languageForPath(path.toUpperCase()), expected);
    assert.equal(languageForPath(path.replace(/.$/, (c) => c.toUpperCase())), expected);
  }
  for (const path of ['Dockerfile', 'foo.vue', 'foo.svelte', 'foo.unknown', 'a.js/README', '', '__proto__', 'a.constructor']) {
    assert.equal(languageForPath(path), null);
  }
});

test('all bundled grammars reconstruct source exactly, including markup and trailing blank lines', () => {
  for (const [language, source] of Object.entries({
    javascript: 'const text = `<img onerror="oops()">`;\n\n', typescript: 'const x: string = "hi";',
    jsx: 'const x = <Widget title="hi" />;', tsx: 'const x: JSX.Element = <b>hi</b>;', json: '{"x": true}',
    java: '// café 😀\npublic class Main { String text = "<b>& hello"; }\n\n',
    csharp: '// café 😀\npublic class Program { string text = $"<b>& {1 + 2}"; }\n\n',
    go: '// café 😀\npackage main\nfunc main() { text := `<b>& hello`; _ = text }\n\n',
    markup: '<script>alert("safe")</script>', css: 'body { color: red; }', bash: 'echo "$HOME"',
    python: 'def greet():\n    return "hi"', yaml: 'name: hello', markdown: '# Hello\n`<b>`',
  })) assert.ok(validTokenLines(highlight(source, language), source), language);
});

test('real grammars assign theme roles to keywords, strings and comments', () => {
  for (const [language, source, keyword, string, comment] of [
    ['java', 'public class Main { String text = "hello"; /* comment */ }', 'public', '"hello"', '/* comment */'],
    ['csharp', 'public class Program { string text = "hello"; /* comment */ }', 'public', '"hello"', '/* comment */'],
    ['go', 'package main\nfunc main() { text := "hello" } // comment', 'package', '"hello"', '// comment'],
    ['javascript', 'const text = "hello"; // comment', 'const', '"hello"', '// comment'],
    ['typescript', 'const text: string = "hello"; // comment', 'const', '"hello"', '// comment'],
    ['python', 'return "hello" # comment', 'return', '"hello"', '# comment'],
    ['bash', 'if true; then echo "hello"; fi # comment', 'if', '"hello"', '# comment'],
  ]) {
    const segments = highlight(source, language).flat();
    for (const [text, role] of [[keyword, 'keyword'], [string, 'string'], [comment, 'comment']]) {
      assert.ok(segments.some((s) => s.text === text && s.role === role), `${language}: ${role}`);
    }
  }
  // These grammars use tags, attributes or other roles rather than all three above.
  for (const [language, source, role] of [
    ['jsx', 'const x = <Widget />;', 'function'], ['tsx', 'const x: JSX.Element = <Widget />;', 'function'],
    ['json', '{"message":"hello"}', 'string'], ['markup', '<b title="hello">text</b>', 'function'],
    ['css', '/* comment */ body { color: red; }', 'comment'],
    ['yaml', 'message: "hello"', 'string'], ['markdown', '<!-- comment -->', 'comment'],
  ]) assert.ok(highlight(source, language).flat().some((s) => s.role === role), language);
});

test('multiline projections keep old/new syntax independent and reset between hunks', () => {
  const lines = [
    { type: 'del', text: '/* old comment' }, { type: 'add', text: 'const x = `new string' },
    { type: 'context', text: 'shared text' }, { type: 'del', text: '*/' }, { type: 'add', text: '`;' },
  ];
  const old = projectHunk(lines, 'old'), next = projectHunk(lines, 'new');
  assert.equal(old.length, 3); assert.equal(next.length, 3);
  assert.equal(highlight(admittedSource(old))[1][0].role, 'comment');
  assert.equal(highlight(admittedSource(next))[1][0].role, 'string');
  assert.equal(highlight('const y = 1;')[0][0].role, 'keyword');
});

test('size, depth, segment, role and reconstruction limits fail closed', () => {
  assert.equal(admittedSource([{ text: 'x'.repeat(LIMITS.line) }]), null);
  assert.equal(admittedSource(Array.from({ length: 40 }, () => ({ text: 'x'.repeat(1000) }))), null);
  assert.equal(validTokenLines([[{ text: '<b>', role: 'evil' }]], '<b>'), false);
  assert.equal(validTokenLines([[{ text: 'wrong', role: '' }]], 'source'), false);
  assert.equal(validTokenLines([[{ text: 'a\nb', role: '' }]], 'a\nb'), false);
  let deep = 'x'; for (let i = 0; i < 40; i++) deep = [deep];
  assert.throws(() => tokenLines(deep, 'x'));
  assert.throws(() => tokenLines(Array(17000).fill('x'), 'x'.repeat(17000)));
});

test('unknown Prism token names inherit only an allowlisted parent role', () => {
  assert.deepEqual(tokenLines([{ type: 'string', content: [{ type: 'hostile class', content: '<img>' }] }], '<img>'),
    [[{ text: '<img>', role: 'string' }]]);
});

test('worker failure and invalid output retain plain text; failures are cached', async () => {
  let calls = 0;
  const unavailable = new SyntaxHighlighter(() => { calls++; throw new Error('unavailable'); });
  assert.equal(await unavailable.highlight('javascript', 'source'), null);
  assert.equal(await unavailable.highlight('javascript', 'source'), null);
  assert.equal(calls, 1);
  const badWorker = () => {
    const worker = { terminate() {}, postMessage() { queueMicrotask(() => worker.onmessage({ data: { lines: [[{ text: 'wrong', role: '' }]] } })); } };
    queueMicrotask(() => worker.onmessage({ data: { ready: true } })); return worker;
  };
  assert.equal(await new SyntaxHighlighter(badWorker).highlight('javascript', 'source'), null);
});

test('tokenization timeout terminates the worker; next source can restart it', async () => {
  let terminated = 0, made = 0;
  const highlighter = new SyntaxHighlighter(() => {
    made++;
    const worker = { terminate() { terminated++; }, postMessage() {} };
    queueMicrotask(() => worker.onmessage({ data: { ready: true } })); return worker;
  });
  assert.equal(await highlighter.highlight('javascript', 'a'), null);
  assert.equal(terminated, 1);
  assert.equal(await highlighter.highlight('javascript', 'a'), null);
  assert.equal(made, 1);
  assert.equal(await highlighter.highlight('javascript', 'b'), null);
  assert.equal(made, 2);
});

test('stale generation, editor and selection gates prevent DOM mutation; rename paths select each side', async () => {
  const ln = { type: 'context', text: 'source' };
  let resolve, calls = [];
  const coordinator = new DiffSyntax({ highlight(language) { calls.push(language); return new Promise((r) => { resolve = r; }); } });
  const target = { isConnected: true, get textContent() { throw new Error('must not mutate'); } };
  const job = { file: { path: 'a.ts', oldPath: 'a.py' }, hunk: { lines: [ln] }, targets: [{ el: target, ln, side: 'old' }] };
  const pending = coordinator.decorate([job], () => true);
  coordinator.cancel(); resolve(highlight('source')); await pending;
  assert.deepEqual(calls, ['python']);
  const gated = coordinator.decorate([{ ...job, targets: [{ el: target, ln, side: 'new' }] }], () => false);
  resolve(highlight('source')); await gated;
  assert.deepEqual(calls, ['python', 'typescript']);
});

test('palette repairs low contrast colours and preserves readable candidates', () => {
  const fg = [240, 246, 252], bg = [[21, 27, 35], [30, 48, 36], [55, 30, 30]];
  const chosen = readableInk([60, 60, 60], fg, bg);
  assert.ok(bg.every((b) => contrast(chosen, b) >= 4.5));
  assert.deepEqual(readableInk([210, 168, 255], fg, bg), [210, 168, 255]);
  assert.deepEqual(readableInk([200, 0, 0], [120, 120, 120], [[125, 125, 125]]), [120, 120, 120]);
});

test('coordinator skips unknown and oversized source and caps admitted side jobs', async () => {
  let calls = 0;
  const coordinator = new DiffSyntax({ async highlight() { calls++; return null; } });
  const makeJob = (path, text) => {
    const ln = { type: 'add', text };
    return { file: { path }, hunk: { lines: [ln] }, targets: [{ ln, side: 'new', el: {} }] };
  };
  await coordinator.decorate([makeJob('x.unknown', 'const x = 1;'), makeJob('x.js', 'x'.repeat(LIMITS.line))], () => true);
  assert.equal(calls, 0);
  await coordinator.decorate(Array.from({ length: 150 }, () => makeJob('x.js', 'x')), () => true);
  assert.equal(calls, 128);
  calls = 0;
  const text = Array(8).fill('x'.repeat(4000)).join('\n');
  const bigJob = makeJob('x.js', text);
  bigJob.hunk.lines = text.split('\n').map((text) => ({ type: 'add', text }));
  await coordinator.decorate(Array.from({ length: 20 }, () => bigJob), () => true);
  assert.equal(calls, Math.floor(LIMITS.diff / (text.length * 2)));
});

test('source and token cache is bounded and successful entries are reused', async () => {
  let requests = 0;
  const highlighter = new SyntaxHighlighter(() => {
    const worker = {
      terminate() {},
      postMessage({ source }) {
        requests++;
        queueMicrotask(() => worker.onmessage({ data: { lines: [[{ text: source, role: '' }]] } }));
      },
    };
    queueMicrotask(() => worker.onmessage({ data: { ready: true } }));
    return worker;
  });
  await highlighter.highlight('javascript', 'a');
  await highlighter.highlight('javascript', 'a');
  assert.equal(requests, 1);
  for (let i = 0; i < 25; i++) await highlighter.highlight('javascript', String(i) + 'x'.repeat(30000));
  assert.ok(highlighter.bytes <= LIMITS.cache);
  assert.ok(highlighter.cache.size < 26);
  await highlighter.highlight('javascript', 'a');
  assert.equal(requests, 27, 'oldest cache entry was evicted');
});

test('total token segment budget bounds DOM decoration across hunks', async () => {
  let attempts = 0;
  const coordinator = new DiffSyntax({ async highlight() {
    return [Array.from({ length: LIMITS.segments }, (_, i) => ({ text: i ? '' : 'x', role: '' }))];
  } });
  const ln = { type: 'add', text: 'x' };
  const job = { file: { path: 'x.js' }, hunk: { lines: [ln] }, targets: [{
    side: 'new', ln, el: { get isConnected() { attempts++; return false; } },
  }] };
  await coordinator.decorate(Array(4).fill(job), () => true);
  assert.equal(attempts, LIMITS.renderSegments / LIMITS.segments);
});
