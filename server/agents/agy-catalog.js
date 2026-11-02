import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const snapshot = JSON.parse(fs.readFileSync(new URL('./agy-models.snapshot.json', import.meta.url), 'utf8'));
let models = snapshot.models;
let cliVersion = null;
export function agyCliVersion() { return cliVersion; }
export function agyModels() { return models; }
export function agyEfforts(model) {
  return (models.find((m) => m.value === model)?.efforts || []).map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
}
export function parseAgyModels(tsv) {
  const byBase = new Map();
  for (const line of String(tsv).split('\n').slice(0, 500)) {
    const [slug, label] = line.split('\t');
    if (!/^[a-z0-9][a-z0-9.-]{1,100}$/.test(slug) || !label) continue;
    const match = /^(gemini-3\.8-flash|gpt-oss-120b)-(low|medium|high)$/.exec(slug);
    const base = match?.[1] || slug;
    const bundled = snapshot.models.find((m) => m.value === base);
    if (!byBase.has(base)) byBase.set(base, { ...bundled, value: base, label: bundled?.label || label.slice(0, 120), pillLabel: bundled?.pillLabel || base, efforts: [] });
    if (match && !byBase.get(base).efforts.includes(match[2])) byBase.get(base).efforts.push(match[2]);
  }
  return [...byBase.values()];
}
export function resolveAgyModel(value = 'gemini-3.8-flash', effort, catalog = models) {
  const alias = /^(gemini-3\.8-flash|gpt-oss-120b)-(low|medium|high)$/.exec(value);
  if (alias && effort) throw new Error('Effort suffix conflicts with --effort.');
  const model = alias?.[1] || value;
  const entry = catalog.find((m) => m.value === model);
  if (!entry) throw new Error(`Unknown Antigravity model: ${model}`);
  const selected = alias?.[2] || effort || entry.defaultEffort;
  if (selected && !entry.efforts.includes(selected)) throw new Error(`Unsupported effort for ${model}`);
  return { model, ...(selected ? { effort: selected } : {}) };
}
export async function refreshAgyModels({ execImpl = exec } = {}) {
  try {
    const { stdout } = await execImpl('agy', ['models'], { timeout: 5000, maxBuffer: 128 * 1024 });
    const next = parseAgyModels(stdout);
    if (!next.length) return false;
    models = next;
    try { const version = await execImpl('agy', ['--version'], { timeout: 3000, maxBuffer: 4096 }); cliVersion = /\b\d+\.\d+\.\d+\b/.exec(version.stdout)?.[0] || null; } catch {}
    return true;
  } catch { return false; }
}
