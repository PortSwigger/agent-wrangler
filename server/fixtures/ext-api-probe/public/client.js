// Calls every member of the extension api once and records what each answered
// on window.__extApiProbe (for server/ext-api.test.js) and in the view (for a
// person looking at the board). Navigation members are called with arguments
// that move nothing, so the probe never resumes or launches a session.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const pngBlob = () => new Blob([Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0))], { type: 'image/png' });

const out = { members: [], registrar: [], results: {}, graphKey: null, done: false };
window.__extApiProbe = out;

let view = null;
let started = false;
let pong = null;
let stateHeard = 0;

const check = (cond, detail) => {
  if (!cond) throw new Error(`unexpected: ${detail}`);
  return detail;
};
const isFn = (v) => typeof v === 'function';
const backs = (api, name, front) => () => check(isFn(api[name]), `backs ${front}`);
const settled = (p) => p.then((v) => `resolved ${JSON.stringify(v) ?? 'undefined'}`, (e) => {
  if (/not available|timed out/.test(String(e?.message))) throw e;
  return `rejected: ${e?.message || e}`;
});
const waitFor = async (fn, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (fn()) return true;
  return false;
};

function probes(api) {
  const scratch = () => {
    const d = document.createElement('div');
    d.hidden = true;
    view.appendChild(d);
    return d;
  };
  return {
    version: () => check(/^\d+\.\d+\.\d+$/.test(api.version), api.version),
    storage: () => {
      api.storage.set('k', 'v');
      return check(api.storage.get('k') === 'v' && api.storage.raw('ext.ext-api-probe.k').get() === 'v', 'namespaced round trip');
    },
    send: async () => {
      api.send({ type: 'ext-api-probe-ping', n: 2 });
      check(await waitFor(() => pong === 2), 'reply heard through onMessage');
      return 'ext.ext-api-probe.ext-api-probe-ping answered pong 2';
    },
    onMessage: () => check(pong === 2, 'heard the ext:ext-api-probe reply'),
    act: async () => {
      const r = await api.act('ext-api-probe-ping', { n: 3 });
      return check(r.ok === true && r.data?.pong === 3, JSON.stringify(r));
    },
    state: () => check(typeof api.state()?.extApiProbe?.note === 'string' && Object.isFrozen(api.state()), JSON.stringify(api.state())),
    onState: () => check(stateHeard >= 0, 'subscribed'),
    styles: async () => {
      const list = await api.styles();
      return check(Array.isArray(list), `${list.length} contributed styles`);
    },
    onConnect: () => {
      const off = api.onConnect(() => {});
      return check(isFn(off), 'returns unsubscribe');
    },
    onThemeChange: () => check(isFn(api.onThemeChange(() => {})), 'returns unsubscribe'),
    themeButtonHtml: () => check(/<button/.test(api.themeButtonHtml({ id: 'dark', name: 'Dark', base: 'dark' })), 'button html'),
    earlyAdopter: async () => {
      check(api.earlyAdopter?.branch === 'next' && typeof api.earlyAdopter.enabled() === 'boolean', 'branch next');
      return settled(api.earlyAdopter.set(false));
    },
    refreshInputGates: () => { api.refreshInputGates(); return 'ran'; },
    openSession: () => { api.openSession(''); return 'non-id refused'; },
    openDiff: () => { api.openDiff(''); return 'non-id refused'; },
    mountSession: () => check(api.mountSession(null, 'x') === null, 'non-element refused'),
    openTask: () => check(api.openTask('no-such-task') === false, 'unknown task'),
    setMinimisedTasks: () => check(typeof api.setMinimisedTasks([]) === 'boolean', 'boolean'),
    minimiseTask: () => check(api.minimiseTask('no-such-task') === false, 'unknown task'),
    ui: async () => {
      check(/<strong>b<\/strong>/.test(api.ui.markdownPreview('**b**')), 'markdownPreview');
      const answered = api.ui.notify({ id: 'probe', title: 'Extension API probe' });
      api.ui.withdraw('probe');
      check((await answered) === null, 'notify then withdraw');
      return check(api.ui.toast({ text: 'Extension API probe ran' }) === true, 'markdownPreview, notify, withdraw, toast');
    },
    settings: async () => {
      check(typeof api.settings() === 'object' && isFn(api.settings.onChange(() => {})), 'read + onChange');
      await api.settings.set('probe', 'set by the probe');
      return check(api.settings().probe === 'set by the probe', 'set round trip');
    },
    agents: () => check(Array.isArray(api.agents()) && isFn(api.agents.onChange(() => {})), `${api.agents().length} agents`),
    updateStatus: () => check(isFn(api.updateStatus.onChange(() => {})), JSON.stringify(api.updateStatus())),
    targets: () => {
      const list = api.targets.list();
      api.targets.badges({});
      check(api.targets.press('no-such-target') === false && isFn(api.targets.onChange(() => {})), 'list, badges, press, onChange');
      return `${list.length} targets`;
    },
    front: () => check(isFn(api.front.onChange(() => {})), JSON.stringify(api.front())),
    rail: () => check(api.rail.button({ id: 'probe', label: 'Probe', onPress() {} }) != null, 'rail button added'),
    sessionPanel: () => {
      check(api.sessionPanel.view() === null, 'no panel');
      check(api.sessionPanel.scroll('bottom').ok === false && api.sessionPanel.type('x').ok === false, 'nothing to scroll or type into');
      return 'view, scroll, type';
    },
    dispatchFields: () => {
      const h = api.dispatchFields.mount(scratch(), {});
      return check(h && isFn(h.read), 'mounted');
    },
    runtimes: () => check(Array.isArray(api.runtimes()) && api.runtimes().some((r) => r.id === 'local'), 'local listed'),
    images: async () => {
      const r = await api.images.stage(pngBlob());
      return check(typeof r?.name === 'string', JSON.stringify(r));
    },
    openFile: async () => {
      const r = await api.openFile(api.state().extApiProbe.note);
      document.getElementById('ext-file-close')?.click();
      return check(r.ok === true, JSON.stringify(r));
    },
    files: () => check(api.files.canOpen('a.md') === true && Array.isArray(api.files.types()), 'canOpen, types'),
    claimDrag: () => {
      const off = api.claimDrag(scratch());
      off();
      return check(isFn(off), 'claimed and released');
    },
    openDispatch: async () => {
      const p = api.openDispatch({ intent: 'probe' });
      await waitFor(() => !document.getElementById('modal')?.classList.contains('hidden'));
      document.getElementById('m-cancel')?.click();
      return check((await p) === null, 'opened, cancelled');
    },
    dispatch: async () => settled(api.dispatch.submit({})),
    requestBoardRender: () => { api.requestBoardRender(); return 'ran'; },
    requestPanelRender: () => { api.requestPanelRender(); return 'ran'; },
    cards: () => {
      check(Array.isArray(api.cards.chips()), 'chips');
      api.cards.hideChips([]);
      api.cards.renderSample(scratch());
      return 'chips, hideChips, renderSample';
    },
    keys: () => {
      const off = api.keys.bind({ combo: 'Alt+Shift+P', scope: 'board', run() {} });
      off();
      return check(isFn(off), 'bound and unbound');
    },
    markdownPreview: () => check(/<em>i<\/em>/.test(api.markdownPreview('*i*')), 'html'),
    selectedSessionId: () => check(api.selectedSessionId() === null, 'none selected'),
    modelFront: () => check(api.modelFront && typeof api.modelFront === 'object', 'model front data'),
    settingsFor: () => check(api.settingsFor('ext-api-probe')?.probe === 'set by the probe', 'raw settings read'),
    setExtSetting: backs(api, 'setExtSetting', 'settings.set'),
    stageImage: backs(api, 'stageImage', 'images.stage'),
    earlyAdopterFor: () => check(api.earlyAdopterFor('ext-api-probe')?.branch === 'next', 'facts'),
    setEarlyAdopter: backs(api, 'setEarlyAdopter', 'earlyAdopter.set'),
    updateStatusFor: backs(api, 'updateStatusFor', 'updateStatus'),
    renderSampleCard: backs(api, 'renderSampleCard', 'cards.renderSample'),
    openDispatchAcked: backs(api, 'openDispatchAcked', 'openDispatch'),
    submitDispatchFromExt: backs(api, 'submitDispatchFromExt', 'dispatch.submit'),
    notify: backs(api, 'notify', 'ui.notify'),
    withdrawNotification: backs(api, 'withdrawNotification', 'ui.withdraw'),
    toast: backs(api, 'toast', 'ui.toast'),
  };
}

// Order matters only where one probe reads what an earlier one did.
const ORDER = ['send', 'onMessage', 'settings', 'settingsFor'];

async function run(api) {
  out.members = Object.keys(api).sort();
  const table = probes(api);
  const names = [...new Set([...out.members.filter((n) => !ORDER.includes(n)), ...ORDER])];
  for (const name of names) {
    const probe = table[name];
    if (!probe) { out.results[name] = { ok: false, detail: 'no probe for this member' }; continue; }
    try {
      out.results[name] = { ok: true, detail: String(await probe()) };
    } catch (err) {
      out.results[name] = { ok: false, detail: String(err?.message || err) };
    }
    render();
  }
  out.done = true;
  render();
}

function render() {
  if (!view) return;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const rows = Object.entries(out.results).map(([name, r]) => `<tr><th>api.${esc(name)}</th><td class="${r.ok ? 'ok' : 'bad'}">${r.ok ? 'ok' : 'FAILED'}</td><td><code>${esc(r.detail.slice(0, 120))}</code></td></tr>`).join('');
  view.querySelector('.probe-body').innerHTML = `<p>${out.done ? 'Done' : 'Running'}: ${Object.values(out.results).filter((r) => r.ok).length} of ${out.members.length} members ok. Registrar: ${esc(out.registrar.join(', '))}. Read off the graph: ${esc(JSON.stringify(out.graphKey))}.</p><table>${rows}</table>`;
}

// Runs once the view is on screen, so the probe's toasts never land on the
// board's own view.
let waiting = false;
function startWhenShown(api) {
  if (started || waiting) return;
  if (view?.isConnected && view.parentElement?.getClientRects().length > 0 && api.state()?.extApiProbe) {
    started = true;
    run(api);
    return;
  }
  waiting = true;
  setTimeout(() => { waiting = false; startWhenShown(api); }, 250);
}

export default {
  register(r) {
    out.registrar = Object.keys(r).sort();
    r.onMessage((m) => { if (m.pong != null) pong = m.pong; });
    r.api.onState(() => { stateHeard += 1; });
    r.register('view', {
      id: 'main',
      label: 'API probe',
      mount(el) {
        view = el;
        el.classList.add('ext-api-probe');
        el.innerHTML = '<div style="padding:16px"><h2>Extension API probe: every api member</h2><div class="probe-body"></div></div>';
        render();
      },
      update(el, _ctx, graph) {
        view = el;
        if (out.graphKey === null && graph?.extApiProbe) out.graphKey = { note: typeof graph.extApiProbe.note };
        startWhenShown(r.api);
      },
    });
  },
};
