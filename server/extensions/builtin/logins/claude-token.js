import fs from 'node:fs';
import path from 'node:path';

export const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;
export function extractToken(text) { return String(text).match(TOKEN_RE)?.[0] || null; }
export function shellQuote(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }
export function captureCommand({ loginDir, claudeBin = 'claude' }) {
  return `CLAUDE_CONFIG_DIR=${shellQuote(path.join(loginDir, 'claude-scratch'))} ${shellQuote(claudeBin)} setup-token 2>&1 | tee ${shellQuote(path.join(loginDir, 'claude-capture.txt'))}`;
}

export function watchCapture({ loginDir, onToken, onError = () => {}, intervalMs = 1000, timeoutMs = 10 * 60 * 1000 }) {
  const capture = path.join(loginDir, 'claude-capture.txt');
  const deadline = Date.now() + timeoutMs;
  let stopped = false;
  let timer;
  const cleanup = () => {
    fs.rmSync(capture, { force: true });
    fs.rmSync(path.join(loginDir, 'claude-scratch'), { recursive: true, force: true });
  };
  const stop = () => { stopped = true; clearTimeout(timer); };
  const poll = async () => {
    if (stopped) return;
    try {
      const text = await fs.promises.readFile(capture, 'utf8').catch((err) => { if (err.code === 'ENOENT') return ''; throw err; });
      if (stopped) return;
      const token = extractToken(text);
      if (token) {
        stop();
        cleanup();
        await onToken(token);
        return;
      }
      if (Date.now() >= deadline) { stop(); cleanup(); return; }
    } catch {
      stop();
      onError(new Error('Claude token capture failed; try Paste token'));
      return;
    }
    timer = setTimeout(poll, intervalMs);
    timer.unref?.();
  };
  timer = setTimeout(poll, intervalMs);
  timer.unref?.();
  return stop;
}
