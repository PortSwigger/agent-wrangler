import fs from 'node:fs';
import path from 'node:path';
import { codexHome } from './codex-trust.js';

export function tomlString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function notifyOverride(nodePath, hookPath) {
  return `notify=[${tomlString(nodePath)},${tomlString(hookPath)}]`;
}

function parseBasicStrings(inner) {
  const out = [];
  let i = 0;
  const skipSpace = () => { while (i < inner.length && /\s/.test(inner[i])) i++; };
  skipSpace();
  while (i < inner.length) {
    if (inner[i] !== '"') return null;
    i++;
    let value = '';
    for (;;) {
      if (i >= inner.length) return null;
      const ch = inner[i];
      if (ch === '"') { i++; break; }
      if (ch === '\\') {
        const next = inner[i + 1];
        if (next !== '"' && next !== '\\') return null;
        value += next;
        i += 2;
        continue;
      }
      value += ch;
      i++;
    }
    out.push(value);
    skipSpace();
    if (i >= inner.length) break;
    if (inner[i] !== ',') return null;
    i++;
    skipSpace();
  }
  return out.length ? out : null;
}

export function parseNotifyArgv(tomlText) {
  for (const line of String(tomlText).split(/\r?\n/)) {
    if (line.trim().startsWith('[')) return null;
    const m = line.match(/^\s*notify\s*=\s*\[(.*)\]\s*(#.*)?$/);
    if (m) return parseBasicStrings(m[1]);
  }
  return null;
}

export function userNotifyArgv(configPath = path.join(codexHome(), 'config.toml')) {
  try {
    return parseNotifyArgv(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}
