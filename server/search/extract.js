import { adapterFor } from '../agents/index.js';
export { extractClaudeLine, extractCodexLine } from '../agents/search-formats.js';

export function mightCarryText(line, agent) {
  return adapterFor(agent).history.mightCarryText(line);
}

export function extractLine(line, agent, resolve = adapterFor) {
  return resolve(agent).history.extractLine(line);
}
