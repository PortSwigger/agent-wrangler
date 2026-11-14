export const ERROR_CODES = ['unsupported', 'not-found', 'invalid', 'forbidden', 'conflict', 'failed'];

export class DeckError extends Error {
  constructor(code, message) {
    super(message);
    this.code = ERROR_CODES.includes(code) ? code : 'failed';
  }
}

// Every core control type and the action that names it on the deck API. The
// coverage test fails when a handler is added without a row here.
export const CORE_ACTIONS = {
  'dispatch': 'session.dispatch',
  'validate-worktree': 'session.validate-worktree',
  'message': 'session.message',
  'resume': 'session.resume',
  'fork': 'session.fork',
  'archive': 'session.archive',
  'stop-container': 'session.stop-container',
  'worktree-remove': 'session.worktree-remove',
  'branch-delete': 'session.branch-delete',
  'remove': 'session.remove',
  'rename': 'session.rename',
  'detach': 'session.detach',
  'attach': 'session.attach',
  'snooze-set': 'session.snooze-set',
  'snooze-clear': 'session.snooze-clear',
  'auto-fix-pr-checks': 'session.auto-fix-pr-checks',
  'auto-merge-on-pass': 'session.auto-merge-on-pass',
  'set-child-full-view': 'session.set-child-full-view',
  'set-session-model': 'session.set-model',
  'open-terminal-for-session': 'session.open-terminal',
  'view-diff': 'session.view-diff',
  'diff-comments': 'session.diff-comments',
  'subagent-detail': 'session.subagent-detail',
  'chat': 'session.chat',
  'interrupt': 'session.interrupt',
  'paste-image': 'session.paste-image',
  'adopt-conversation': 'session.adopt-conversation',

  'task-create': 'task.create',
  'task-rename': 'task.rename',
  'task-archive': 'task.archive',
  'task-delete': 'task.delete',
  'task-unarchive': 'task.unarchive',
  'task-assign': 'task.assign',
  'task-reorder': 'task.reorder',
  'task-reorder-sessions': 'task.reorder-sessions',

  'schedule-create': 'schedule.create',
  'schedule-update': 'schedule.update',
  'schedule-delete': 'schedule.delete',
  'schedule-toggle': 'schedule.toggle',
  'schedule-run-now': 'schedule.run-now',

  'browse-folders': 'deck.browse-folders',
  'usage': 'deck.usage',
  'search': 'deck.search',
  'search-status': 'deck.search-status',
  'search-reindex': 'deck.search-reindex',
  'refresh': 'deck.refresh',

  'set-auto-fix-pr-checks-default': 'admin.set-auto-fix-pr-checks-default',
  'set-trust-codex-launch-cwd': 'admin.set-trust-codex-launch-cwd',
  'set-trust-claude-launch-cwd': 'admin.set-trust-claude-launch-cwd',
  'set-suppress-nudged-pr-toasts': 'admin.set-suppress-nudged-pr-toasts',
  'set-mail-wakes-dormant': 'admin.set-mail-wakes-dormant',
  'set-pr-model-footer': 'admin.set-pr-model-footer',
  'set-default-session-cwd': 'admin.set-default-session-cwd',
  'set-default-runtime': 'admin.set-default-runtime',
  'set-background-model': 'admin.set-background-model',
  'set-codex-policy-default': 'admin.set-codex-policy-default',
  'set-auto-update-mode': 'admin.set-auto-update-mode',
  'set-refresh-sessions-after-update': 'admin.set-refresh-sessions-after-update',
  'restart-server': 'admin.restart-server',
  'restart-tmux': 'admin.restart-tmux',
  'update-check': 'admin.update-check',
  'update-apply': 'admin.update-apply',
  'extension-enabled': 'admin.extension-enabled',
  'ext-setting-set': 'admin.ext-setting-set',
  'ext-install': 'admin.ext-install',
  'ext-consent': 'admin.ext-consent',
  'ext-uninstall': 'admin.ext-uninstall',
  'ext-check-updates': 'admin.ext-check-updates',
  'ext-set-auto-update': 'admin.ext-set-auto-update',
  'ext-set-early-adopter': 'admin.ext-set-early-adopter',
  'ext-browse': 'admin.ext-browse',
};

export const actionForHandler = (h) => (h.extId ? `ext.${h.extId}.${h.type}` : CORE_ACTIONS[h.type] ?? null);

// `handlers` is the router's active list (core plus enabled extensions');
// `native` are actions with no legacy control type, each `{ action, run(args, ctx) }`.
export function buildActionRegistry({ handlers, native = [] }) {
  const registry = new Map();
  for (const h of handlers) {
    const action = actionForHandler(h);
    if (action && !registry.has(action)) registry.set(action, { action, handler: h });
  }
  for (const n of native) if (!registry.has(n.action)) registry.set(n.action, n);
  return registry;
}

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

export function deckEvent(payload, { session = null, id } = {}) {
  const sid = payload?.sessionId ?? payload?.session?.sessionId ?? session ?? null;
  return { type: 'event', event: payload?.type ?? null, session: typeof sid === 'string' ? sid : null, data: payload, ...(id === undefined ? {} : { id }) };
}

function sessionKnown(ctx, sid) {
  if (ctx.sessionFromGraph?.(sid) || ctx.sessionManager?.entryFor?.(sid)) return true;
  return Boolean(ctx.graph?.()?.history?.some((h) => h.sessionId === sid));
}

// One `{type:'action'}` frame → exactly one `{type:'result'}` back on `ctx.send`.
// A legacy handler answers through ctx.reply: its last reply during the call is
// the result's data, any earlier one goes out as an event as soon as the next
// arrives, and one that comes after the result is an event too. A reply of
// type 'error' turns the result into a `failed` error.
export async function handleAction(msg, ctx, { registry, invoke }) {
  const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null;
  const send = ctx.send ?? ctx.reply;
  const fail = (code, message) => send({ type: 'result', id, ok: false, data: null, error: { code, message } });
  if (id === null) return fail('invalid', 'An action needs an id');
  if (typeof msg.action !== 'string' || !msg.action) return fail('invalid', 'An action needs a name');
  if (msg.args != null && !isPlainObject(msg.args)) return fail('invalid', 'args must be an object');
  if (msg.session != null && typeof msg.session !== 'string') return fail('invalid', 'session must be a session id');
  const entry = registry.get(msg.action);
  if (!entry) return fail('unsupported', `This deck does not offer ${msg.action}`);
  const session = msg.session ?? null;
  const args = msg.args ?? {};
  if (session && msg.action.startsWith('session.') && !sessionKnown(ctx, session)) return fail('not-found', `No session ${session}`);

  if (entry.run) {
    try {
      const data = await entry.run({ ...args, ...(session ? { sessionId: session } : {}) }, ctx);
      return send({ type: 'result', id, ok: true, data: data ?? null });
    } catch (err) {
      return fail(err instanceof DeckError ? err.code : 'failed', String(err?.message || err));
    }
  }

  let done = false;
  let pending = null;
  const event = (p) => send(deckEvent(p, { session, id }));
  const capture = (p) => {
    if (done) return event(p);
    if (pending) event(pending);
    pending = p;
  };
  const legacy = { ...args, type: entry.handler.type };
  if (session && legacy.sessionId === undefined) legacy.sessionId = session;
  try {
    await invoke(entry.handler, legacy, { ...ctx, reply: capture, origin: ctx.origin ?? ctx.reply });
  } catch (err) {
    done = true;
    return fail('failed', String(err?.message || err));
  }
  done = true;
  if (pending?.type === 'error') return fail('failed', String(pending.message || 'failed'));
  return send({ type: 'result', id, ok: true, data: pending });
}
