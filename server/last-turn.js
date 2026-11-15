import { findRollout } from './agents/codex-rollout.js';
import { readTurnMarks } from './agents/codex-turn-marks.js';

export async function readLastTurn(agent, liveSid, enrichment, { sessionsDir } = {}) {
  if (agent !== 'codex') return enrichment?.lastTurn ?? null;
  if (!liveSid) return null;
  const marks = await readTurnMarks(await findRollout(liveSid, sessionsDir));
  return marks.lastTurn;
}
