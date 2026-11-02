import { AsyncLocalStorage } from 'node:async_hooks';

// The board tab whose control frame an extension handler is serving, as a
// `send(frame)` bound to that one socket. Carried through the handler's async
// chain rather than passed to it: the extension never holds the value, so it
// cannot keep one tab's sender and aim a later frame at it from a sweep or hook.
// Outside a handler (a sweep, a hook, an MCP tool) there is no origin.
const store = new AsyncLocalStorage();

export const runWithOrigin = (send, fn) => store.run(send, fn);

export const requestOrigin = () => store.getStore() ?? null;
