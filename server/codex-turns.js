import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './data-dir.js';

const MESSAGE_LIMIT = 2000;

export function turnRecordFrom(payload, now) {
  if (!payload || typeof payload !== 'object' || payload.type !== 'agent-turn-complete') return null;
  const threadId = payload['thread-id'];
  if (typeof threadId !== 'string' || !threadId) return null;
  const message = payload['last-assistant-message'];
  return {
    threadId,
    turnId: payload['turn-id'] ?? null,
    endedAt: now,
    lastAssistantMessage: typeof message === 'string' ? message.slice(0, MESSAGE_LIMIT) : '',
    cwd: payload.cwd ?? null,
  };
}

export function turnsDir(dataDir = DATA_DIR) {
  return path.join(dataDir, 'codex-turns');
}

export async function writeTurnRecord(record, dataDir = DATA_DIR) {
  const dir = turnsDir(dataDir);
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${record.threadId}.json`);
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(record));
  await fs.promises.rename(tmp, file);
}

export function readTurnRecord(threadId, dataDir = DATA_DIR) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(turnsDir(dataDir), `${threadId}.json`), 'utf8'));
    if (!record || !Number.isFinite(record.endedAt)) return null;
    return record;
  } catch {
    return null;
  }
}
