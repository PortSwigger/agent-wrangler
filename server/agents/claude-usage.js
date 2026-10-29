import path from 'node:path';
import { costUsd } from '../pricing.js';

export async function scanDaily({ cardId, entry, task, index, projectsDir, seenClaudeFiles, claudeDailyCached, normalizeClaudeDays, resolveClaudeTranscripts, usageSince, maybeYield, raw }) {
  let failedFiles = 0;
  // One row per transcript the card has owned (a `/clear` leaves earlier ones
  // behind), each attributed to the same task — rollup sums rows, so the card's
  // spend stays whole across a swap and every file stays in seenClaudeFiles.
  for (const file of resolveClaudeTranscripts(cardId, entry, index, projectsDir)) {
    seenClaudeFiles.add(file);
    const cd = await claudeDailyCached(file, usageSince(entry));
    await maybeYield();
    if (cd.failed) failedFiles += 1;
    const days = normalizeClaudeDays(cd);
    if (!Object.keys(days).length) continue;
    const uuid = path.basename(file, '.jsonl');
    const owner = entry.liveSessionId === uuid || cardId === uuid;
    raw.push({ file, cardId, owner, task, days });
  }

  return failedFiles;
}

export async function scanMonth({ cardId, entry, agent, label, sessions, resolveClaudeTranscripts, monthTotalsFor, usageSince, tokensOf, taskNameFor }) {
  const files = resolveClaudeTranscripts(cardId, entry);
  if (!files.length) { return 1; }
  // One row per conversation the card has owned, so a cleared-away conversation's
  // spend still lands under the same card and task.
  for (const file of files) {
    const { totals, subAgentUsd, advisorUsd } = await monthTotalsFor(file, usageSince(entry));
    const usd = costUsd(totals);
    const tokens = tokensOf(totals);
    if (tokens.total === 0) continue; // no activity this month (parent or sub-agents)
    const uuid = path.basename(file, '.jsonl');
    const owner = entry.liveSessionId === uuid || cardId === uuid; // true conversation owner vs a re-pointed resume
    sessions.push({ cardId, agent, label, task: taskNameFor(cardId), totals, usd, subAgentUsd, advisorUsd, tokens, estimated: false, file, owner });
  }

  return 0;
}
