import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pasteDirs, STAGED_PASTES_DIR } from '../../paste-store.js';
import { decodePasteImage, convertToPng, pasteFileName, prunePastes } from '../../paste-image.js';
import { prefillPane as defaultPrefillPane } from '../../tmux-scraper.js';

// Land an image pasted into the chat composer on disk and hand back the path to
// put in the prompt. See paste-image.js for why a file is the only bridge from a
// browser paste to an agent that reads the HOST clipboard.
//
// The destination is a `pastes/` subdir of the first directory the enabled
// extensions granted this launch (task-memory's per-session notes dir; see
// paste-store.js), and that choice is the whole reason this works without
// touching a launch: the launch already passes that dir as `--add-dir`, so a
// file underneath it is readable with no permission prompt and no relaunch — the same constraint that made
// `entry.mailCapable` necessary for the mailbox does not bite here. Verified end
// to end against a real pane, including through the by-session SYMLINK.
//
// A `pastes/` subdir is safe to create there: task-memory's store.watchIgnored
// refuses anything that is not `tasks/<id>/memory.md`, so chokidar neither watches these
// files nor descends into the folder. Widening that filter would reintroduce the
// fd leak it exists to prevent, so do not "fix" it to see pastes.
export const pasteImageHandler = {
  type: 'paste-image',
  async handler(msg, ctx) {
    // token is echoed on every reply for the same reason chat.js echoes one: the
    // control socket does not await its handlers, so two pastes in flight can
    // finish out of order and the client must be able to tell which is which.
    const fail = (error) => ctx.reply({ type: 'paste-image-result', token: msg.token ?? null, ok: false, error });

    // `staged` is the dispatch dialog's paste: no session exists yet, so the image
    // waits in the staging dir until the dispatch claims it (paste-store.js).
    const staged = msg.staged === true;
    const entry = staged ? null : ctx.sessionManager?.entryFor?.(msg.sessionId);
    if (!staged && !entry) return fail('That session is no longer on the board.');
    // Archived is the one hard refusal, matching deliverMessage: the composer is
    // unusable there anyway, so writing a file for a prompt that can never be
    // sent would just leak.
    if (entry?.archivedAt) return fail('That session is archived.');

    let decoded = decodePasteImage(msg);
    if (decoded.error) return fail(decoded.error);
    if (decoded.convert) {
      decoded = await (ctx.convertToPng ?? convertToPng)(decoded.bytes, decoded.ext);
      if (decoded.error) return fail(decoded.error);
    }

    // `intoPane` is the terminal's paste: there is no composer to hold a chip, so
    // the path goes straight into the live pane the same way the message handler
    // delivers an attachment (its own bracketed paste, no Enter), where the TUI
    // turns it into `[Image #N]` at the cursor. Checked before the write so a
    // dormant pane does not leave an orphaned file behind.
    const tmux = msg.intoPane && !staged ? ctx.tmuxFor?.(msg.sessionId) : null;
    if (msg.intoPane && !tmux) return fail('That session has no live terminal to paste into.');

    // realDir for the write, agentDir for what a prompt will name — paste-store.js
    // owns that distinction so this handler and the message handler cannot drift.
    const { realDir, agentDir } = staged
      ? { realDir: STAGED_PASTES_DIR, agentDir: STAGED_PASTES_DIR }
      : pasteDirs(msg.sessionId, entry.agent);
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

    // The path is the server's own, built from the minted name — the client only
    // ever asked for "this image, into my pane".
    if (tmux) {
      try { await (ctx.prefillPane ?? defaultPrefillPane)(tmux, path.join(agentDir, name), ctx.socketFor?.(msg.sessionId) ?? ''); }
      catch (err) { return fail(`Could not paste into the terminal: ${err?.message || err}`); }
    }

    // `name` is what the composer sends back on submit, and the ONLY thing the
    // message handler will accept — a path from the client must never reach a
    // pane. `path` is reported for logs and tests, not for the client to echo.
    ctx.reply({
      type: 'paste-image-result',
      token: msg.token ?? null,
      ok: true,
      sessionId: staged ? null : msg.sessionId,
      staged: staged || undefined,
      path: path.join(agentDir, name),
      name,
      bytes: decoded.bytes.length,
    });
  },
};
