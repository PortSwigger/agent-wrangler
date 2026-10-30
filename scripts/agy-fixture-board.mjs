import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-agy-fixture-'));
const home = path.join(root, 'home'), data = path.join(root, 'data'), bin = path.join(root, 'bin'), workspace = path.join(root, 'workspace');
for (const dir of [home, data, bin, workspace]) fs.mkdirSync(dir, { recursive: true });
const socket = `aw-agy-fixture-${process.pid}`;
const cardId = '11111111-1111-4111-8111-111111111111', nativeId = '22222222-2222-4222-8222-222222222222';
const port = await new Promise((resolve) => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const env = { ...process.env, HOME: home, AW_DATA_DIR: data, AW_TMUX_SOCKET: socket, AW_PORT: String(port), AW_DEV: '1', AW_OPEN_BROWSER: '0', PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') };
const fake = `#!/bin/sh
case "$1 $2" in
 'models ' ) printf 'gemini-3.8-flash-low\\tGemini Flash Low\\ngemini-3.8-flash-medium\\tGemini Flash Medium\\ngemini-3.8-flash-high\\tGemini Flash High\\n' ;;
 '--version ' ) echo '1.4.10-fixture' ;;
 'plugin validate' ) echo 'fixture schema accepted (not native validation)' ;;
 'plugin install' ) mkdir -p "$HOME/.gemini/config/plugins/agent-wrangler"; cp -R "$3/." "$HOME/.gemini/config/plugins/agent-wrangler/" ;;
 'plugin uninstall' ) rm -rf "$HOME/.gemini/config/plugins/agent-wrangler" ;;
 *) echo 'Fixture binary refuses live execution' >&2; exit 97 ;;
esac
`;
fs.writeFileSync(path.join(bin, 'agy'), fake, { mode: 0o755 });
for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
const provider = path.join(home, '.gemini/antigravity-cli'); fs.mkdirSync(provider, { recursive: true });
const db = new Database(path.join(provider, 'conversation_summaries.db'));
db.exec('CREATE TABLE conversations (conversation_id TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, title TEXT, workspace_uris TEXT)');
db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?)').run(nativeId, '', 0, 'Fixture: root conversation', JSON.stringify([`file://${workspace}`])); db.close();
const logs = path.join(provider, 'brain', nativeId, '.system_generated/logs'); fs.mkdirSync(logs, { recursive: true });
const at = new Date().toISOString();
fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), [
  { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Show the fixture-backed Antigravity integration.</USER_REQUEST><ADDITIONAL_METADATA>fixture</ADDITIONAL_METADATA>', created_at: at },
  { step_index: 1, type: 'PLANNER_RESPONSE', content: 'The root conversation keeps its model, chat, searchable history and estimated API usage. Native acceptance is still pending.', model: 'gemini-3.8-flash', input_tokens: 262144, output_tokens: 12000, cache_read_tokens: 65536, created_at: at },
].map((r) => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(data, 'price-catalog.json'), JSON.stringify({ fetchedAt: at, gemini: { 'gemini-3.8-flash': { input: 1, output: 2, cacheRead: 0.1, cacheWrite5m: 0, cacheWrite1h: 0 } } }));
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ tmuxSocket: socket, manageAgyIntegration: false }));
fs.writeFileSync(path.join(data, 'mappings.json'), JSON.stringify({ [cardId]: { agent: 'agy', tmux: 'ag_fixture', socket, cwd: workspace, intent: 'Fixture-backed Antigravity integration', model: 'gemini-3.8-flash', effort: 'medium', liveSessionId: nativeId, createdAt: Date.now() } }));
const live = path.join(root, 'live'); fs.mkdirSync(live);
const pane = 'Antigravity 1.4.10 fixture\n─────────────────────────────────────────────────\n> \n─────────────────────────────────────────────────\n? for shortcuts           auto   Gemini 3.8 Flash · medium\n';
const fakeLive = path.join(live, 'fixture.mjs');
fs.writeFileSync(fakeLive, 'process.title = "agy"; process.stdout.write(' + JSON.stringify(pane) + '); setInterval(() => {}, 60000);\n');
const tmuxConfig = path.join(root, 'tmux.conf'); fs.writeFileSync(tmuxConfig, 'set-option -g remain-on-exit on\nset-option -g default-shell /bin/sh\n');
execFileSync('tmux', ['-L', socket, '-f', tmuxConfig, 'new-session', '-d', '-s', 'ag_fixture', '-c', workspace, '-x', '140', '-y', '40', `exec '${process.execPath}' '${fakeLive}'`], { env });
const log = fs.openSync(path.join(root, 'server.log'), 'w');
const server = spawn(process.execPath, ['server/index.js'], { env, stdio: ['ignore', log, log] });
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  server.kill('SIGTERM');
  try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch {}
  await new Promise((resolve) => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 3000).unref(); } });
  fs.closeSync(log); fs.rmSync(root, { recursive: true, force: true });
}
process.on('SIGTERM', () => stop().then(() => process.exit()));
process.on('SIGINT', () => stop().then(() => process.exit()));
try {
  let up = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}`)).ok) { up = true; break; } } catch {} await new Promise((r) => setTimeout(r, 250)); }
  if (!up) throw new Error('Fixture server did not start: ' + fs.readFileSync(path.join(root, 'server.log'), 'utf8'));
  const pid = Number(execFileSync('tmux', ['-L', socket, 'display-message', '-p', '-t', 'ag_fixture', '#{pane_pid}'], { encoding: 'utf8' }).trim());
  const response = await fetch(`http://127.0.0.1:${port}/agy-hook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId, parentPid: pid, conversationId: nativeId, event: 'Stop', fullyIdle: true, modelName: 'gemini-3.8-flash', stepIdx: 1 }) });
  if (!(await response.json()).accepted) throw new Error('Fixture root hook rejected: ' + execFileSync('tmux', ['-L', socket, 'capture-pane', '-p', '-t', 'ag_fixture'], { encoding: 'utf8' }));
  console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, cardId, fixture: true, pid: process.pid }));
} catch (err) { console.error(err.message); console.error(fs.readFileSync(path.join(root, 'server.log'), 'utf8')); await stop(); process.exitCode = 1; }
