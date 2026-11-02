import { adapterFor } from './agents/index.js';
export { MAX_TOOL_TEXT, MAX_TRACKED_LINES, recapOf, lineUuids } from './agents/chat-scanner.js';

export function createChatScanner(agent, resolve = adapterFor) {
  return resolve(agent).history.createScanner();
}

export function mightCarryChat(line, agent) {
  return adapterFor(agent).history.mightCarryChat(line);
}

export function scanChatText(text, agent) {
  const scanner = createChatScanner(agent);
  const tagged = text.split('\n').map((line) => scanner.pushTagged(line));
  return { events: scanner.selectLive(tagged), pending: scanner.pending() };
}
