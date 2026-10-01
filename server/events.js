// The in-process event bus: how core announces "something happened" to
// extensions (and extensions to each other) without core importing them.
//
// Core holds ONE bus (server/index.js) and passes it to the producers that
// announce on it (archive-review-runner emits `archive-review:completed`); an
// extension subscribes through `host.events` (the `events` capability, built in
// host-api/v1.js), which tags every subscription with the extension's id.
//
// Three rules, each one a way a bad subscriber could hurt a producer:
//   - A throwing (or rejecting) handler is caught and reported PER HANDLER, so
//     one broken extension never stops the next handler hearing the event and
//     never throws back into the producer.
//   - emit() does not await handlers. A producer announcing an event is not
//     waiting on whoever listens, and a slow subscriber must not stall it.
//   - An owner that is not active receives nothing. Deactivation drops its
//     subscriptions (offOwner), and `isActive` is the belt to that braces: a
//     handler registered by an extension that has since been disabled is inert
//     even in the window before the drop lands.
export function createEventBus({ onError = () => {}, isActive = () => true } = {}) {
  const handlers = new Map(); // event name -> Set<{ fn, owner }>

  function on(name, fn, owner = null) {
    if (typeof name !== 'string' || !name) throw new TypeError('events.on: name must be a non-empty string');
    if (typeof fn !== 'function') throw new TypeError('events.on: handler must be a function');
    const entry = { fn, owner };
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name).add(entry);
    return () => { handlers.get(name)?.delete(entry); };
  }

  // Returns how many handlers were invoked (a failing one still counts: it was
  // delivered to).
  function emit(name, payload) {
    const set = handlers.get(name);
    if (!set) return 0;
    let delivered = 0;
    for (const { fn, owner } of [...set]) {
      if (owner != null && !isActive(owner)) continue;
      delivered += 1;
      try {
        const out = fn(payload);
        if (out && typeof out.then === 'function') out.then(undefined, (err) => onError(`[events] handler for "${name}"${owner ? ` (${owner})` : ''} rejected`, err));
      } catch (err) {
        onError(`[events] handler for "${name}"${owner ? ` (${owner})` : ''} threw`, err);
      }
    }
    return delivered;
  }

  // Drop every subscription an owner took — what deactivating an extension does.
  function offOwner(owner) {
    for (const set of handlers.values()) for (const entry of [...set]) if (entry.owner === owner) set.delete(entry);
  }

  // Whether anyone would hear `name`. Lets a producer skip expensive work no
  // subscriber will see (the archive review spends a model call per archive).
  function hasListeners(name) {
    for (const { owner } of handlers.get(name) || []) if (owner == null || isActive(owner)) return true;
    return false;
  }

  return { on, emit, offOwner, hasListeners };
}
