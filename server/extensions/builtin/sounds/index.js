import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SoundStore } from './store.js';
import { getSoundsHandler, setSoundsHandler } from './handlers.js';

export const dir = path.dirname(fileURLToPath(import.meta.url));

export default {
  id: 'sounds',
  label: 'Sounds',
  description: 'Audible cues when sessions finish or need your attention, with your own audio files.',
  help: 'Turn this extension on to hear sound cues. Upload an audio file for either cue, or keep the built-in tones. Settings and audio files are shared across browsers. Focus mode silences other tasks.',
  author: 'Agent Wrangler',
  dir,
  defaultEnabled: false,
  requires: ['board:broadcast'],
  stores: { sounds: () => new SoundStore() },
  handlers: [getSoundsHandler, setSoundsHandler],
  engines: { wranglerApi: '^1.35.0' },
  client: 'public/index.js',
  styles: 'public/style.css',
};
