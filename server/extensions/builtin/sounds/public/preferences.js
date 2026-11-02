import { playSound } from './sound.js';

const KINDS = ['finished', 'needs-you'];
const MAX_BYTES = 1024 * 1024;

export async function readAudioFile(file, Ctor = globalThis.AudioContext || globalThis.webkitAudioContext) {
  if (!file?.size) throw Error('The audio file is empty.');
  if (file.size > MAX_BYTES) throw Error('Choose an audio file no larger than 1 MB.');
  const bytes = await file.arrayBuffer();
  let context;
  try {
    context = new Ctor();
    await context.decodeAudioData(bytes.slice(0));
  } catch { throw Error('This file could not be read as audio. Choose a browser-supported audio file.'); }
  finally { try { await context?.close(); } catch {} }
  const types = { wav: 'wav', mp3: 'mpeg', ogg: 'ogg', m4a: 'mp4', aac: 'aac', flac: 'flac', webm: 'webm', aiff: 'aiff' };
  const subtype = types[file.name.split('.').pop().toLowerCase()] || 'mpeg';
  const mime = /^audio\/[\w.+-]+$/.test(file.type) ? file.type : `audio/${subtype}`;
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return { name: file.name, data: `data:${mime};base64,${btoa(binary)}` };
}

export async function playCue(kind, sounds, { Audio = globalThis.Audio } = {}) {
  if (!KINDS.includes(kind)) return false;
  const sound = sounds[kind];
  if (!sound) return playSound(kind);
  try {
    const audio = new Audio(sound.data);
    await audio.play();
    return true;
  } catch { return false; }
}
