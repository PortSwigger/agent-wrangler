import { findTranscript, resolveResumeDir, launchCwd } from '../transcript-reader.js';
import { createNativeChatScanner, mightCarryChat } from './chat-scanner.js';
import { extractNativeLine, mightCarryText } from './search-formats.js';
import { claudeSources } from './history-sources.js';

export const claudeHistory = {
  requiresResumeFile: true,
  resolveResumeDir,
  launchCwd,
  directory: ({ projectsDir } = {}) => projectsDir,
  findFile: (id, { projectsDir } = {}) => findTranscript(id, projectsDir),
  async findFiles(id, options) {
    const file = await this.findFile(id, options);
    return file ? [file] : [];
  },
  createScanner: () => createNativeChatScanner('claude'),
  mightCarryChat: (line) => mightCarryChat(line, 'claude'),
  mightCarryText: (line) => mightCarryText(line, 'claude'),
  extractLine: (line) => extractNativeLine(line, 'claude'),
  discoverSources: ({ claudeProjects }) => claudeSources(claudeProjects),
};
