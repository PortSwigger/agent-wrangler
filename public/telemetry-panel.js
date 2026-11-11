// Settings › Telemetry: that it is always on, where events go (the collector
// URL in use and where it came from), what each emitter may
// send, and the queue with a preview of exactly what would leave. Built with
// textContent throughout: the URL can come from config and event names from
// extensions.

export const TELEMETRY_ALWAYS_ON = 'Telemetry is always on. There is no switch to turn it off.';
export const TELEMETRY_HELP = 'Sends usage events (counts, durations, kinds and model ids; never prompt text, titles, paths or branch names) to the collector below. Events queue from the first run and are sent whenever the collector is reachable.';

const SOURCE_TEXT = {
  builtin: 'Built in. Reachable only from the office network; elsewhere events wait in the queue.',
  env: 'Set by AW_TELEMETRY_URL, in place of the built-in collector.',
  config: 'Set by telemetry.url in config.json, in place of the built-in collector.',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, onClick, className = 'ext-btn') {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', () => onClick?.());
  return b;
}

function when(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', day: 'numeric', month: 'short' });
}

export function sinkStatusText(sink, { queued = 0 } = {}) {
  const parts = [`${sink.sent} sent`, `${queued} queued`];
  if (sink.dropped) parts.push(`${sink.dropped} dropped`);
  if (sink.lastSentAt) parts.push(`last sent ${when(sink.lastSentAt)}`);
  return parts.join(' · ');
}

function section(title) {
  const wrap = el('div', 'telemetry-section');
  wrap.append(el('div', 'ext-section-title', title));
  return wrap;
}

function sinkEl(sink, { queued }) {
  const row = el('div', 'telemetry-sink');
  row.append(el('div', 'telemetry-sink-host', sink.url));
  row.append(el('div', 'telemetry-sink-from', SOURCE_TEXT[sink.source] || ''));
  if (sink.source !== 'builtin') row.append(el('div', 'telemetry-sink-from', `Built-in collector: ${sink.builtin}`));
  if (sink.error) {
    row.append(el('div', 'telemetry-sink-error', `Not sending: ${sink.error}`));
    return row;
  }
  row.append(el('div', 'telemetry-sink-status', sinkStatusText(sink, { queued })));
  if (sink.repoOwners?.length) row.append(el('div', 'telemetry-sink-status', `Repo names sent for ${sink.repoOwners.join(', ')}; any other repo goes as "other".`));
  if (sink.lastError) row.append(el('div', 'telemetry-sink-error', `Last error: ${sink.lastError}`));
  return row;
}

// status: graph.telemetry. preview: the last 'telemetry-preview' reply, or null.
export function telemetryPanelEl({ status, preview = null, onPreview } = {}) {
  const wrap = el('div', 'telemetry-panel');
  const head = el('div', 'telemetry-always-on');
  head.append(el('div', 'setting-label', TELEMETRY_ALWAYS_ON));
  head.append(el('div', 'setting-help', TELEMETRY_HELP));
  wrap.append(head);
  if (!status) {
    wrap.append(el('div', 'setting-help', 'Waiting for the server…'));
    return wrap;
  }

  const where = section('Where events go');
  where.append(sinkEl(status.sink, { queued: status.queued }));
  wrap.append(where);

  const what = section('What can be sent');
  const withEvents = status.emitters.filter((e) => e.events.length);
  if (!withEvents.length) what.append(el('div', 'telemetry-empty', 'Nothing declares any events yet.'));
  for (const em of withEvents) {
    const box = el('details', 'telemetry-emitter');
    box.append(el('summary', null, `${em.id} ${em.version} · ${em.events.length} event${em.events.length === 1 ? '' : 's'}`));
    for (const ev of em.events) {
      const line = el('div', 'telemetry-event');
      line.append(el('span', 'telemetry-event-type', `${ev.type} v${ev.v}`));
      line.append(el('span', 'telemetry-event-fields', ev.fields.length ? ev.fields.join(', ') : 'no fields'));
      box.append(line);
    }
    what.append(box);
  }
  wrap.append(what);

  const queue = section('Queue');
  const qrow = el('div', 'telemetry-queue-row');
  qrow.append(el('span', 'telemetry-queue-count', `${status.queued} event${status.queued === 1 ? '' : 's'} queued`));
  qrow.append(button(preview ? 'Refresh' : 'Show queued events', onPreview));
  queue.append(qrow);
  if (preview) {
    if (!preview.length) queue.append(el('div', 'telemetry-empty', 'The queue is empty.'));
    else {
      queue.append(el('div', 'setting-help', `The newest ${preview.length}, exactly as each would be sent:`));
      queue.append(el('pre', 'telemetry-preview', preview.map((p) => `→ ${p.sink}\n${JSON.stringify(p.event, null, 2)}`).join('\n\n')));
    }
  }
  wrap.append(queue);

  wrap.append(el('div', 'telemetry-install', `Install id ${status.install}. Random, made on this machine; not derived from you or it.`));
  return wrap;
}
