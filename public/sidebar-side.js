// Which side of the board the session pane (terminal / chat) sits on, and the
// drag-resize maths that has to work from either. Pure module (imports nothing)
// so it's unit-testable under node and free of DOM coupling — app.js owns the
// localStorage + <main> class wiring, styles.css owns the flip itself.

// The pane's own floor, and the board's. Both were inline in initSidebarResize's
// clamp before this module existed; the numbers are unchanged.
export const MIN_SIDEBAR_W = 280;
export const MIN_BOARD_W = 200;

// The pane's width for a drag that put the handle at `clientX`, given the pane's
// current bounding rect. Measured from the pane's FAR edge — the one the drag
// handle isn't on — which is what makes one formula cover both sides: on the
// right that edge is rect.right, on the left it's rect.left. Deliberately the
// pane's own rect rather than the viewport edge the old code used: with the pane
// on the left there is a nav rail between it and x=0, so `viewportWidth` is no
// longer the right origin, and on the right the two agree anyway.
export function sidebarWidthFromDrag({ clientX, rect, viewportWidth, onLeft }) {
  const raw = onLeft ? clientX - rect.left : rect.right - clientX;
  // Floor applied last so it wins on a viewport too narrow to satisfy both — an
  // overflowing pane beats one squeezed below its minimum.
  return Math.max(MIN_SIDEBAR_W, Math.min(viewportWidth - MIN_BOARD_W, raw));
}
