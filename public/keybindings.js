// The board's keybinding registry: every global shortcut (core and extension)
// is a register() call here, dispatched from window keydown listeners that
// install() adds, and the Settings → Shortcuts tab is rendered from describe().
// DOM-free apart from install(): page state comes in through configure(), so
// the whole module runs under node --test and server/extensions/index.js can
// reuse parseCombo to validate a manifest's `keybindings`.
//
// Handlers that are inherently local to one element (rename input, card
// Enter/Space, context-menu arrows, hint-mode letters, confirm dialogs) stay
// where they are; they may register a display-only entry (no `run`) so the
// Shortcuts tab still lists them.

export const SCOPES = Object.freeze(['dispatch', 'modal', 'board', 'global']);

// Core groups, in the order the Shortcuts tab shows them; extension groups follow.
export const CORE_GROUPS = Object.freeze(['Board', 'Search', 'Dispatch dialog', 'Diff panel', 'Terminal']);

const NAMED_KEYS = {
  enter: 'enter', return: 'enter',
  escape: 'escape', esc: 'escape',
  left: 'left', right: 'right', up: 'up', down: 'down',
  backspace: 'backspace', delete: 'delete', del: 'delete',
  space: 'space', tab: 'tab',
};
const MOD_TOKENS = { mod: 'mod', cmd: 'meta', meta: 'meta', command: 'meta', ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', opt: 'alt', option: 'alt' };
const PUNCT = new Set(['/', ',', '.', ';', '[', ']', '-', '=', '`', '\\', "'"]);

const EVENT_KEYS = {
  enter: 'enter', escape: 'escape', arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down',
  backspace: 'backspace', delete: 'delete', ' ': 'space', tab: 'tab',
};

const MAC_GLYPHS = { left: '←', right: '→', up: '↑', down: '↓', backspace: '⌫', delete: '⌦', enter: 'Enter', escape: 'Escape', space: 'Space', tab: 'Tab' };
const PC_NAMES = { left: 'Left', right: 'Right', up: 'Up', down: 'Down', backspace: 'Backspace', delete: 'Delete', enter: 'Enter', escape: 'Escape', space: 'Space', tab: 'Tab' };

function detectMac() {
  const nav = globalThis.navigator;
  const p = nav?.userAgentData?.platform || nav?.platform || '';
  return /mac|iphone|ipad/i.test(p);
}

// "ctrl+cmd+n" → { key: 'n', mod, meta, ctrl, shift, alt }. Throws on anything
// it doesn't recognise, so a typo fails at register (or manifest load) time.
export function parseCombo(str) {
  if (typeof str !== 'string' || !str.trim()) throw new Error(`invalid key combo ${JSON.stringify(str)}`);
  const out = { key: null, mod: false, meta: false, ctrl: false, shift: false, alt: false };
  // Split on '+' but keep a literal trailing '+' impossible — no binding needs it.
  const tokens = str.toLowerCase().split('+').map((t) => t.trim());
  tokens.forEach((t, i) => {
    const last = i === tokens.length - 1;
    if (!last) {
      const m = MOD_TOKENS[t];
      if (!m) throw new Error(`unknown modifier "${t}" in key combo "${str}"`);
      out[m] = true;
      return;
    }
    if (NAMED_KEYS[t]) out.key = NAMED_KEYS[t];
    else if (/^[a-z0-9]$/.test(t) || PUNCT.has(t)) out.key = t;
    else throw new Error(`unknown key "${t}" in key combo "${str}"`);
  });
  return out;
}

function eventKeyName(e) {
  const k = String(e.key || '').toLowerCase();
  return EVENT_KEYS[k] || k;
}

export function createKeybindings({ mac = detectMac() } = {}) {
  let isMac = mac;
  let state = { isDispatchOpen: () => false, isModalOpen: () => false, isBoardIdle: () => false };
  let onError = (...a) => console.error(...a);
  const entries = [];
  const listeners = new Set();

  const changed = () => { for (const fn of listeners) { try { fn(); } catch (err) { onError('[keybindings] listener failed', err); } } };

  function want(p) {
    return {
      meta: p.meta || (p.mod && isMac),
      ctrl: p.ctrl || (p.mod && !isMac),
    };
  }

  function matches(p, e) {
    const w = want(p);
    if (Boolean(e.metaKey) !== w.meta || Boolean(e.ctrlKey) !== w.ctrl || Boolean(e.altKey) !== p.alt) return false;
    // A punctuation key may itself need Shift on some layouts ("/" on a German
    // keyboard), so it only checks Shift when the combo asks for it.
    if (!(PUNCT.has(p.key) && !p.shift) && Boolean(e.shiftKey) !== p.shift) return false;
    if (eventKeyName(e) === p.key) return true;
    // Alt/Shift can change e.key (⌥N → "˜", ⇧1 → "!"); fall back to the
    // physical key for letters and digits.
    if ((e.altKey || e.shiftKey) && typeof e.code === 'string') {
      if (/^[a-z]$/.test(p.key)) return e.code === `Key${p.key.toUpperCase()}`;
      if (/^[0-9]$/.test(p.key)) return e.code === `Digit${p.key}`;
    }
    return false;
  }

  function formatCombo(str) {
    const p = typeof str === 'string' ? parseCombo(str) : str;
    const w = want(p);
    const key = p.key.length === 1 ? p.key.toUpperCase() : (isMac ? MAC_GLYPHS : PC_NAMES)[p.key];
    if (isMac) return `${w.ctrl ? '⌃' : ''}${p.alt ? '⌥' : ''}${p.shift ? '⇧' : ''}${w.meta ? '⌘' : ''}${key}`;
    return [w.ctrl && 'Ctrl', p.alt && 'Alt', p.shift && 'Shift', w.meta && 'Meta', key].filter(Boolean).join('+');
  }

  function resolveScope() {
    if (state.isDispatchOpen()) return 'dispatch';
    if (state.isModalOpen()) return 'modal';
    if (state.isBoardIdle()) return 'board';
    return 'global';
  }

  const isExt = (b) => b.owner !== 'core';

  // { id, combo (string or array), scope, when?, run?, group, description,
  //   owner = 'core', ownerLabel?, capture?, preventAlways?, display?, hidden? }
  // → unregister(). `capture` puts the binding on the capture-phase listener
  // (fires before focused elements see the key — the ⌃⌘ family needs it to win
  // over the terminal); the rest run in the bubble phase, after local handlers,
  // as the listeners they replace did. `preventAlways` preventDefaults a match
  // even when `when()` says no.
  function register(def) {
    if (!def || typeof def !== 'object') throw new Error('register needs a binding definition');
    const { id, scope, run, when, group, description } = def;
    if (typeof id !== 'string' || !id) throw new Error('binding needs an id');
    if (!SCOPES.includes(scope)) throw new Error(`binding ${id}: scope must be one of ${SCOPES.join(', ')}`);
    const comboStrs = Array.isArray(def.combo) ? def.combo : [def.combo];
    const combos = comboStrs.map(parseCombo);
    if (run != null && typeof run !== 'function') throw new Error(`binding ${id}: run must be a function`);
    if (when != null && typeof when !== 'function') throw new Error(`binding ${id}: when must be a function`);
    const b = {
      id, scope, run: run || null, when: when || null, combos, comboStrs,
      group: String(group || def.ownerLabel || def.owner || 'Other'),
      description: String(description || ''),
      owner: def.owner || 'core',
      ownerLabel: def.ownerLabel || null,
      capture: Boolean(def.capture),
      preventAlways: Boolean(def.preventAlways),
      display: def.display || null,
      hidden: Boolean(def.hidden),
    };
    if (isExt(b) && b.run) {
      const clash = entries.find((o) => isExt(o) && o.run && o.scope === b.scope
        && o.combos.some((oc) => b.combos.some((bc) => sameCombo(oc, bc))));
      if (clash) {
        onError(`[ext:${b.owner}] keybinding "${b.comboStrs.join(', ')}" (${b.scope}) ignored: already bound by extension ${clash.owner}`);
        return () => {};
      }
    }
    entries.push(b);
    changed();
    return () => {
      const i = entries.indexOf(b);
      if (i >= 0) { entries.splice(i, 1); changed(); }
    };
  }

  function sameCombo(a, b) {
    const wa = want(a); const wb = want(b);
    return a.key === b.key && wa.meta === wb.meta && wa.ctrl === wb.ctrl && a.shift === b.shift && a.alt === b.alt;
  }

  // Runs the first matching, enabled binding for the active scope, then global.
  // Extensions are tried before core in each scope. Returns whether one ran.
  function dispatch(e, { capture = false } = {}) {
    const scopes = [...new Set([resolveScope(), 'global'])];
    for (const scope of scopes) {
      const cands = entries.filter((b) => b.run && b.scope === scope && b.capture === capture && b.combos.some((p) => matches(p, e)));
      cands.sort((a, b) => Number(isExt(b)) - Number(isExt(a)));
      for (const b of cands) {
        if (b.preventAlways) e.preventDefault?.();
        let ok = true;
        if (b.when) {
          try { ok = Boolean(b.when(e)); } catch (err) { report(b, 'when', err); ok = false; }
        }
        if (!ok) continue;
        e.preventDefault?.();
        e.stopPropagation?.();
        try { b.run(e); } catch (err) { report(b, 'run', err); }
        return true;
      }
    }
    return false;
  }

  function report(b, what, err) {
    if (isExt(b)) onError(`[ext:${b.owner}] keybinding ${b.id} ${what} threw`, err);
    else onError(`[keybindings] ${b.id} ${what} threw`, err);
  }

  // [{ group, owner, rows: [{ keys, description }] }] — core groups in
  // CORE_GROUPS order, then one group per extension.
  function describe() {
    const groups = new Map();
    const keyOf = (b) => (isExt(b) ? `ext:${b.owner}` : `core:${b.group}`);
    for (const b of entries) {
      if (b.hidden) continue;
      const k = keyOf(b);
      if (!groups.has(k)) groups.set(k, { group: isExt(b) ? (b.ownerLabel || b.group) : b.group, owner: b.owner, rows: [] });
      groups.get(k).rows.push({ keys: b.display || b.comboStrs.map(formatCombo).join(' / '), description: b.description });
    }
    const all = [...groups.values()];
    const core = all.filter((g) => g.owner === 'core')
      .sort((a, b) => rank(a.group) - rank(b.group));
    return [...core, ...all.filter((g) => g.owner !== 'core')];
  }
  const rank = (g) => { const i = CORE_GROUPS.indexOf(g); return i < 0 ? CORE_GROUPS.length : i; };

  return {
    parseCombo,
    formatCombo,
    matches,
    register,
    dispatch,
    describe,
    resolveScope,
    configure(opts = {}) {
      for (const k of ['isDispatchOpen', 'isModalOpen', 'isBoardIdle']) if (typeof opts[k] === 'function') state[k] = opts[k];
      if (typeof opts.onError === 'function') onError = opts.onError;
      if (typeof opts.mac === 'boolean') isMac = opts.mac;
    },
    // Called whenever a binding is added or removed (the Shortcuts tab re-renders).
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    install(win) {
      const cap = (e) => dispatch(e, { capture: true });
      const bub = (e) => dispatch(e, { capture: false });
      win.addEventListener('keydown', cap, true);
      win.addEventListener('keydown', bub);
      return () => { win.removeEventListener('keydown', cap, true); win.removeEventListener('keydown', bub); };
    },
  };
}

// The page's one registry.
export const keybindings = createKeybindings();
