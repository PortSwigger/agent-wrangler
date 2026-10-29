import { adapterFor } from './agents/index.js';
export { paneHasWorkingStatus, paneComposerDraft, parseGhostSuggestion } from './agents/composer-parsers.js';

export function paneComposerIsReady(text, agent) {
  return adapterFor(agent).terminal.composerIsReady(text);
}

export function paneComposerIsEmpty(text, agent, options) {
  return adapterFor(agent).terminal.composerIsEmpty(text, options);
}
