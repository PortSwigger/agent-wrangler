import { findConversationFiles as realFindConversationFiles } from '../../conversation-file.js';
import { adapterFor } from '../../agents/index.js';
import { findRuntime } from '../../runtimes/index.js';
import { atLocation, locationTranscript } from '../../locations/index.js';
import { MAX_CHAT_IMAGE_BYTES, parseImageRef, toolResultImages } from '../../agents/chat-scanner.js';
import { conversationOf, openSegments, readVirtualRange } from './chat.js';

// The bytes behind one image ref of a chat frame (chat-scanner.js), read when
// the chat view draws its thumbnail. A TARGETED reply, like subagent-detail.
//
// The ref names a byte range of the session's own transcript and nothing else,
// resolved from the card exactly as the chat poll resolves it. The range is
// accepted only if it is still one whole line holding a raster image of the
// recorded length, so a transcript rewritten since the poll yields an error,
// never some other line's bytes.

// The longest line a ref may name: one tool result with a few full-size
// screenshots in it, with room to spare. Bounds what one request reads.
export const MAX_IMAGE_LINE_BYTES = 64 * 1024 * 1024;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// The type the bytes themselves say, whatever the transcript labelled them.
// Anything that is not one of the four rasters is refused here.
export function sniffRaster(base64) {
  const head = Buffer.from(base64.slice(0, 24), 'base64');
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// The ref's line plus one byte either side, so the boundaries can be checked.
// null when the range is outside the transcript or it cannot be read.
async function readAround(ctx, ref, { entry, convId, agent }) {
  const from = Math.max(0, ref.at - 1);
  const to = ref.at + ref.len + 1;
  if (atLocation(entry)) {
    if (agent !== 'claude') return null;
    const text = await locationTranscript((ctx.findRuntime || findRuntime)(entry.runtime), entry, convId);
    if (text == null) return null;
    const bytes = Buffer.from(text, 'utf8');
    return to <= bytes.length ? bytes.subarray(from, to) : null;
  }
  const findConversationFiles = ctx.findConversationFiles || ctx.findConversationFile || realFindConversationFiles;
  const resolved = await findConversationFiles(convId, agent, { resolveAdapter: ctx.resolveAdapter || adapterFor });
  const files = Array.isArray(resolved) ? resolved : (resolved ? [resolved] : []);
  if (!files.length) return null;
  let opened;
  try {
    opened = await openSegments(files);
  } catch {
    return null;
  }
  try {
    return to <= opened.size ? await readVirtualRange(opened.segments, from, to) : null;
  } catch {
    return null;
  } finally {
    await Promise.all(opened.segments.map(({ handle }) => handle?.close()));
  }
}

export const chatImageHandler = {
  type: 'chat-image',
  async handler(msg, ctx) {
    const fail = (message) => ctx.reply({ type: 'error', message });
    const ref = parseImageRef(msg.ref);
    if (!ref) return fail('Not an image reference');
    if (ref.len > MAX_IMAGE_LINE_BYTES) return fail('That transcript line is too large to read');
    const conv = conversationOf(msg, ctx);
    const around = await readAround(ctx, ref, conv);
    const gone = () => fail('That image is no longer in this conversation');
    if (!around) return gone();
    const lead = ref.at > 0 ? 1 : 0;
    // A line starts at the file's start or after a newline, and ends at one: the
    // chat poll only ever hands out refs for complete lines.
    if ((lead && around[0] !== 0x0a) || around[around.length - 1] !== 0x0a) return gone();
    let entry;
    try {
      entry = JSON.parse(around.toString('utf8', lead, around.length - 1));
    } catch {
      return gone();
    }
    const image = toolResultImages(entry, conv.agent)[ref.n];
    if (!image || image.data.length !== ref.b64Length) return gone();
    if (image.data.length > Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4) return fail('That image is too large to show');
    const mediaType = BASE64_RE.test(image.data) ? sniffRaster(image.data) : null;
    if (!mediaType) return fail('That image is not a PNG, JPEG, GIF or WebP');
    ctx.reply({ type: 'chat-image', sessionId: msg.sessionId, ref: msg.ref, mediaType, data: image.data });
  },
};
