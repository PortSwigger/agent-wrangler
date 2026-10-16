import path from 'node:path';
import { DATA_DIR } from '../../../data-dir.js';
import { readJsonOrLoud, writeJsonAtomic } from '../../../atomic-json.js';

function validate(sounds) {
  if (!sounds || typeof sounds !== 'object' || Array.isArray(sounds)) throw Error('Invalid audio configuration.');
  const next = {};
  for (const [kind, sound] of Object.entries(sounds)) {
    if (!['finished', 'needs-you'].includes(kind)) throw Error('Unknown audio cue.');
    if (typeof sound?.name !== 'string' || sound.name.length > 255 || typeof sound.data !== 'string') throw Error('Invalid audio file.');
    const match = /^data:audio\/[\w.+-]+;base64,([A-Za-z0-9+/]+={0,2})$/.exec(sound.data);
    if (!match || sound.data.length > 1400000 || Buffer.from(match[1], 'base64').length > 1024 * 1024) throw Error('Invalid audio file or file exceeds 1 MB.');
    next[kind] = { name: sound.name, data: sound.data };
  }
  return next;
}

export class SoundStore {
  constructor(file = path.join(DATA_DIR, 'sounds.json')) {
    this.file = file;
    this.sounds = validate(readJsonOrLoud(file) ?? {});
  }
  read() { return structuredClone(this.sounds); }
  save(sounds) {
    const next = validate(sounds);
    writeJsonAtomic(this.file, next);
    this.sounds = next;
  }
}
