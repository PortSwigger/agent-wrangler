// Settings › Telemetry, below the switch row: where events go (each sink an
// extension declared, by host), the team picker, what each emitter may send,
// and the queue with a preview of exactly what would leave. Built with
// textContent throughout: sink labels, hosts and event names come from
// extensions.

export const TELEMETRY_HELP = 'Sends usage events (counts, durations, kinds and model ids; never prompt text, titles, paths or branch names) to the sinks listed below. Nothing is sent while this is off or no extension supplies a sink. Turning it off drops anything still queued.';

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

export function sinkStatusText(sink, { enabled } = {}) {
  const parts = [`${sink.sent} sent`, `${sink.pending} queued`];
  if (sink.dropped) parts.push(`${sink.dropped} dropped`);
  if (sink.lastSentAt) parts.push(`last sent ${when(sink.lastSentAt)}`);
  if (!enabled) parts.push('not sending: telemetry is off');
  return parts.join(' · ');
}

function section(title) {
  const wrap = el('div', 'telemetry-section');
  wrap.append(el('div', 'ext-section-title', title));
  return wrap;
}

function sinkEl(sink, enabled) {
  const row = el('div', 'telemetry-sink');
  const head = el('div', 'telemetry-sink-head');
  head.append(el('span', 'telemetry-sink-host', sink.host));
  head.append(el('span', 'telemetry-sink-from', `from ${sink.extLabel}${sink.label ? ` · ${sink.label}` : ''}`));
  row.append(head);
  const accepts = el('div', 'ext-chips');
  for (const a of sink.accepts) accepts.append(el('span', 'ext-chip', a));
  row.append(accepts);
  row.append(el('div', 'telemetry-sink-status', sinkStatusText(sink, { enabled })));
  if (sink.headerNames.length) {
    row.append(el('div', 'telemetry-sink-status', `Sends headers ${sink.headerNames.join(', ')} (values hidden)`));
  }
  if (sink.lastError) row.append(el('div', 'telemetry-sink-error', `Last error: ${sink.lastError}`));
  return row;
}

// status: graph.telemetry. preview: the last 'telemetry-preview' reply, or null.
export function telemetryPanelEl({ status, preview = null, onTeam, onPreview, onClear } = {}) {
  const wrap = el('div', 'telemetry-panel');
  if (!status) {
    wrap.append(el('div', 'setting-help', 'Waiting for the server…'));
    return wrap;
  }

  const where = section('Where events go');
  if (!status.sinks.length) {
    where.append(el('div', 'telemetry-empty', 'No extension supplies a sink, so nothing is sent whatever the switch says. A sink comes from an installed extension declaring telemetry:sink.'));
  } else {
    for (const s of status.sinks) where.append(sinkEl(s, status.enabled));
  }
  wrap.append(where);

  if (status.teams.length) {
    const team = section('Team');
    const row = el('div', 'telemetry-team-row');
    row.append(el('div', 'setting-help', 'Optional. Lets the stats group events by team; sent only to sinks that list it.'));
    const select = el('select', 'setting-select telemetry-team');
    select.setAttribute('aria-label', 'Team');
    const none = el('option', null, 'Not set');
    none.value = '';
    select.append(none);
    for (const t of status.teams) {
      const o = el('option', null, t);
      o.value = t;
      select.append(o);
    }
    select.value = status.team && status.teams.includes(status.team) ? status.team : '';
    select.addEventListener('change', () => onTeam?.(select.value || null));
    row.append(select);
    team.append(row);
    wrap.append(team);
  }

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
  const clear = button('Clear queue', onClear, 'ext-btn ext-btn-danger');
  clear.disabled = !status.queued;
  qrow.append(clear);
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
