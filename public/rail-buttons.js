// Extension buttons on the rail (`api.rail.button`, 1.65.0). Core owns the
// element, its place (the rail's bottom zone, above Usage) and its progress
// ring; the extension owns its label, icon, pressed state, ring value and what a
// press does. The DOM is injected so the bookkeeping tests without a browser.

export const RING_R = 18;
export const RING_C = 2 * Math.PI * RING_R;

// What the ring shows: null (none), 'busy' (an arc that spins) or a fraction 0..1.
export function ringOf(progress) {
  if (progress === true || progress === 'busy') return 'busy';
  if (typeof progress !== 'number' || Number.isNaN(progress)) return null;
  return Math.min(1, Math.max(0, progress));
}

// The bar's dash offset for a fraction: RING_C is an empty ring, 0 a full one.
export const ringOffset = (fraction) => RING_C * (1 - fraction);

const RING_SVG = `<svg class="rail-ring" viewBox="0 0 40 40" aria-hidden="true"><circle class="rail-ring-track" cx="20" cy="20" r="${RING_R}"/><circle class="rail-ring-bar" cx="20" cy="20" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${RING_C.toFixed(2)}"/></svg>`;

export function createRailButtons({ doc, onError = (...a) => console.error(...a) }) {
  // `${extId}:${id}` -> { btn, opts }
  const buttons = new Map();
  const shownIcon = new WeakMap();

  function place(btn) {
    const bottom = doc.querySelector('#nav-rail .rail-bottom');
    if (!bottom) return false;
    // After this extension's earlier buttons and every other extension's, before core's own.
    const firstCore = [...bottom.children].find((c) => !c.classList.contains('rail-ext-btn'));
    bottom.insertBefore(btn, firstCore || null);
    return true;
  }

  function paint(btn, o) {
    btn.title = o.label;
    btn.setAttribute('aria-label', o.label);
    btn.classList.toggle('on', !!o.active);
    btn.setAttribute('aria-pressed', o.active ? 'true' : 'false');
    const icon = btn.querySelector('.rail-ext-icon');
    if (shownIcon.get(btn) !== o.icon) {
      // The icon is markup from the extension's own module, the trust level a view's icon already has.
      if (o.icon) icon.innerHTML = o.icon;
      else icon.textContent = o.label.slice(0, 1).toUpperCase();
      shownIcon.set(btn, o.icon);
    }
    const ring = ringOf(o.progress);
    btn.classList.toggle('ring', ring != null);
    btn.classList.toggle('ring-busy', ring === 'busy');
    const bar = btn.querySelector('.rail-ring-bar');
    const offset = ring == null ? RING_C : ring === 'busy' ? RING_C * 0.7 : ringOffset(ring);
    bar.setAttribute('stroke-dashoffset', offset.toFixed(2));
  }

  return {
    // `opts`: { id, label, icon?, active?, progress?, onPress(event) }. Returns
    // { update(partial), remove() }, or null when refused.
    add(extId, opts) {
      const id = opts?.id, label = opts?.label;
      if (typeof id !== 'string' || !id || typeof label !== 'string' || !label || typeof opts.onPress !== 'function') {
        onError(`[ext:${extId}] rail.button refused: needs an id, a label and an onPress function`);
        return null;
      }
      const slot = `${extId}:${id}`;
      buttons.get(slot)?.btn.remove();
      const o = { label, icon: typeof opts.icon === 'string' ? opts.icon : '', active: !!opts.active, progress: opts.progress ?? null };
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'rail-ext-btn';
      btn.dataset.extRail = slot;
      btn.innerHTML = `<span class="rail-ext-icon"></span>${RING_SVG}`;
      btn.addEventListener('click', (e) => {
        try { opts.onPress(e); } catch (err) { onError(`[ext:${extId}] rail.button ${id} onPress failed`, err); }
      });
      paint(btn, o);
      if (!place(btn)) { onError(`[ext:${extId}] rail.button refused: the board has no rail`); return null; }
      const entry = { btn, o };
      buttons.set(slot, entry);
      return Object.freeze({
        update(partial = {}) {
          if (buttons.get(slot) !== entry) return false;
          if (typeof partial.label === 'string' && partial.label) o.label = partial.label;
          if (typeof partial.icon === 'string') o.icon = partial.icon;
          if ('active' in partial) o.active = !!partial.active;
          if ('progress' in partial) o.progress = partial.progress ?? null;
          paint(btn, o);
          return true;
        },
        remove() {
          if (buttons.get(slot) !== entry) return;
          buttons.delete(slot);
          btn.remove();
        },
      });
    },
    dropExtension(extId) {
      for (const [slot, { btn }] of [...buttons]) {
        if (slot.startsWith(`${extId}:`)) { btn.remove(); buttons.delete(slot); }
      }
    },
  };
}
