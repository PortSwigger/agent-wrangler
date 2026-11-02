import crypto from 'node:crypto';

// `terminals.create` for extensions: a plain-shell tmux registered for /pty,
// presented in the sidebar of every tab (the default) or as a dialog in the one
// tab that asked (`origin`). A dialog terminal is `detachable`: closing the
// dialog drops the browser's attach and leaves the shell running, so a later
// create with the same `key` presents that live shell again instead of starting
// a second one. The command is typed once, at creation, and never re-sent.
// `alive` lets the owning extension decide whether to offer Reopen.
export function createExtTerminalOpener({ createShellSession, socket, terminalRegistry, broadcast, isAlive }) {
  const byKey = new Map(); // key -> terminalId
  const pending = new Map(); // key -> last queued create, so a double click reuses the first shell

  const present = (frame, presentation, origin) => {
    if (presentation === 'dialog') origin?.(frame);
    else broadcast(frame);
  };

  async function liveFor(key) {
    const terminalId = byKey.get(key);
    const entry = terminalId && terminalRegistry.get(terminalId);
    if (entry && await isAlive(entry)) return { terminalId, entry };
    if (terminalId) {
      byKey.delete(key);
      if (entry) terminalRegistry.remove(terminalId);
    }
    return null;
  }

  async function open({ cwd, command = '', presentation = 'sidebar', title, key }, origin, owner) {
    const frame = (terminalId, cmd) => ({
      type: 'open-terminal', terminalId, command: cmd, sessionId: null,
      ...(presentation === 'dialog' ? { presentation, ...(title ? { title } : {}) } : {}),
    });
    if (key) {
      const live = await liveFor(key);
      if (live) {
        present(frame(live.terminalId, live.entry.command || ''), presentation, origin);
        return { terminalId: live.terminalId, reused: true };
      }
    }
    const terminalId = `t_${crypto.randomBytes(4).toString('hex')}`;
    const tmuxName = await createShellSession(cwd, socket(), command);
    terminalRegistry.set(terminalId, { tmuxName, socket: socket(), cwd, command, owner, ...(presentation === 'dialog' ? { detachable: true } : {}) });
    if (key) byKey.set(key, terminalId);
    present(frame(terminalId, command), presentation, origin);
    return { terminalId, reused: false };
  }

  const create = (opts = {}, { origin = null, owner = null } = {}) => {
    const { key } = opts;
    if (!key) return open(opts, origin, owner);
    const p = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(() => open(opts, origin, owner));
    pending.set(key, p);
    p.finally(() => { if (pending.get(key) === p) pending.delete(key); }).catch(() => {});
    return p;
  };

  // Whether `owner`'s terminal is still running, for a Reopen button. Another
  // owner's id, or one never issued, reads as not alive rather than leaking.
  const alive = async (terminalId, owner) => {
    const entry = terminalRegistry.get(terminalId);
    if (!entry || entry.owner !== owner) return false;
    if (await isAlive(entry)) return true;
    terminalRegistry.remove(terminalId);
    return false;
  };

  return { create, alive };
}
