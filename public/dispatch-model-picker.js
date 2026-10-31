import { agentIcon } from './icons.js';
import { MODEL_FRONT as front } from './model-front-api.js';
import { samePick, onFront, effortsOf, costAt } from './model-front.js';

export function pickName(agents, p) {
  const agent = agents.find((a) => a.id === p.agent);
  const model = agent?.models.find((m) => m.value === p.model);
  const effort = agent?.efforts?.find((e) => e.value === p.effort);
  return `${model?.label?.split(' · ')[0] || p.model} · ${p.effort ? effort?.label || p.effort : 'Auto'}`;
}

export function pickColour(pick) {
  let hash = 2166136261;
  for (const c of `${pick.agent}/${pick.model}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  hash ^= hash >>> 16;
  return `hsl(${(hash >>> 0) % 360} 62% 48%)`;
}

export function modelKey(agents, points) {
  const unique = new Map(points.map((p) => [`${p.agent}/${p.model}`, p]));
  return [...unique].sort(([a], [b]) => a.localeCompare(b)).map(([, p]) => {
    const agent = agents.find((a) => a.id === p.agent);
    const provider = agent?.label || p.agent;
    const model = agent?.models.find((m) => m.value === p.model)?.label?.split(' · ')[0] || p.model;
    return { label: `${provider} / ${model}`, colour: pickColour(p), agent: p.agent };
  });
}

export function costRange(points) {
  if (!points.length) return [0.1, 10];
  const costs = points.map((p) => p.usd), lo = Math.min(...costs), hi = Math.max(...costs);
  const lowerPower = 10 ** Math.floor(Math.log10(lo)), upperPower = 10 ** Math.floor(Math.log10(hi));
  const min = [1, 2, 5].map((step) => step * lowerPower).filter((value) => value <= lo).at(-1);
  const max = [1, 2, 5, 10].map((step) => step * upperPower).find((value) => value >= hi);
  return [min, max > min ? max : min * 10];
}

export function costTicks(range) {
  const costs = Object.values(front.data.models).flatMap((models) => Object.values(models).flatMap((efforts) => Object.values(efforts).map((row) => row[1])));
  const [min, max] = range || [Math.min(...costs), Math.max(...costs)], ticks = [];
  for (let power = Math.floor(Math.log10(min)); power <= Math.ceil(Math.log10(max)); power++) {
    for (const step of [1, 2, 5]) {
      const usd = Number((step * 10 ** power).toPrecision(12));
      if (usd >= min && usd <= max) ticks.push({ usd, cost: costAt(usd, front.data), label: `$${usd < 1 ? usd.toFixed(2) : usd}` });
    }
  }
  return ticks;
}

export function pickerState(agents, pick) {
  const points = front.frontOf(agents), curve = front.curveOf(points);
  const resolved = front.resolvedPick(agents, pick), score = front.scoreOf(resolved);
  const handle = points.findIndex((p) => samePick(p, resolved));
  const beaten = front.beatenBy(points, resolved);
  const verdict = !score ? (!resolved.effort ? 'Not scored — Auto effort is not reported by this agent.' : 'Not scored — no benchmark for this setting.')
    : beaten ? `Below the front: ${pickName(agents, beaten)} is at least as good`
      : onFront(points, resolved) ? `On the front${!curve.some((p) => samePick(p, resolved)) ? ' — faster for its quality and cost' : ''}` : 'Not on the available front';
  return { front: points, curve, stops: points, unavailable: front.unavailableOf(points).filter((p) => !agents.some((a) => a.id === p.agent && a.models.some((m) => m.value === p.model && effortsOf(a, m).some((e) => e.value === p.effort)))), pick: resolved, score, handle, beaten, verdict };
}

export function curveStep(state, direction) {
  const current = state.handle >= 0 ? state.handle : state.score ? state.stops.indexOf(front.nearestOf(state.stops, state.score)) : -1;
  return state.stops[Math.max(0, Math.min(state.stops.length - 1, current + direction))];
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const providerLogo = (agent, attributes = '') => agentIcon(agent).replace('<svg ', `<svg class="model-front-logo" aria-hidden="true" focusable="false" ${attributes} `);
const clamp = (n) => Math.max(0, Math.min(100, n));
const y = (p) => 240 - p.quality * 2.1;

export function createDispatchModelPicker({ root, agents, read, select }) {
  const document = root.ownerDocument;
  const track = root.querySelector('.model-front-slider');
  const slider = root.querySelector('[role="slider"]');
  const stops = root.querySelector('.model-front-stops');
  const key = root.querySelector('.model-front-key');
  const preview = root.querySelector('.model-front-preview');
  const plot = root.querySelector('.model-front-plot');
  const credit = root.querySelector('.model-front-credit');
  const readout = root.querySelector('.model-front-readout');
  const notice = root.querySelector('.model-front-notice');
  credit.textContent = front.data.credit;
  let state, noticeTarget;
  function hideNotice() {
    noticeTarget?.removeAttribute('aria-describedby');
    noticeTarget = null;
    notice.hidden = true;
    notice.textContent = '';
  }
  function showNotice(dot) {
    if (noticeTarget === dot) { hideNotice(); return; }
    hideNotice();
    noticeTarget = dot;
    notice.textContent = `${dot.getAttribute('aria-label')}. Your installed agents do not offer this setting.`;
    notice.hidden = false;
    dot.setAttribute('aria-describedby', notice.id);
    const bounds = root.getBoundingClientRect(), anchor = dot.getBoundingClientRect();
    const centre = (anchor.left + anchor.right) / 2 - bounds.left;
    const left = Math.max(8, Math.min(bounds.width - notice.offsetWidth - 8, centre - notice.offsetWidth / 2));
    notice.style.left = `${left}px`;
    notice.style.setProperty('--notice-arrow-left', `${centre - left}px`);
    notice.style.top = `${anchor.top - bounds.top - 8}px`;
  }
  document.addEventListener('pointerdown', (e) => {
    if (noticeTarget && !notice.contains(e.target) && !noticeTarget.contains(e.target)) hideNotice();
  });
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideNotice(); });
  const choose = (p) => { if (p) { select(p); sync(); } };
  slider.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    choose(e.key === 'Home' ? state.stops[0] : e.key === 'End' ? state.stops.at(-1) : curveStep(state, ['ArrowRight', 'ArrowUp'].includes(e.key) ? 1 : -1));
  });
  function slide(e) {
    const rect = slider.getBoundingClientRect();
    choose(state.stops[Math.round(clamp((e.clientX - rect.left) / rect.width * 100) / 100 * (state.stops.length - 1))]);
  }
  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    track.setPointerCapture(e.pointerId);
    e.preventDefault();
    slider.focus();
    slide(e);
  });
  track.addEventListener('pointermove', (e) => { if (track.hasPointerCapture(e.pointerId)) slide(e); });
  track.addEventListener('pointerup', (e) => { if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId); });
  stops.addEventListener('click', (e) => { const stop = e.target.closest('[data-stop]'); if (stop) choose(state.stops[Number(stop.dataset.stop)]); });
  function describe(e) {
    const target = e.target.closest('[data-point], [data-stop]');
    if (target) preview.textContent = target.getAttribute('aria-label');
  }
  root.addEventListener('pointerover', describe);
  root.addEventListener('focusin', describe);
  root.addEventListener('pointerleave', () => { preview.textContent = root.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') || '' : ''; });
  root.addEventListener('focusout', (e) => {
    if (!root.contains(e.relatedTarget)) preview.textContent = '';
    if (noticeTarget && e.relatedTarget !== noticeTarget) hideNotice();
  });
  function plotPick(e) {
    const dot = e.target.closest('[data-point]');
    if (!dot) return;
    if (dot.dataset.unavailable === 'true') {
      showNotice(dot);
    } else choose(dot.dataset.point === 'selected' ? state.pick : state.front[Number(dot.dataset.point)]);
  }
  plot.addEventListener('click', plotPick);
  plot.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); plotPick(e); }
  });
  function sync() {
    hideNotice();
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    const focusStop = focused?.dataset.stop;
    const focusPoint = focused?.dataset.point;
    const focusUnavailable = focused?.dataset.unavailable;
    const available = agents(), pick = read();
    state = pickerState(available, pick);
    const range = costRange([...state.front, ...state.unavailable, ...(state.score && state.beaten ? [state.score] : [])]);
    const lower = costAt(range[0], front.data), upper = costAt(range[1], front.data);
    const x = (p) => 42 + (p.cost - lower) / (upper - lower) * 488;
    slider.setAttribute('aria-valuemin', '0');
    slider.setAttribute('aria-valuemax', String(Math.max(0, state.stops.length - 1)));
    slider.setAttribute('aria-valuenow', String(Math.max(0, state.handle)));
    slider.setAttribute('aria-valuetext', `${pickName(available, pick)}. ${state.verdict}`);
    slider.setAttribute('aria-disabled', String(!state.stops.length));
    track.classList.toggle('no-handle', state.handle < 0);
    stops.innerHTML = state.stops.map((p, i) => `<button type="button" class="model-front-stop" data-stop="${i}" aria-label="${esc(pickName(available, p))}" title="${esc(pickName(available, p))}" style="left:${i / Math.max(1, state.stops.length - 1) * 100}%;--pick-colour:${pickColour(p)}">${providerLogo(p.agent)}</button>`).join('');
    slider.innerHTML = `<span class="model-front-track"></span><span class="model-front-handle" style="left:${Math.max(0, state.handle) / Math.max(1, state.stops.length - 1) * 100}%"></span>`;
    key.innerHTML = modelKey(available, [...state.front, ...state.unavailable, pick]).map((m) => `<span><i style="--pick-colour:${m.colour}" aria-hidden="true">${providerLogo(m.agent)}</i>${esc(m.label)}</span>`).join('');
    const dot = (p, i, unavailable) => {
      const name = pickName(available, p), selected = samePick(state.pick, p), below = i === 'selected';
      const status = unavailable ? ' — unavailable' : below ? ' — below front' : '';
      return `<g role="button" tabindex="0" data-point="${i}" data-unavailable="${unavailable}" aria-label="${esc(name)}${status}" aria-pressed="${selected}" style="--pick-colour:${pickColour(p)}" class="model-front-point${unavailable ? ' unavailable' : ''}${selected ? ' selected' : ''}${below ? ' below' : ''}">${unavailable ? '' : `<title>${esc(name)}: quality ${p.quality}, $${p.usd.toFixed(2)}, ${p.minutes.toFixed(1)} min${status}</title>`}<circle class="point-hit" cx="${x(p)}" cy="${y(p)}" r="12"/><circle class="point-mark" cx="${x(p)}" cy="${y(p)}" r="9"/>${providerLogo(p.agent, `x="${x(p) - 8}" y="${y(p) - 8}" width="16" height="16"`)}${selected ? `<circle class="point-selection" cx="${x(p)}" cy="${y(p)}" r="12"/>` : ''}</g>`;
    };
    plot.innerHTML = `<svg viewBox="0 0 540 282" aria-label="Quality against log cost" role="group">${[0, 20, 40, 60, 80, 100].map((q) => `<path class="model-front-grid" d="M42 ${y({ quality: q })}H530"/><text x="32" y="${y({ quality: q }) + 4}" text-anchor="end">${q}</text>`).join('')}<text x="42" y="15">Quality ↑</text><text x="530" y="278" text-anchor="end">Cost per task (log scale) →</text>${costTicks(range).map((tick) => `<text x="${x(tick)}" y="257" text-anchor="middle">${tick.label}</text>`).join('')}<polyline class="model-front-curve" points="${state.curve.map((p) => `${x(p)},${y(p)}`).join(' ')}"/>${state.unavailable.map((p, i) => dot(p, i, true)).join('')}${state.front.map((p, i) => dot(p, i, false)).join('')}${state.score && state.beaten ? dot({ ...state.pick, ...state.score }, 'selected', false) : ''}</svg>`;
    const s = state.score;
    const bar = (label, value, width) => `<div class="model-front-bar"><span>${label}</span><span class="model-front-meter"><i style="width:${clamp(width)}%"></i></span><strong>${value}</strong></div>`;
    readout.innerHTML = `<div class="model-front-name">${esc(pickName(available, pick))}</div>${!pick.effort && s ? `<div class="model-front-auto">Auto → ${esc(state.pick.effort)}</div>` : ''}${s ? bar('Quality', `${s.quality.toFixed(0)} / 100`, s.quality) + bar('Cost', `$${s.usd.toFixed(2)} / task`, s.cost) + bar('Time', `${s.minutes.toFixed(1)} min`, s.time) : '<p>Quality, cost and time are not measured for this pick.</p>'}<div class="model-front-verdict${state.beaten ? ' below' : !s ? ' unscored' : ''}">${esc(state.verdict)}</div>`;
    if (focusStop != null) stops.querySelector(`[data-stop="${focusStop}"]`)?.focus({ preventScroll: true });
    else if (focusPoint != null) plot.querySelector(`[data-point="${focusPoint}"][data-unavailable="${focusUnavailable}"]`)?.focus({ preventScroll: true });
  }
  return { sync };
}
