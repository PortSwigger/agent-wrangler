// Results land on window.__compatProbe and in the view, for the test and for a
// person looking at the board. The button's inline onclick is what a strict
// CSP would block; the board's is Report-Only, so it runs and is reported.
const results = { fields: null, file: null, extFile: null, legacyWs: null, inline: null, csp: null };
window.__compatProbe = results;
document.addEventListener('securitypolicyviolation', (e) => {
  results.csp = { directive: e.effectiveDirective, disposition: e.disposition };
  render();
});
let host = null;
window.__compatRender = () => render();

function render() {
  if (!host) return;
  const row = (name, value) => `<tr><th style="text-align:left;padding:4px 12px 4px 0">${name}</th><td><code>${String(JSON.stringify(value)).replace(/</g, '&lt;')}</code></td></tr>`;
  host.innerHTML = `<div style="padding:16px"><h2>Compat probe: old extension surfaces</h2><table>${
    row('session fields (pid, suspendedAt, jobId)', results.fields)
    + row('GET /file', results.file)
    + row('GET /ext-file', results.extFile)
    + row('legacy /ws (no ?api=)', results.legacyWs)
    + row('inline onclick handler', results.inline)
    + row('CSP violation reported', results.csp)
  }</table><button id="compat-inline" onclick="window.__compatProbe.inline = 'ran'; window.__compatRender()">Run inline handler</button></div>`;
}

async function probeOnce(note) {
  if (results.file) return;
  results.file = 'pending';
  const file = await fetch(`/file?path=${encodeURIComponent(note)}`);
  results.file = { status: file.status, body: await file.json() };
  const ext = await fetch(`/ext-file?ext=compat-probe&path=${encodeURIComponent(note)}`);
  results.extFile = { status: ext.status, ok: (await ext.json()).ok };
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  const seen = { types: [], graphSessions: null, pong: null };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (!seen.types.includes(m.type)) seen.types.push(m.type);
    if (m.type === 'graph' && seen.graphSessions === null) {
      seen.graphSessions = m.graph.sessions.map((s) => ({ sessionId: s.sessionId, hasPid: 'pid' in s, suspendedAt: s.suspendedAt }));
      ws.send(JSON.stringify({ type: 'compat-probe-ping', n: 7 }));
    }
    if (m.type === 'ext:compat-probe') {
      seen.pong = m.pong;
      ws.close();
    }
    results.legacyWs = seen;
    render();
  };
  render();
}

export default {
  register(r) {
    r.register('view', {
      id: 'main',
      label: 'Compat probe',
      mount(el) { host = el; render(); },
      update(el, _ctx, graph) {
        host = el;
        const s = graph?.sessions?.[0];
        if (s) results.fields = { sessionId: s.sessionId, hasPid: 'pid' in s, pid: s.pid, suspendedAt: s.suspendedAt, jobId: s.jobId };
        if (graph?.compatProbe?.note) probeOnce(graph.compatProbe.note).catch((err) => { results.file = String(err); render(); });
        render();
      },
    });
  },
};
