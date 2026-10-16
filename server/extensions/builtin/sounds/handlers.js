export const getSoundsHandler = {
  type: 'sounds-get',
  handler(msg, host) {
    host.broadcast({ kind: 'sounds', reqId: msg.reqId, sounds: host.stores.sounds.read() });
  },
};

export const setSoundsHandler = {
  type: 'sounds-set',
  handler(msg, host) {
    try {
      host.stores.sounds.save(msg.sounds);
      host.broadcast({ kind: 'sounds', reqId: msg.reqId, sounds: host.stores.sounds.read() });
    } catch (err) {
      host.broadcast({ kind: 'sounds-error', reqId: msg.reqId, error: err.message });
    }
  },
};
