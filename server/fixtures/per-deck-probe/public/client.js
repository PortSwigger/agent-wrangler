const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function sectionHtml(api, d) {
  const head = `<h3><span class="pdp-dot" style="background:${esc(d.colour || 'transparent')}"></span>${esc(d.name || d.deckId)}${d.own ? ' <small>(this board\'s deck)</small>' : ''}</h3>`;
  if (d.status === 'incompatible') return `${head}<p class="pdp-status pdp-incompatible">Incompatible: this deck runs the extension with boardApi <code>${esc(d.boardApi)}</code></p>`;
  if (d.status !== 'ready') return `${head}<p class="pdp-status">Unreachable</p>`;
  const count = api.state({ deck: d.deckId })?.count ?? 0;
  return `${head}<p>Count on this deck: <strong class="pdp-count">${count}</strong></p><button type="button" class="pdp-bump">Bump on ${esc(d.name || 'this deck')}</button>`;
}

export default {
  register(reg) {
    const api = reg.api;
    const hosts = new Set();
    const render = () => {
      for (const el of hosts) {
        el.innerHTML = `<div class="pdp"><h2>Per-deck probe</h2>${api.decks().map((d) => `<section class="pdp-deck" data-deck="${esc(d.deckId)}" data-status="${esc(d.status)}">${sectionHtml(api, d)}</section>`).join('')}</div>`;
        for (const btn of el.querySelectorAll('.pdp-bump')) {
          const deck = btn.closest('section').dataset.deck;
          btn.addEventListener('click', () => api.act('per-deck-probe-bump', {}, { deck }));
        }
      }
    };
    api.decks.onChange(render);
    reg.register('view', {
      id: 'main',
      label: 'Per-deck probe',
      mount(el) { hosts.add(el); render(); },
      update() {},
      unmount(el) { hosts.delete(el); },
    });
  },
};
