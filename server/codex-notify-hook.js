import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { turnRecordFrom, writeTurnRecord } from './codex-turns.js';
import { userNotifyArgv } from './codex-notify-config.js';

function realpathOr(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

const SELF = realpathOr(fileURLToPath(import.meta.url));

async function main() {
  const raw = process.argv.at(-1);
  try {
    const record = turnRecordFrom(JSON.parse(raw), Date.now());
    if (record) await writeTurnRecord(record);
  } catch (err) {
    console.error(`codex-notify-hook: ${err.message}`);
  }
  try {
    const argv = userNotifyArgv();
    if (!argv || !argv.length || argv.some((a) => a === SELF || realpathOr(a) === SELF)) return;
    const child = spawn(argv[0], [...argv.slice(1), raw], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch (err) {
    console.error(`codex-notify-hook: ${err.message}`);
  }
}

main().then(() => process.exit(0), () => process.exit(0));
