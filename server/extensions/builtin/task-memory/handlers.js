// The two control frames the memory modal speaks. Handed the extension's own
// `host` façade (not the board's ctx), so there is no per-socket `reply`: the
// answer is an `ext:task-memory` broadcast the browser half filters by taskId
// and ignores unless its editor is open on that task.
export const getMemoryHandler = {
  type: 'get-memory',
  async handler(msg, host) {
    host.broadcast({ kind: 'memory', taskId: msg.taskId, md: host.stores.taskMemory.read(msg.taskId) });
  },
};

export const setMemoryHandler = {
  type: 'set-memory',
  async handler(msg, host) {
    // The watcher picks this write up and fans out the `changed` frame plus a
    // rebuild (dot refresh) on its own — the same path as an agent's append — so
    // there is nothing to broadcast here.
    host.stores.taskMemory.write(msg.taskId, msg.md ?? '');
  },
};
