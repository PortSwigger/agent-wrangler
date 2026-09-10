import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelTableMarkdown } from './agents/index.js';

// The spawn-session skill's model table is GENERATED from the adapters, not
// hand-copied — the copy that used to live there had already drifted (it was
// missing `opusplan`). It exists at all, rather than the skill just pointing at
// the tool schema, because schema descriptions are not equally readable to every
// agent: measured in a real Codex session, they are absent from its initial tool
// catalog. Rendering and marker-splicing live here (not in the script) so the
// drift test can call exactly what the generator calls.
export const SKILL_PATH = fileURLToPath(
  new URL('../agent-skills/skills/spawn-session/SKILL.md', import.meta.url),
);

export const BEGIN = '<!-- BEGIN GENERATED MODELS — edit server/agents/*.js then run `npm run gen:models` -->';
export const END = '<!-- END GENERATED MODELS -->';

// Replace whatever sits between the markers with the current table. Throws if the
// markers are missing rather than guessing where the block belongs — a silent
// no-op here would let the skill rot with the test still passing.
export function skillModelBlock(text) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`spawn-session SKILL.md is missing the generated-model markers (${BEGIN})`);
  }
  return `${text.slice(0, start)}${BEGIN}\n\n${modelTableMarkdown()}\n\n${text.slice(end)}`;
}
