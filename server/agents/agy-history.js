import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../data-dir.js';
import { agyHome, readAgySummaries, isAgyRoot } from './agy-summaries.js';
import { writeJsonAtomic } from '../atomic-json.js';
import { agyCostUsd, agyStepTokens } from './agy-usage.js';
const safeId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const cacheDir = path.join(DATA_DIR, 'agy-history');
const lineages = path.join(DATA_DIR, 'agy-lineage.json');
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
export async function freezeAgyFork(id, parentId, forkStep, options) {
  if (!safeId(id) || !safeId(parentId) || !Number.isSafeInteger(forkStep)) throw new Error('Invalid fork');
  const prefix = (await stitched(parentId, options)).filter((r) => r.step_index <= forkStep);
  if (!prefix.length) throw new Error('Antigravity fork history is missing.');
  const prefixFile = path.join(DATA_DIR, 'agy-forks', `${id}.json`);
  writeJsonAtomic(prefixFile, prefix);
  return { parentId, forkStep, prefixFile };
}
export async function saveAgyLineage(id, lineage, options) {
  if (!safeId(id) || !safeId(lineage.parentId) || !Number.isSafeInteger(lineage.forkStep) || lineage.forkStep < 0) throw new Error('Invalid Antigravity fork lineage');
  const frozen = lineage.prefixFile ? lineage : await freezeAgyFork(id, lineage.parentId, lineage.forkStep, options);
  writeJsonAtomic(lineages, { ...readJson(lineages, {}), [id]: frozen });
}
export function stripAgyWrappers(value) {
  if (typeof value !== 'string') return '';
  const match = /^\s*<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(value);
  return match ? match[1] : value;
}
export function parseAgySteps(text) {
  const steps = [];
  for (const line of text.split('\n')) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (!Number.isSafeInteger(row.step_index) || row.step_index < 0 || typeof row.type !== 'string') continue;
    while (steps.length && steps.at(-1).step_index >= row.step_index) steps.pop();
    steps.push({ ...row, content: row.type === 'USER_INPUT' ? stripAgyWrappers(row.content) : (typeof row.content === 'string' ? row.content : '') });
  }
  return steps;
}
export async function readAgySteps(id, { brainDir = path.join(agyHome(), 'brain') } = {}) {
  if (!safeId(id)) return [];
  const logs = path.join(brainDir, id, '.system_generated', 'logs');
  let text;
  try { text = await fsp.readFile(path.join(logs, 'transcript_full.jsonl'), 'utf8'); }
  catch {
    try {
      const chunks = path.join(logs, 'chunks', 'transcript_full');
      const files = (await fsp.readdir(chunks)).filter((f) => /^\d+\.jsonl$/.test(f)).sort();
      if (files.length) text = (await Promise.all(files.map((f) => fsp.readFile(path.join(chunks, f), 'utf8')))).join('\n');
    } catch {}
  }
  const retained = path.join(cacheDir, `${id}.raw.json`);
  if (text === undefined) return readJson(retained, []);
  const rows = parseAgySteps(text);
  if (rows.length) writeJsonAtomic(retained, rows);
  return rows;
}
async function stitched(id, options, seen = new Set()) {
  if (seen.has(id) || seen.size > 32) return [];
  seen.add(id);
  const own = await readAgySteps(id, options);
  const lineage = readJson(lineages, {})[id];
  if (!lineage) return own;
  const parent = lineage.prefixFile ? readJson(lineage.prefixFile, []) : (await stitched(lineage.parentId, options, seen)).filter((r) => r.step_index <= lineage.forkStep);
  return [...parent, ...own];
}
export async function agyTranscriptPath(id, options) {
  if (!safeId(id)) return null;
  const steps = await stitched(id, options);
  if (!steps.length) return null;
  const file = path.join(cacheDir, `${id}.jsonl`);
  const body = steps.map((r) => JSON.stringify(r)).join('\n') + '\n';
  let old; try { old = await fsp.readFile(file, 'utf8'); } catch {}
  if (old !== body) { await fsp.mkdir(cacheDir, { recursive: true }); await fsp.writeFile(file, body); }
  return file;
}
function eventsFor(row) {
  const ts = Date.parse(row.created_at) || null;
  const model = row.model || row.model_name || row.modelName || null;
  if (row.type === 'USER_INPUT') return row.content ? [{ kind: 'user', text: stripAgyWrappers(row.content), ts }] : [];
  if (row.type === 'PLANNER_RESPONSE') {
    const events = [];
    if (row.thinking) events.push({ kind: 'thinking', text: typeof row.thinking === 'string' ? row.thinking : '', ts });
    if (row.content) events.push({ kind: 'assistant', text: row.content, model, ts });
    for (const call of row.tool_calls || []) events.push({ kind: 'tool', name: call.name || 'tool', target: JSON.stringify(call.arguments || call.input || {}).slice(0, 2000), ts });
    return events;
  }
  if (row.type === 'GENERIC' && row.content) return [{ kind: 'tool', name: row.tool_name || 'tool result', target: row.content.slice(0, 2000), ts }];
  if (row.type === 'ERROR_MESSAGE') return [{ kind: 'notice', noticeKind: 'error', text: row.content || String(row.error || ''), ts }];
  return [];
}
function scanner() {
  let sequence = 0, rewound = false, lastStep = -1, lastTimestamp = null;
  const live = new Map();
  return {
    pushTagged(line) {
      let row; try { row = JSON.parse(line); } catch { return { events: [] }; }
      if (!Number.isSafeInteger(row.step_index)) return { events: [] };
      if (row.step_index <= lastStep) {
        for (const [key, step] of live) if (step >= row.step_index) live.delete(key);
        rewound = true;
      }
      lastStep = row.step_index;
      lastTimestamp = Date.parse(row.created_at) || lastTimestamp;
      const uuid = String(sequence++); live.set(uuid, row.step_index);
      return { uuid, events: eventsFor(row) };
    },
    push(line) { return this.pushTagged(line).events; },
    selectLive(tagged) { return tagged.filter((t) => !t.uuid || live.has(t.uuid)).flatMap((t) => t.events); },
    pending: () => null,
    lastTs: () => lastTimestamp,
    takeRewound() { const value = rewound; rewound = false; return value; },
  };
}
export const agyHistory = {
  continuations: true, mutable: true,
  resolveResumeDir: async (_id, { graphCwd, entryCwd } = {}) => graphCwd || entryCwd || null,
  directory: ({ brainDir } = {}) => brainDir,
  findFile: agyTranscriptPath,
  async findFiles(id, options) { const file = await agyTranscriptPath(id, options); return file ? [file] : []; },
  async forEachLine(file, fn) { for (const line of (await fsp.readFile(file, 'utf8')).split('\n')) if (line && fn(line) === false) break; },
  createScanner: scanner,
  mightCarryChat: (line) => /USER_INPUT|PLANNER_RESPONSE|GENERIC|ERROR_MESSAGE/.test(line),
  mightCarryText: (line) => /USER_INPUT|PLANNER_RESPONSE/.test(line),
  extractLine(line) {
    let row; try { row = JSON.parse(line); } catch { return null; }
    const event = eventsFor(row).find((e) => ['user', 'assistant'].includes(e.kind));
    return event ? { record: { role: event.kind === 'user' ? 0 : 1, text: event.text, tsSec: Math.floor((event.ts || 0) / 1000) } } : null;
  },
  async discoverSources(options = {}) {
    const rows = readAgySummaries(options).filter(isAgyRoot);
    const out = [];
    for (const row of rows) {
      const file = await agyTranscriptPath(row.conversation_id, options);
      if (file) out.push({ file, agent: 'agy', id: row.conversation_id });
    }
    return out;
  },
};
export async function analyzeAgy(id, options = {}) {
  const rows = await readAgySteps(id, options);
  const summaries = readAgySummaries(options);
  const familyIds = new Set([id]);
  for (let i = 0; i < summaries.length; i++) for (const row of summaries) if (familyIds.has(row.parent_conversation_id)) familyIds.add(row.conversation_id);
  const children = summaries.filter((r) => r.conversation_id !== id && familyIds.has(r.conversation_id));
  const totals = {}, tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const all = [...rows];
  const subAgents = [];
  for (const child of children) {
    const steps = await readAgySteps(child.conversation_id, options);
    all.push(...steps);
    const childTotals = {};
    for (const step of steps) if (step.type === 'PLANNER_RESPONSE') {
      const key = step.model || step.model_name || step.modelName || 'unknown';
      const bag = childTotals[key] ||= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: [] };
      bag.requests.push(agyStepTokens(step));
      for (const [token, n] of Object.entries(agyStepTokens(step))) bag[token] += n;
    }
    subAgents.push({ id: child.conversation_id, agentType: child.agent_name || 'subagent', label: child.title || child.agent_name || child.conversation_id, kind: 'background', status: child.status === 'not_fully_idle' ? 'running' : 'completed', startedAt: Date.parse(steps[0]?.created_at) || null, endedAt: Date.parse(steps.at(-1)?.created_at) || null, usd: agyCostUsd(childTotals), estimated: true });
  }
  for (const row of all) {
    if (row.type !== 'PLANNER_RESPONSE') continue;
    const model = row.model || row.model_name || row.modelName || 'unknown';
    const t = totals[model] ||= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, requests: [] };
    t.requests.push(agyStepTokens(row));
    const count = (v) => Number.isFinite(v) && v >= 0 ? v : 0;
    const read = count(row.cache_read_tokens);
    t.input += Math.max(0, count(row.input_tokens) - read); t.output += count(row.output_tokens); t.cacheRead += read;
  }
  for (const t of Object.values(totals)) for (const k of Object.keys(tokens)) tokens[k] += t[k] || 0;
  for (const priorId of options.entry?.priorLiveSessionIds || []) {
    if (priorId === id) continue;
    const prior = await analyzeAgy(priorId, { ...options, entry: undefined });
    for (const [model, t] of Object.entries(prior.totals)) {
      const bag = totals[model] ||= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, requests: [] };
      bag.requests.push(...(t.requests || []));
      for (const k of Object.keys(tokens)) { bag[k] += t[k] || 0; tokens[k] += t[k] || 0; }
    }
  }
  const latest = rows.findLast((r) => r.type === 'PLANNER_RESPONSE');
  const model = latest?.model || latest?.model_name || latest?.modelName || null;
  const contextPercent = model?.startsWith('gemini-3.8-flash') && Number.isFinite(latest.input_tokens) ? latest.input_tokens / 1048576 * 100 : null;
  const summary = rows.find((r) => r.type === 'USER_INPUT')?.content || null;
  return { usd: agyCostUsd(totals), tokens, totals, estimated: true, model, currentModel: model, contextPercent, summary, aiTitle: summaries.find((r) => r.conversation_id === id)?.title || null, lastActivity: Date.parse(rows.at(-1)?.created_at) || null, startedAt: Date.parse(rows[0]?.created_at) || null, subAgents, hasTranscript: rows.length > 0 };
}
export async function listResumableAgy(excludeIds = new Set(), options = {}) {
  const rows = readAgySummaries(options).filter((r) => isAgyRoot(r) && !excludeIds.has(r.conversation_id));
  const candidates = rows.map((r) => ({ sessionId: r.conversation_id, agent: 'agy', summary: r.title || r.preview || '', cwd: workspaceOf(r), lastActivity: Date.parse(r.updated_at || r.created_at) || 0 }));
  return { candidates, total: candidates.length, windowDays: options.windowDays || 30 };
}
function workspaceOf(row) {
  try { const paths = JSON.parse(row.workspace_uris || row.workspace_paths || '[]'); return decodeURIComponent(String(paths[0] || '').replace(/^file:\/\//, '')); } catch { return ''; }
}
export async function activityInRangeAgy(id, startMs, endMs, options) {
  const rows = (await readAgySteps(id, typeof options === 'object' ? options : {})).filter((r) => { const t = Date.parse(r.created_at); return t >= startMs && t < endMs; });
  return { messageCount: rows.filter((r) => r.type === 'USER_INPUT' || r.type === 'PLANNER_RESPONSE').length, firstActivity: Date.parse(rows[0]?.created_at) || null, lastActivity: Date.parse(rows.at(-1)?.created_at) || null };
}

export async function agySubagentDetail(rootId, childId, options) {
  const rows = readAgySummaries(options);
  let row = rows.find((r) => r.conversation_id === childId);
  const seen = new Set();
  while (row?.parent_conversation_id && row.parent_conversation_id !== rootId && !seen.has(row.conversation_id)) {
    seen.add(row.conversation_id);
    row = rows.find((r) => r.conversation_id === row.parent_conversation_id);
  }
  if (row?.parent_conversation_id !== rootId) return { prompt: null, toolCalls: null, result: null };
  const steps = await readAgySteps(childId, options);
  return {
    prompt: steps.find((r) => r.type === 'USER_INPUT')?.content || null,
    result: steps.findLast((r) => r.type === 'PLANNER_RESPONSE')?.content || null,
    toolCalls: steps.flatMap((r) => (r.tool_calls || []).map((call) => ({ name: call.name || 'tool', target: JSON.stringify(call.arguments || call.input || {}).slice(0, 2000) }))),
  };
}
