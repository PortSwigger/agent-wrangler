import fs from 'node:fs';
import path from 'node:path';
import { codexHome } from './codex-trust.js';

export function tomlString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function notifyOverride(nodePath, hookPath) {
  return `notify=[${tomlString(nodePath)},${tomlString(hookPath)}]`;
}

const SIMPLE_ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

function parseStringArray(text) {
  const out = [];
  let i = 0;
  const skipSpace = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] !== '#') return;
      while (i < text.length && text[i] !== '\n') i++;
    }
  };
  skipSpace();
  while (i < text.length && text[i] !== ']') {
    const quote = text[i];
    if (quote !== '"' && quote !== "'") return null;
    if (text.startsWith(quote.repeat(3), i)) return null;
    i++;
    let value = '';
    for (;;) {
      if (i >= text.length || text[i] === '\n') return null;
      const ch = text[i];
      if (ch === quote) { i++; break; }
      if (quote === '"' && ch === '\\') {
        const next = text[i + 1];
        if (next in SIMPLE_ESCAPES) {
          value += SIMPLE_ESCAPES[next];
          i += 2;
          continue;
        }
        const width = next === 'u' ? 4 : next === 'U' ? 8 : 0;
        const hex = text.slice(i + 2, i + 2 + width);
        if (!width || !new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) return null;
        try { value += String.fromCodePoint(parseInt(hex, 16)); } catch { return null; }
        i += 2 + width;
        continue;
      }
      value += ch;
      i++;
    }
    out.push(value);
    skipSpace();
    if (text[i] === ',') { i++; skipSpace(); } else if (text[i] !== ']') return null;
  }
  if (text[i] !== ']') return null;
  const rest = text.slice(i + 1).split('\n')[0].trim();
  if (rest && !rest.startsWith('#')) return null;
  return out.length ? out : null;
}

export function parseNotifyArgv(tomlText) {
  const lines = String(tomlText).split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    if (lines[n].trim().startsWith('[')) return null;
    const m = lines[n].match(/^\s*notify\s*=\s*\[(.*)$/);
    if (m) return parseStringArray([m[1], ...lines.slice(n + 1)].join('\n'));
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
