// One picker button per bundled theme: pressed is on. A click flips that
// theme's toggle; unset counts as on.

const JP_REPO = 'https://github.com/psjamesh/agent-wrangler-jurassic-park-theme';
const JP_NOTE_KEY = 'aw-themes-jurassic-park-note';

export default {
  register(slots) {
    const api = slots.api;
    let themes = null;
    const panels = new Set();

    const isOn = (t) => api.settings()[t.key] !== false;
    const draw = (el) => {
      const grid = el.querySelector('.theme-rows');
      if (!themes) { grid.textContent = 'Loading themes…'; return; }
      grid.innerHTML = themes.map((t) => api.themeButtonHtml({ id: t.id, ...t.manifest }, { active: isOn(t) })).join('');
    };
    const drawAll = () => { for (const el of panels) draw(el); };

    api.onMessage((msg) => {
      if (msg.kind !== 'themes') return;
      themes = msg.themes;
      drawAll();
    });
    const refresh = () => api.send({ type: 'themes-list' });
    api.onConnect(refresh);
    refresh();
    api.settings.onChange(drawAll);

    slots.register('settings.panel', {
      id: 'themes',
      mount(el) {
        const doc = el.ownerDocument;
        const intro = doc.createElement('p');
        intro.className = 'setting-help';
        intro.textContent = 'Each highlighted theme is offered in Settings › Appearance. Click one to turn it off or on.';
        const grid = doc.createElement('div');
        grid.className = 'theme-rows';
        grid.addEventListener('click', (e) => {
          const btn = e.target.closest('.theme-row');
          const t = btn && themes?.find((x) => x.id === btn.dataset.id);
          if (t) api.settings.set(t.key, !isOn(t)).catch(() => {});
        });
        el.append(intro, grid);
        panels.add(el);
        draw(el);
      },
      unmount(el) { panels.delete(el); },
    });

    // Jurassic Park left the bundled set for a community extension. A browser
    // that still has it saved shows Dark (core never rewrites `cm-style`); say
    // where it went, once, unless something already offers it again.
    let saved = null;
    let noted = true;
    try {
      saved = localStorage.getItem('cm-style');
      noted = localStorage.getItem(JP_NOTE_KEY) === '1';
    } catch {}
    if (saved === 'jurassic-park' && !noted) {
      fetch('/api/styles').then((r) => r.json()).then(({ styles }) => {
        if (styles.some((s) => s.id === 'jurassic-park')) return;
        api.ui.notify({
          id: 'jurassic-park-moved',
          title: 'Jurassic Park theme has moved',
          body: 'It is now a community extension, so the board shows Dark. Install it from Settings › Extensions to get it back.',
          actions: [{ id: 'open', label: 'Open the repository', primary: true }],
        }).then((answer) => {
          try { localStorage.setItem(JP_NOTE_KEY, '1'); } catch {}
          if (answer === 'open') window.open(JP_REPO, '_blank', 'noopener');
        });
      }).catch(() => {});
    }
  },
};
