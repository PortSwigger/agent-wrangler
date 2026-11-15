import { fileURLToPath } from 'node:url';

// Runtimes only the deck they are installed on offers: one whose pane runs
// `sleep` in place of an agent, and one whose agent command is not installed. server/multi-deck.test.js installs it on a second deck
// to start real sessions there from the board's new-session dialog.
export default {
  id: 'deck-runtime-probe',
  dir: fileURLToPath(new URL('.', import.meta.url)),
  label: 'Deck runtime probe',
  version: '0.1.0',
  defaultEnabled: true,
  runtimes: [{
    id: 'probe-shell',
    label: 'Probe shell',
    resumable: false,
    buildLaunch: async () => 'sleep 3600',
  }, {
    id: 'probe-missing',
    label: 'Probe missing agent',
    resumable: false,
    buildLaunch: async () => 'aw-probe-missing-agent-cli --start',
  }],
};
