import { MODALS, isOpenModal } from './board-targets.js';

// Counts the board's open dialogs and sends `{type:'dialogs', open}` whenever
// that count changes (and on every reconnect, via resend). The server holds
// unattended restarts while any connected board reports one open.
export function createDialogReporter({ doc, send, MutationObserverImpl = doc.defaultView?.MutationObserver }) {
  let last = null;
  const count = () => [...doc.querySelectorAll(MODALS)].filter(isOpenModal).length;
  function check(force = false) {
    const open = count();
    if (!force && open === last) return;
    if (send({ type: 'dialogs', open }) !== false) last = open;
    else last = null;
  }
  if (MutationObserverImpl) {
    new MutationObserverImpl(() => check()).observe(doc.body || doc.documentElement, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'open', 'hidden'],
    });
  }
  return { check, resend: () => check(true) };
}
