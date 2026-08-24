import { expandTilde } from '../../session-manager.js';
import { cloudPreflight } from '../../cloud-preflight.js';

export const cloudPreflightHandler = {
  type: 'cloud-preflight',
  // The LIVE half of the preflight: the dispatch dialog calls this on every
  // cwd/environment/ref change so the human sees the refusal before pressing
  // the button, exactly as validateWorktree() does for a worktree target. The
  // other half is `cloud.preflight` inside the runtime, which runs the SAME
  // function at launch time and returns only the first refusal — that is what
  // makes a schedule or an MCP dispatch (neither of which ever opens a dialog)
  // just as safe as this one. Nothing here is the gate; this is the preview.
  //
  // `deps` is a test seam only — the router calls `handler(msg, ctx)`, so the
  // default is what ships. It exists because the real preflight shells out to
  // git, and a handler test has no business needing a repo.
  async handler(msg, ctx, deps = {}) {
    const preflight = deps.cloudPreflight || cloudPreflight;
    // Same tilde expansion as validate-worktree: the cwd field is free text a
    // human types, and `~/src/thing` must reach git as an absolute path.
    const cwd = msg.cwd ? expandTilde(String(msg.cwd).trim()) : '';
    const { refusals, warnings } = await preflight({
      cwd,
      agent: msg.agent || 'claude',
      workflow: Boolean(msg.workflow),
      environmentId: msg.environmentId ? String(msg.environmentId).trim() : '',
      ref: msg.ref ? String(msg.ref).trim() : '',
    });
    // Echo the request fields back VERBATIM (the raw `msg.cwd`, not the expanded
    // one): the dialog keys replies on exactly what it sent, so a reply for a
    // cwd/environment the human has since changed is dropped rather than rendered
    // against the current form. Echoing the expanded path would never match that
    // key, silently discarding every reply.
    ctx.reply({
      type: 'cloud-preflight-result',
      ok: refusals.length === 0,
      refusals,
      warnings,
      cwd: msg.cwd || '',
      environmentId: msg.environmentId || '',
      ref: msg.ref || '',
      agent: msg.agent || 'claude',
      workflow: Boolean(msg.workflow),
    });
  },
};
