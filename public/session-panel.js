// The open session's panel for `api.sessionPanel` (1.68.0): which view it shows
// (Chat or Terminal), scrolling it, and typing into it as the composer sends.
// The same panel serves the board and an extension view that borrowed it
// (api.mountSession), so this never asks where it is drawn.
//
// The Chat stream scrolls its own element. The Terminal scrolls as the wheel
// does: tmux runs `mouse on`, so a wheel notch is a mouse report the pane's app
// reads (Claude's fullscreen TUI scrolls its history, a plain pane enters tmux
// copy-mode). Typing honours `session.inputGate`: a locked session takes nothing.
//
// The DOM and the board are injected; planScroll and chatScrollTop are pure.

export const SCROLL_HOWS = ['page-up', 'page-down', 'line-up', 'line-down', 'top', 'bottom'];
// One Chat "line": a short step, about a line of prose at the default size.
export const CHAT_LINE_PX = 40;
// A Chat page keeps a little of the last screen in view, as Page Down does.
export const CHAT_PAGE_FRACTION = 0.85;
// A Terminal page in notches per row of the pane. Claude's TUI scrolls a line
// for a lone notch and speeds up through a burst: on a 56-row pane, 17 notches
// move about 45 lines, most of a screen.
export const TERMINAL_PAGE_NOTCHES_PER_ROW = 0.3;
// Terminal top/bottom are this many wheel notches: the pane cannot say where
// its history ends, and this is well past any session's usual scrollback.
export const TERMINAL_END_NOTCHES = 400;

// `how` as a direction and a unit, or null when it is not one of SCROLL_HOWS.
export function planScroll(how) {
  switch (how) {
    case 'page-up': return { dir: -1, unit: 'page' };
    case 'page-down': return { dir: 1, unit: 'page' };
    case 'line-up': return { dir: -1, unit: 'line' };
    case 'line-down': return { dir: 1, unit: 'line' };
    case 'top': return { dir: -1, unit: 'end' };
    case 'bottom': return { dir: 1, unit: 'end' };
    default: return null;
  }
}

// The Chat stream's next scrollTop for `plan`, clamped to what it can scroll.
export function chatScrollTop({ scrollTop, scrollHeight, clientHeight }, plan, linePx = CHAT_LINE_PX) {
  const max = Math.max(0, scrollHeight - clientHeight);
  const step = plan.unit === 'end' ? max : plan.unit === 'page' ? Math.max(linePx, Math.round(clientHeight * CHAT_PAGE_FRACTION)) : linePx;
  return Math.min(max, Math.max(0, scrollTop + plan.dir * step));
}

// Wheel notches for `plan` in a Terminal `rows` tall. A notch is what the pane's
// app scrolls per wheel step (tmux copy-mode: 5 lines; Claude's TUI: one, more
// in a burst), so a line is one notch.
export function terminalNotches(plan, rows) {
  if (plan.unit === 'end') return TERMINAL_END_NOTCHES;
  if (plan.unit === 'line') return 1;
  return Math.max(1, Math.round((Number(rows) || 24) * TERMINAL_PAGE_NOTCHES_PER_ROW));
}

// `view()` 'chat' | 'terminal' | null for the panel on screen now, `session()`
// its session row (or null), `gateFor(sessionId)` its input gate (or null).
// `chat` is { stream, append(text), submit() → bool }; `terminal` is
// { rows, wheel(dir, notches) → bool, paste(text), enter() → bool }; `sendMessage`
// is the composer's own `message` send for a Terminal submit with text.
export function createSessionPanel({ view, session, gateFor, chat, terminal, sendMessage }) {
  const refuse = (reason) => ({ ok: false, reason });
  return {
    view: () => view() || null,
    scroll(how) {
      const plan = planScroll(how);
      if (!plan) return refuse('bad-scroll');
      const v = view();
      if (v === 'chat') {
        const el = chat().stream;
        if (!el) return refuse('no-panel');
        const next = chatScrollTop(el, plan);
        if (next === el.scrollTop) return { ok: true, view: v, moved: false };
        el.scrollTop = next;
        return { ok: true, view: v, moved: true };
      }
      if (v === 'terminal') {
        const t = terminal();
        if (!t) return refuse('no-panel');
        return t.wheel(plan.dir, terminalNotches(plan, t.rows)) ? { ok: true, view: v, moved: true } : refuse('no-panel');
      }
      return refuse('no-panel');
    },
    type(text, { submit = false } = {}) {
      if (typeof text !== 'string') return refuse('bad-text');
      const s = session();
      const v = view();
      if (!s || !v) return refuse('no-panel');
      if (gateFor(s.sessionId)) return refuse('gated');
      if (!text && !submit) return { ok: true, view: v, submitted: false };
      if (v === 'chat') {
        const c = chat();
        if (!c.append(text)) return refuse('blocked');
        if (!submit) return { ok: true, view: v, submitted: false };
        return c.submit() ? { ok: true, view: v, submitted: true } : refuse('not-sent');
      }
      const t = terminal();
      if (!t) return refuse('no-panel');
      if (!submit) { t.paste(text); return { ok: true, view: v, submitted: false }; }
      // With text, the composer's own send: pasted at the pane's cursor (after
      // anything typed there already) and submitted. Without, just Enter.
      const sent = text ? sendMessage(s.sessionId, text) : t.enter();
      return sent ? { ok: true, view: v, submitted: true } : refuse('not-sent');
    },
  };
}
