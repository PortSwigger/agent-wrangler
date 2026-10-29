import { adapterFor } from './agents/index.js';

export function findConversationFile(convId, agent, options = {}) {
  return (options.resolveAdapter || adapterFor)(agent).history.findFile(convId, options);
}

export function findConversationFiles(convId, agent, options = {}) {
  return (options.resolveAdapter || adapterFor)(agent).history.findFiles(convId, options);
}
