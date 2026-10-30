import { worktreeGuardrailPrompt } from './worktree.js';
import { codexSkillCatalog, mandatorySkillPrompt } from './agent-skills.js';
import { readAgySummaries, isAgyRoot } from './agents/agy-summaries.js';
import { saveAgyLineage } from './agents/agy-history.js';
const events = new Set(['SessionStart', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop']);
const liveByPid = new Map();
export function agyHookResponse(event, payload, { env = process.env, tools = [] } = {}) {
  if (!env.AW_SESSION_ID) return null;
  if (event === 'PreToolUse') {
    const call = payload.toolCall;
    if (call && (!call.serverName || call.serverName === 'agent-wrangler')
      && tools.some((name) => call.name === `mcp__agent-wrangler__${name}`)) return { decision: 'auto_approve' };
  }
  if (event === 'SessionStart') {
    let disabledSkills = []; try { disabledSkills = JSON.parse(env.AW_AGY_DISABLED_SKILLS || '[]'); } catch {}
    let worktree; try { worktree = JSON.parse(env.AW_AGY_WORKTREE || 'null'); } catch {}
    const prompt = [
      worktree ? worktreeGuardrailPrompt(worktree) : '',
      `Name this card using rename_session with target ${env.AW_SESSION_ID}, a concise task name, and only_if_unnamed: true.`,
      `This is Agent Wrangler card ${env.AW_SESSION_ID}. Use the agent-wrangler MCP tools read_mail, send_message, spawn_session and rename_session explicitly; tools may load on demand. Use Wrangler tools for orchestration.`,
      `Run shell commands in ${env.AW_CWD || 'the card workspace'} explicitly. Git metadata grants can change agy's default cwd. For git, network, localhost and package commands denied by the sandbox, retry with BypassSandbox: true and allow agy's normal reviewer to decide. Do not widen permissions.`,
      mandatorySkillPrompt(undefined, { disabledSkills }), codexSkillCatalog(undefined, { disabledSkills }),
    ].filter(Boolean).join('\n\n');
    return { injectSteps: [{ ephemeralMessage: prompt }] };
  }
  return null;
}
export async function acceptAgyHook(payload, { map, rootPid, summaries = readAgySummaries, save = () => {}, onIdentity = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!payload || !events.has(payload.event) || !Number.isSafeInteger(payload.parentPid) || payload.parentPid <= 0) return false;
  const entry = map.get(payload.cardId);
  if (entry?.agent !== 'agy' || !entry.tmux || payload.parentPid !== Number(await rootPid(entry))) return false;
  onIdentity();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(payload.conversationId || '')) return false;
  let row;
  for (let n = 0; n < 3; n++) {
    row = (await summaries()).find((r) => r.conversation_id === payload.conversationId);
    if (row) break;
    if (n < 2) await sleep(50);
  }
  if (!row) return false;
  if (!isAgyRoot(row)) {
    if (row.parent_conversation_id !== entry.liveSessionId || !(Number(row.nesting_depth) > 0)) return false;
    entry.agyChildIds = [...new Set([...(entry.agyChildIds || []), row.conversation_id])];
    save(); return true;
  }
  for (const [cardId, other] of map) if (cardId !== payload.cardId && other.agent === 'agy' && other.liveSessionId === payload.conversationId) return false;
  if (entry.agyForkPending && payload.conversationId === entry.agyForkPending.parentId) return false;
  if (entry.agyForkPending) {
    await saveAgyLineage(payload.conversationId, entry.agyForkPending);
    entry.agyFork = entry.agyForkPending;
    if (entry.agyLaunchWarning?.startsWith('Fork identity')) delete entry.agyLaunchWarning;
    delete entry.agyForkPending;
  }
  if (entry.liveSessionId && entry.liveSessionId !== payload.conversationId) entry.priorLiveSessionIds = [...new Set([...(entry.priorLiveSessionIds || []), entry.liveSessionId])];
  entry.liveSessionId = payload.conversationId;
  const idle = payload.event === 'Stop' && payload.fullyIdle === true;
  const previous = entry.agyLive || {};
  entry.agyLive = {
    liveSid: payload.conversationId, status: idle ? 'idle' : 'working',
    model: typeof payload.modelName === 'string' ? payload.modelName.slice(0, 128) : previous.model,
    stepIdx: Number.isSafeInteger(payload.stepIdx) ? payload.stepIdx : previous.stepIdx,
    pendingTool: payload.event === 'PreToolUse' ? true : payload.event === 'PostToolUse' || idle ? false : previous.pendingTool,
    at: Date.now(), updatedAt: Date.now(), parentPid: payload.parentPid,
  };
  liveByPid.set(payload.parentPid, entry.agyLive);
  save(); return true;
}
export function readAgyLive({ pid, entry }) {
  if (entry?.agyLaunchWarning) return { liveSid: entry.liveSessionId, status: 'needs-you', waitingFor: entry.agyLaunchWarning };
  return liveByPid.get(Number(pid)) || (entry?.agyLive?.parentPid === Number(pid) ? entry.agyLive : null);
}
