import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { resolveImagePath } from '../../file-preview.js';
import { sniffRaster } from '../../control/handlers/chat-image.js';
import { atLocation } from '../../locations/index.js';
import { findRuntime } from '../../runtimes/index.js';

// Put an image in front of the human on purpose. The tool answers with the image
// itself, so it lands in the caller's transcript as a tool result, and the chat
// view draws tool-result images inline (chat-scanner.js, chat-images.js). Nothing
// else changes hands: no URL, no new route, and the board never opens the file
// again, because the chat view reads the transcript's own copy.

// Screenshots and charts are a few hundred KB. The cap bounds what one call
// adds to the transcript, where it stays as base64 (4/3 the size) for the
// life of the conversation. It is not the model's limit: Claude Code
// downscales an image the API would refuse.
export const MAX_SHOW_IMAGE_BYTES = 5 * 1024 * 1024;

const LABEL = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP' };

export const showImageTool = {
  name: 'show_image',
  description:
    'Show the human an image inline in your Agent Wrangler chat: a screenshot, chart, diagram or '
    + 'rendered output you made or captured. Pass the absolute path of a PNG, JPEG, GIF or WebP file '
    + 'on this machine, up to 5 MB. The image comes back as this tool\'s result, so you see it too, '
    + 'and the human sees it as a thumbnail in the session\'s Chat view that opens full size. Relative, '
    + 'missing, non-image and oversized paths are refused with the reason. Sessions in a container or '
    + 'at a remote location cannot use it, since their paths are not on the board\'s machine.',
  inputSchema: {
    path: z.string().describe('Absolute path to a .png, .jpg/.jpeg, .gif or .webp file, e.g. "/work/app/shots/home.png".'),
  },
  async handler({ deps, caller }, args = {}) {
    if (caller == null) return errorResult('This request carried no session identity, so there is no chat to show the image in.');
    const entry = deps.sessionManager.entryFor?.(caller);
    if (!entry) return errorResult('Could not find your session on the board.');
    // The board reads the file on its own machine. A container's or a location's
    // paths name files somewhere else, and reading them here would hand that
    // session files from outside its own filesystem.
    if (atLocation(entry) || (entry.runtime && entry.runtime !== 'local')) {
      const rt = findRuntime(entry.runtime);
      return errorResult(`show_image reads files on the board's machine, and this session runs in the "${rt?.label || entry.runtime}" runtime, whose paths are not the board's. Describe the image instead.`);
    }

    const raw = typeof args.path === 'string' ? args.path.trim() : '';
    const r = resolveImagePath(raw, {
      homedir: os.homedir(), realpathSync: fs.realpathSync, statSync: fs.statSync, maxBytes: MAX_SHOW_IMAGE_BYTES,
    });
    if (r.status !== 200) return errorResult(refusal(r, raw, entry.cwd));

    let bytes;
    try {
      bytes = await fs.promises.readFile(r.path);
    } catch (err) {
      return errorResult(`Could not read "${raw}": ${err?.code || err?.message || err}.`);
    }
    // Checked again on the bytes read: the file can change after the stat.
    if (bytes.length > MAX_SHOW_IMAGE_BYTES) return errorResult(tooLarge(raw, bytes.length));
    const mimeType = sniffRaster(bytes.subarray(0, 18).toString('base64'));
    if (!mimeType) return errorResult(`"${raw}" is named like an image, but its contents are not PNG, JPEG, GIF or WebP.`);

    return {
      content: [
        { type: 'text', text: `Shown in Chat: ${path.basename(r.path)} (${LABEL[mimeType]}, ${formatBytes(bytes.length)}).` },
        { type: 'image', data: bytes.toString('base64'), mimeType },
      ],
    };
  },
};

function refusal(r, raw, cwd) {
  if (r.status === 400 && !raw) return 'Pass `path`: the absolute path of the image to show.';
  if (r.status === 400) {
    const example = cwd ? ` such as "${path.resolve(cwd, raw)}"` : '';
    return `show_image needs an absolute path, and "${raw}" is relative. Pass the full path${example}.`;
  }
  if (r.status === 404) return `No file at "${raw}".`;
  if (r.status === 413) return tooLarge(raw, r.size);
  return `"${raw}" is not a PNG, JPEG, GIF or WebP file. Only those four are shown: save it as PNG (an SVG or PDF rendered to PNG, say) and show that.`;
}

// Rounded up, so a file just over the cap never reads as the cap itself.
function tooLarge(raw, size) {
  const mb = Math.ceil((size / (1024 * 1024)) * 10) / 10;
  return `"${raw}" is ${mb} MB; show_image takes images up to ${formatBytes(MAX_SHOW_IMAGE_BYTES)}. Save a smaller copy (downscaled, or JPEG for a photo) and show that.`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
