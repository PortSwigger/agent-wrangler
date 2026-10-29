import { findRollout, findRolloutChain, firstSessionId, forEachRolloutLine } from './codex-rollout.js';
import { createNativeChatScanner, mightCarryChat } from './chat-scanner.js';
import { extractNativeLine, mightCarryText } from './search-formats.js';
import { codexSources } from './history-sources.js';

export const codexHistory = {
  resolveResumeDir: async (_id, { graphCwd, entryCwd } = {}) => graphCwd || entryCwd || null,
  continuations: true,
  forEachLine: forEachRolloutLine,
  directory: ({ sessionsDir, codexSessionsDir } = {}) => sessionsDir ?? codexSessionsDir,
  findFile: (id, options) => findRollout(id, codexHistory.directory(options)),
  async findFiles(id, options) {
    const chain = await findRolloutChain(id, this.directory(options));
    if (chain.length) return chain;
    const file = await this.findFile(id, options);
    return file && await firstSessionId(file) === null ? [file] : [];
  },
  createScanner: () => createNativeChatScanner('codex'),
  mightCarryChat: (line) => mightCarryChat(line, 'codex'),
  mightCarryText: (line) => mightCarryText(line, 'codex'),
  extractLine: (line) => extractNativeLine(line, 'codex'),
  discoverSources: ({ codexSessions }) => codexSources(codexSessions),
};
