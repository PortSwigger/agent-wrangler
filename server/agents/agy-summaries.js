import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
export const agyHome = () => path.join(os.homedir(), '.gemini', 'antigravity-cli');
export function readAgySummaries({ dbPath = path.join(agyHome(), 'conversation_summaries.db') } = {}) {
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 100 });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    for (const { name } of tables) {
      if (!/^[a-z_]+$/i.test(name)) continue;
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map((r) => r.name);
      if (!['conversation_id', 'parent_conversation_id', 'nesting_depth'].every((c) => columns.includes(c))) continue;
      return db.prepare(`SELECT * FROM "${name}" LIMIT 10000`).all();
    }
  } catch { return []; } finally { db?.close(); }
  return [];
}
export const isAgyRoot = (row) => row && Object.hasOwn(row, 'parent_conversation_id') && Object.hasOwn(row, 'nesting_depth')
  && !row.parent_conversation_id && (row.nesting_depth === 0 || row.nesting_depth === '0');
