import fsp from 'node:fs/promises';
import { z } from 'zod';
import { adapterFor } from '../../agents/index.js';
import { createChatScanner, scanChatText } from '../../chat-events.js';
import { forEachRolloutLine } from '../../agents/codex-rollout.js';
import { sessionLabel } from '../../state-reader.js';

const HEAD_MESSAGES = 5;
const TAIL_MESSAGES = 5;
// A message over MAX_WORDS keeps its first and last EDGE_WORDS.
const MAX_WORDS = 300;
const EDGE_WORDS = 120;

// Slices on word offsets rather than re-joining words, so code blocks and line
// breaks in the kept parts survive intact.
export function clipText(text) {
  const words = [...text.matchAll(/\S+/g)];
  if (words.length <= MAX_WORDS) return text;
  const headEnd = words[EDGE_WORDS - 1].index + words[EDGE_WORDS - 1][0].length;
  const tailStart = words[words.length - EDGE_WORDS].index;
  const omitted = words.length - 2 * EDGE_WORDS;
  return `${text.slice(0, headEnd)}\n…[${omitted} words omitted]…\n${text.slice(tailStart)}`;
}

// The same user/assistant turns the chat view renders (rewound branches,
// harness wrappers and tool calls already dropped), clipped to the first and
// last few with long messages cut down to their start and end.
export function summariseTranscript(text, agent) {
  const turns = scanChatText(text, agent).events
    .filter((e) => (e.kind === 'user' || e.kind === 'assistant') && e.text)
    .map((e) => ({
      role: e.kind,
      ts: e.ts ? new Date(e.ts).toISOString() : null,
      text: clipText(e.text),
    }));
  const total = turns.length;
  if (total <= HEAD_MESSAGES + TAIL_MESSAGES) return { total, omitted: 0, messages: turns };
  return {
    total,
    omitted: total - HEAD_MESSAGES - TAIL_MESSAGES,
    messages: [...turns.slice(0, HEAD_MESSAGES), ...turns.slice(-TAIL_MESSAGES)],
  };
}

async function summariseCodexRollout(file) {
  const scanner = createChatScanner('codex');
  const head = [];
  const tail = [];
  let total = 0;
  await forEachRolloutLine(file, (line) => {
    for (const event of scanner.push(line)) {
      if (event.kind !== 'user' && event.kind !== 'assistant' || !event.text) continue;
      const turn = {
        role: event.kind,
        ts: event.ts ? new Date(event.ts).toISOString() : null,
        text: clipText(event.text),
      };
      total += 1;
      if (head.length < HEAD_MESSAGES) head.push(turn);
      else {
        tail.push(turn);
        if (tail.length > TAIL_MESSAGES) tail.shift();
      }
    }
  });
  if (total <= HEAD_MESSAGES + TAIL_MESSAGES) return { total, omitted: 0, messages: [...head, ...tail] };
  return {
    total,
    omitted: total - HEAD_MESSAGES - TAIL_MESSAGES,
    messages: [...head, ...tail],
  };
}

export const readSessionTranscriptTool = {
  name: 'read_session_transcript',
  description:
    'Read a condensed view of another Agent Wrangler session\'s conversation (live, suspended or '
    + 'archived; Claude or Codex) — e.g. when the user points you at a session for context. Returns '
    + `only user/assistant text (no tool calls): the first ${HEAD_MESSAGES} and last ${TAIL_MESSAGES} `
    + `messages, with any message over ${MAX_WORDS} words cut to its start and end. Also returns `
    + '`transcriptPath`, the raw .jsonl on disk — read that file directly if you need the full '
    + 'conversation. Covers the session\'s current conversation; earlier ones it /clear-ed away are '
    + 'listed under `earlierTranscriptPaths`. Get session ids from list_sessions or '
    + 'get_session_activity. Read-only.',
  inputSchema: {
    sessionId: z.string().min(1).describe('The board session id (from list_sessions or get_session_activity).'),
  },
  async handler({ deps }, args = {}) {
    const entry = deps.sessionManager.entryFor(args.sessionId);
    if (!entry) return errorResult(`No session with id ${args.sessionId}.`);
    const agent = entry.agent || 'claude';
    const adapter = adapterFor(agent);
    const dir = agent === 'codex' ? deps.codexSessionsDir : deps.projectsDir;

    const transcriptPath = await adapter.transcriptPath(entry.liveSessionId || entry.sessionId, dir);
    if (!transcriptPath) return errorResult(`Session ${args.sessionId} has no transcript on disk yet.`);
    const earlierTranscriptPaths = [];
    for (const id of entry.priorLiveSessionIds || []) {
      const p = await adapter.transcriptPath(id, dir);
      if (p) earlierTranscriptPaths.push(p);
    }

    try {
      const summary = agent === 'codex'
        ? await summariseCodexRollout(transcriptPath)
        : summariseTranscript(await fsp.readFile(transcriptPath, 'utf8'), agent);
      const { total, omitted, messages } = summary;
      return transcriptResult({ args, entry, agent, transcriptPath, earlierTranscriptPaths, total, omitted, messages });
    } catch (err) {
      return errorResult(`Could not read ${transcriptPath}: ${err.message}`);
    }
  },
};

function transcriptResult({ args, entry, agent, transcriptPath, earlierTranscriptPaths, total, omitted, messages }) {
  const structuredContent = {
    sessionId: args.sessionId,
    label: sessionLabel({ agent, names: [entry.name, entry.lastLabel], intent: entry.intent, cwd: entry.cwd, fallback: args.sessionId.slice(0, 8) }) || null,
    agent,
    cwd: entry.cwd ?? null,
    archived: Boolean(entry.archivedAt),
    totalMessages: total,
    omittedMessages: omitted,
    messages,
    transcriptPath,
    earlierTranscriptPaths,
    note: `This is a condensed view. If you need the full transcript, read ${transcriptPath}.`,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
