import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pasteDirs } from '../../paste-store.js';
import { decodePasteImage, pasteFileName, prunePastes } from '../../paste-image.js';

// Land an image pasted into the chat composer on disk and hand back the path to
// put in the prompt. See paste-image.js for why a file is the only bridge from a
// browser paste to an agent that reads the HOST clipboard.
//
// The destination is the session's memory dir, and that choice is the whole
// reason this works without touching a launch: every Claude launch already passes
// `--add-dir addDirFor(sessionId)`, so a file underneath it is readable with no
// permission prompt and no relaunch — the same constraint that made
// `entry.mailCapable` necessary for the mailbox does not bite here. Verified end
// to end against a real pane, including through the by-session SYMLINK.
//
// A `pastes/` subdir is safe to create here: memoryStore.watchIgnored refuses
// anything that is not `tasks/<id>/memory.md`, so chokidar neither watches these
// files nor descends into the folder. Widening that filter would reintroduce the
// fd leak it exists to prevent, so do not "fix" it to see pastes.
export const pasteImageHandler = {
  type: 'paste-image',
  async handler(msg, ctx) {
    // token is echoed on every reply for the same reason chat.js echoes one: the
    // control socket does not await its handlers, so two pastes in flight can
    // finish out of order and the client must be able to tell which is which.
    const fail = (error) => ctx.reply({ type: 'paste-image-result', token: msg.token ?? null, ok: false, error });

    const entry = ctx.sessionManager?.entryFor?.(msg.sessionId);
    if (!entry) return fail('That session is no longer on the board.');
    // Archived is the one hard refusal, matching deliverMessage: the composer is
    // unusable there anyway, so writing a file for a prompt that can never be
    // sent would just leak.
    if (entry.archivedAt) return fail('That session is archived.');

    const decoded = decodePasteImage(msg);
    if (decoded.error) return fail(decoded.error);

    // realDir for the write, agentDir for what a prompt will name — paste-store.js
    // owns that distinction so this handler and the message handler cannot drift.
    const { realDir, agentDir } = pasteDirs(msg.sessionId, entry.agent);
    const name = pasteFileName(decoded.ext, { now: Date.now(), rand: crypto.randomBytes(4).toString('hex') });
    try {
      fs.mkdirSync(realDir, { recursive: true });
      fs.writeFileSync(path.join(realDir, name), decoded.bytes);
    } catch (err) {
      return fail(`Could not save the image: ${err?.message || err}`);
    }
    // Housekeeping, after the write and never before it: a prune failure must not
    // cost the human their paste.
    prunePastes(realDir, { now: Date.now(), readdirSync: fs.readdirSync, statSync: fs.statSync, rmSync: fs.rmSync });

    // `name` is what the composer sends back on submit, and the ONLY thing the
    // message handler will accept — a path from the client must never reach a
    // pane. `path` is reported for logs and tests, not for the client to echo.
    ctx.reply({
      type: 'paste-image-result',
      token: msg.token ?? null,
      ok: true,
      sessionId: msg.sessionId,
      path: path.join(agentDir, name),
      name,
      bytes: decoded.bytes.length,
    });
  },
};
