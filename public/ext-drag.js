// Drag ownership for extension-drawn elements. Core's drag-and-drop (card and
// task-tile reorder, the cell drop highlight) is wired to specific core elements,
// but a drag that STARTS inside an extension's own markup — a reorderable row in
// a `task.body`, a draggable section in a `panel.section` — still bubbles through
// the board, so core would otherwise treat it as a board drag. An extension calls
// `api.claimDrag(el)` on any element it owns; core then ignores every drag whose
// source is inside a claimed element. A leaf: no DOM at import.

export const CLAIM_ATTR = 'data-ext-drag';

// Mark `el` as extension-owned for drag purposes. Returns the unclaim function.
export function claimDrag(el, extId = '') {
  if (!el || typeof el.setAttribute !== 'function') return () => {};
  el.setAttribute(CLAIM_ATTR, extId);
  return () => { el.removeAttribute?.(CLAIM_ATTR); };
}

// Is this drag source inside a claimed element? `target` is a dragstart event's
// target (a text node is walked up to its element).
export function isClaimedDrag(target) {
  const el = target && target.nodeType === 3 ? target.parentNode : target;
  return Boolean(el && typeof el.closest === 'function' && el.closest(`[${CLAIM_ATTR}]`));
}
