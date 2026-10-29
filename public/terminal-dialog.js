// Where focus goes when the terminal dialog closes: back to what had it when the
// dialog opened, or, when that element has since been redrawn away (an extension
// panel re-rendering on its own update), to the modal it sat in (`scope`) while
// that is still open, else the last open board modal, so Settings keeps the
// focus its Escape handler needs.
export function focusReturnTarget(opener, doc, scope = null) {
  if (opener && opener !== doc.body && opener.isConnected && !opener.closest('[inert], .hidden')) return opener;
  const isOpen = (el) => Boolean(el) && el.isConnected && el.id !== 'terminal-modal'
    && (el.tagName === 'DIALOG' ? el.open : !el.classList.contains('hidden'));
  const modal = isOpen(scope) ? scope : [...doc.querySelectorAll('[id$="-modal"]')].filter(isOpen).at(-1);
  return modal?.querySelector('button.primary:not([disabled])') ?? modal?.querySelector('button:not([disabled])') ?? null;
}
