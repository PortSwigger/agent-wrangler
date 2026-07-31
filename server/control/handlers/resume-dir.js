import fs from 'node:fs';

// Shared deleted-dir trap for resume & fork. The agent only finds its conversation
// when relaunched in the dir it was bucketed under; if that dir was deleted (a
// cleaned-up worktree is the common case), relaunching would strand the agent in ~
// with a cryptic "No conversation found". The transcript itself lives under
// ~/.claude (not the working dir), so recreating the empty dir restores the full
// conversation — only the working files are gone. Recreate only on explicit opt-in
// (msg.recreateDir). Returns true when the dir is ready to launch in; false when it
// sent a resume-needs-dir prompt (caller must return without launching). `extra`
// rides onto the prompt so fork can echo its own params for the opt-in re-send.
export function ensureLaunchDir({ dir, recreateDir, reply, sessionId, extra }) {
  if (dir && !fs.existsSync(dir)) {
    if (recreateDir) {
      fs.mkdirSync(dir, { recursive: true });
    } else {
      reply({ type: 'resume-needs-dir', sessionId, dir, ...extra });
      return false;
    }
  }
  return true;
}
