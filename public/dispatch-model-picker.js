import { MODEL_FRONT as front } from './model-front-api.js';
import { samePick, onFront, effortsOf } from './model-front.js';

export function pickName(agents, p) {
  const agent = agents.find((a) => a.id === p.agent);
  const model = agent?.models.find((m) => m.value === p.model);
  const effort = agent?.efforts?.find((e) => e.value === p.effort);
  return `${model?.label?.split(' · ')[0] || p.model} · ${p.effort ? effort?.label || p.effort : 'Auto'}`;
}

export function pickerState(agents, pick) {
  const points = front.frontOf(agents), curve = front.curveOf(points);
  const resolved = front.resolvedPick(agents, pick), score = front.scoreOf(resolved);
  const handle = curve.findIndex((p) => samePick(p, resolved));
  const beaten = front.beatenBy(points, resolved);
  const verdict = !score ? (!resolved.effort ? 'Not scored — Auto effort is not reported by this agent.' : 'Not scored — no benchmark for this setting.')
    : beaten ? `Below the front: ${pickName(agents, beaten)} is at least as good`
      : onFront(points, resolved) ? `On the front${handle < 0 ? ' — faster for its quality and cost' : ''}` : 'Not on the available front';
  return { front: points, curve, unavailable: front.unavailableOf(points).filter((p) => !agents.some((a) => a.id === p.agent && a.models.some((m) => m.value === p.model && effortsOf(a, m).some((e) => e.value === p.effort)))), pick: resolved, score, handle, beaten, verdict };
}

export function curveStep(state, direction) {
  const current = state.handle >= 0 ? state.handle : state.score ? state.curve.indexOf(front.nearestOf(state.curve, state.score)) : -1;
  return state.curve[Math.max(0, Math.min(state.curve.length - 1, current + direction))];
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (n) => Math.max(0, Math.min(100, n));
const x = (p) => 42 + clamp(p.cost) * 4.64;
const y = (p) => 240 - p.quality * 2.1;

export function createDispatchModelPicker({ root, agents, read, select }) {
  const slider = root.querySelector('[role="slider"]');
  const plot = root.querySelector('.model-front-plot');
  const credit = root.querySelector('.model-front-credit');
  const readout = root.querySelector('.model-front-readout');
  const notice = root.querySelector('.model-front-notice');
  credit.textContent = front.data.credit;
  let state;
  const choose = (p) => { if (p) { notice.textContent = ''; select(p); sync(); } };
  slider.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    choose(e.key === 'Home' ? state.curve[0] : e.key === 'End' ? state.curve.at(-1) : curveStep(state, ['ArrowRight', 'ArrowUp'].includes(e.key) ? 1 : -1));
  });
  function slide(e) {
    const rect = slider.getBoundingClientRect();
    choose(state.curve[Math.round(clamp((e.clientX - rect.left) / rect.width * 100) / 100 * (state.curve.length - 1))]);
  }
  slider.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    slider.setPointerCapture(e.pointerId);
    slider.focus();
    slide(e);
  });
  slider.addEventListener('pointermove', (e) => { if (slider.hasPointerCapture(e.pointerId)) slide(e); });
  slider.addEventListener('pointerup', (e) => { if (slider.hasPointerCapture(e.pointerId)) slider.releasePointerCapture(e.pointerId); });
  function plotPick(e) {
    const dot = e.target.closest('[data-point]');
    if (!dot) return;
    if (dot.dataset.unavailable === 'true') {
      notice.textContent = `${dot.getAttribute('aria-label')}. Your installed agents do not offer this setting.`;
    } else choose(state.front[Number(dot.dataset.point)]);
  }
  plot.addEventListener('click', plotPick);
  plot.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); plotPick(e); }
  });
  function sync() {
    const available = agents(), pick = read();
    state = pickerState(available, pick);
    slider.setAttribute('aria-valuemin', '0');
    slider.setAttribute('aria-valuemax', String(Math.max(0, state.curve.length - 1)));
    slider.setAttribute('aria-valuenow', String(Math.max(0, state.handle)));
    slider.setAttribute('aria-valuetext', `${pickName(available, pick)}. ${state.verdict}`);
    slider.setAttribute('aria-disabled', String(!state.curve.length));
    slider.classList.toggle('no-handle', state.handle < 0);
    slider.innerHTML = `<span class="model-front-track"></span>${state.curve.map((p, i) => `<span class="model-front-stop" style="left:${i / Math.max(1, state.curve.length - 1) * 100}%"></span>`).join('')}<span class="model-front-handle" style="left:${Math.max(0, state.handle) / Math.max(1, state.curve.length - 1) * 100}%"></span>`;
    const dot = (p, i, unavailable) => {
      const name = pickName(available, p), selected = samePick(state.pick, p);
      return `<g role="button" tabindex="0" data-point="${i}" data-unavailable="${unavailable}" aria-label="${esc(name)}${unavailable ? ' — unavailable' : ''}" aria-pressed="${selected}" class="model-front-point${unavailable ? ' unavailable' : ''}${selected ? ' selected' : ''}"><title>${esc(name)}: quality ${p.quality}, $${p.usd.toFixed(2)}, ${p.minutes.toFixed(1)} min${unavailable ? ' — unavailable' : ''}</title><circle class="point-hit" cx="${x(p)}" cy="${y(p)}" r="8"/><circle cx="${x(p)}" cy="${y(p)}" r="${selected ? 6 : 4}"/></g>`;
    };
    plot.innerHTML = `<svg viewBox="0 0 540 282" aria-label="Quality against log cost" role="group">${[0, 20, 40, 60, 80, 100].map((q) => `<path class="model-front-grid" d="M42 ${y({ quality: q })}H506"/><text x="32" y="${y({ quality: q }) + 4}" text-anchor="end">${q}</text>`).join('')}<text x="42" y="15">Quality ↑</text><text x="506" y="278" text-anchor="end">Cost per task (log scale) →</text>${[0, 25, 50, 75, 100].map((c) => { const rows = Object.values(front.data.models).flatMap((m) => Object.values(m).flatMap(Object.values)); const costs = rows.map((r) => r[1]); const usd = Math.exp(Math.log(Math.min(...costs)) + c / 100 * Math.log(Math.max(...costs) / Math.min(...costs))); return `<text x="${x({ cost: c })}" y="257" text-anchor="middle">$${usd.toFixed(2)}</text>`; }).join('')}<polyline class="model-front-curve" points="${state.curve.map((p) => `${x(p)},${y(p)}`).join(' ')}"/>${state.unavailable.map((p, i) => dot(p, i, true)).join('')}${state.front.map((p, i) => dot(p, i, false)).join('')}${state.score && state.beaten ? `<circle class="model-front-below" cx="${x(state.score)}" cy="${y(state.score)}" r="6"><title>Selected: below the front</title></circle>` : ''}</svg>`;
    const s = state.score;
    const bar = (label, value, width) => `<div class="model-front-bar"><span>${label}</span><span class="model-front-meter"><i style="width:${clamp(width)}%"></i></span><strong>${value}</strong></div>`;
    readout.innerHTML = `<div class="model-front-name">${esc(pickName(available, pick))}</div>${!pick.effort && s ? `<div class="model-front-auto">Auto → ${esc(state.pick.effort)}</div>` : ''}${s ? bar('Quality', `${s.quality.toFixed(0)} / 100`, s.quality) + bar('Cost', `$${s.usd.toFixed(2)} / task`, s.cost) + bar('Time', `${s.minutes.toFixed(1)} min`, s.time) : '<p>Quality, cost and time are not measured for this pick.</p>'}<div class="model-front-verdict${state.beaten ? ' below' : !s ? ' unscored' : ''}">${esc(state.verdict)}</div>`;
  }
  return { sync };
}
