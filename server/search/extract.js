import { ROLE_USER, ROLE_ASSISTANT } from './records.js';

// One transcript line in → the conversation text worth searching, or null.
//
// This is where the "a lot of text" problem is actually solved: the on-disk
// transcripts are ~350 MB of JSON, but the conversation inside them — what you
// typed and what the agent said back — is a small fraction of that. Everything
// else (tool results, file-history snapshots, attachment blobs, token counts,
// reasoning traces) is dropped here, once, at index time. Query time never sees
// JSON at all.
//
// Deliberately excluded, and why:
//   • tool_result / function_call_output — command output, not conversation, and
//     by far the bulk of the bytes. Searching it would mostly surface build logs.
//   • thinking / reasoning — the agent's scratchpad, not its response.
//   • system, attachment, file-history-*, token_count — machinery.
//   • synthetic user turns (<environment_context>, isMeta) — injected, never typed.

// A cheap substring gate applied before JSON.parse. Parsing every line of every
// transcript is the single most expensive part of a build, and the majority of
// lines can't possibly contribute — one indexOf over the raw line is ~100× cheaper
// than parsing it to find that out.
export function mightCarryText(line, agent) {
  if (agent === 'codex') return line.includes('"type":"message"');
  return line.includes('"role":"user"') || line.includes('"role":"assistant"');
}

function tsSecOf(iso) {
  if (typeof iso !== 'string') return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

// Claude message.content is either a bare string (a typed prompt) or a block
// array. Only `text` blocks are conversation; a user line whose blocks are all
// tool_result is a tool round-trip wearing the user role.
function claudeText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

// Codex content blocks: input_text (user) / output_text (assistant).
function codexText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b) continue;
    if ((b.type === 'input_text' || b.type === 'output_text' || b.type === 'text') && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.join('\n');
}

// Turns injected into the user role by the harness rather than typed by a human.
// Codex opens every session with an <environment_context> block and re-injects
// <user_instructions>; Claude marks its equivalents isMeta.
const SYNTHETIC_PREFIXES = ['<environment_context>', '<user_instructions>', '<environment_details>'];
function isSynthetic(text) {
  const head = text.slice(0, 40).trimStart();
  return SYNTHETIC_PREFIXES.some((p) => head.startsWith(p));
}

// Both extractors return { record?, meta? }:
//   record — { role, text, tsSec } to index
//   meta   — document-level facts learned from this line (session id, cwd, title),
//            merged into the doc entry as they're seen
export function extractClaudeLine(entry) {
  const meta = {};
  if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') meta.title = entry.aiTitle;
  if (typeof entry.cwd === 'string' && entry.cwd) meta.cwd = entry.cwd;
  if (typeof entry.sessionId === 'string' && entry.sessionId) meta.id = entry.sessionId;
  if (typeof entry.gitBranch === 'string' && entry.gitBranch) meta.branch = entry.gitBranch;

  const msg = entry.message;
  if (!msg || typeof msg !== 'object' || entry.isMeta) return { meta };
  const role = msg.role === 'user' ? ROLE_USER : msg.role === 'assistant' ? ROLE_ASSISTANT : null;
  if (role === null) return { meta };
  const text = claudeText(msg.content).trim();
  if (!text) return { meta };
  if (role === ROLE_USER && isSynthetic(text)) return { meta };
  return { meta, record: { role, text, tsSec: tsSecOf(entry.timestamp) } };
}

export function extractCodexLine(entry) {
  const meta = {};
  const p = entry.payload && typeof entry.payload === 'object' ? entry.payload : entry;
  if (entry.type === 'session_meta') {
    if (typeof p.id === 'string') meta.id = p.id;
    if (typeof p.cwd === 'string') meta.cwd = p.cwd;
    if (p.git && typeof p.git.branch === 'string') meta.branch = p.git.branch;
    return { meta };
  }
  // response_item/message carries BOTH sides; the parallel event_msg stream
  // (user_message / agent_message) repeats the same text, so indexing only
  // response_item keeps every message exactly once.
  if (entry.type !== 'response_item' || p.type !== 'message') return { meta };
  const role = p.role === 'user' ? ROLE_USER : p.role === 'assistant' ? ROLE_ASSISTANT : null;
  if (role === null) return { meta };
  const text = codexText(p.content).trim();
  if (!text) return { meta };
  if (role === ROLE_USER && isSynthetic(text)) return { meta };
  return { meta, record: { role, text, tsSec: tsSecOf(entry.timestamp) } };
}

// Parse + extract one raw line. Returns null for anything unparseable — a
// half-written trailing line is normal for a live session, not an error.
export function extractLine(line, agent) {
  if (!line || !mightCarryText(line, agent)) {
    // Doc metadata (title, cwd, session id) lives on lines the text gate rejects,
    // so those still need a parse — but only the few line kinds that carry it.
    if (!line || !metaGate(line, agent)) return null;
  }
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  return agent === 'codex' ? extractCodexLine(entry) : extractClaudeLine(entry);
}

// The second cheap gate: lines that carry no conversation text but do carry
// document metadata worth keeping.
function metaGate(line, agent) {
  if (agent === 'codex') return line.includes('"session_meta"');
  return line.includes('"ai-title"');
}
