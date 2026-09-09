import { esc, tildify } from './util.js';
import { isSessionSub, kindChipHtml, kindLabel, kindClass, dependencyLevels, dependencyLine, storyLabel } from './jobs.js';

// A job's sub-jobs drawn as a dependency graph: one column per wave (a sub-job's
// wave is one past its deepest prerequisite, `dependencyLevels`), a box per
// sub-job carrying its kind chip, and an SVG arrow from every prerequisite to
// what waits on it. The same drawing serves three moments — the plan under
// review (`editable`: title inputs and a per-box dependency editor), the
// approved plan while tickets are created (static), and the live job
// (`statusOf`: each box is a button that opens the sub-job and shows its
// status) — so what a human approved and what is running look alike.
//
// The arrows are positioned by `layoutGraphEdges` from the boxes' rendered
// rectangles, not by this markup: the boxes are ordinary grid items so their
// height follows their content (a wrapped title, an opened dependency editor),
// and the SVG just traces whatever the browser laid out. Callers re-run it
// after anything that can move a box.
export function planGraphHtml(plan, { editable = false, statusOf = null, openDeps = new Set() } = {}) {
  const subs = plan.subJobs;
  if (!subs.length) return '';
  const levels = dependencyLevels(plan);
  const waves = Math.max(...levels.values()) + 1;
  const story = (s) => `<span class="job-plan-story">${esc(s.jiraKey || storyLabel(plan.stories?.find((t) => t.id === s.storyId)))}</span>`;
  const where = (s) => isSessionSub(s) ? '<span class="job-plan-kind">Agent session on this machine · no PR</span>' : `<span class="job-plan-repo" title="${esc(s.repo)}">${esc(tildify(s.repo))}</span>`;
  // The branch the PR will come from, in the repo's own convention. Under review
  // it is an input (the planner's proposal is a proposal); once approved it is
  // shown as text. `{key}` is the Jira key placeholder `job-store.js` fills in.
  const branch = (s) => s.branch && !isSessionSub(s) ? `<span class="job-plan-branch" title="Branch">${esc(s.branch)}</span>` : '';
  const node = (s, i) => {
    const deps = dependencyLine(plan, s);
    const head = `<span class="job-node-head">${kindChipHtml(s)}${story(s)}</span>`;
    if (editable) {
      const others = subs.filter((d) => d.id !== s.id);
      const branchInput = isSessionSub(s) ? '' : `<input class="job-plan-branch" aria-label="${kindLabel(s)} branch ${i + 1}" data-branch="${i}" maxlength="120" placeholder="Branch (repo convention)" value="${esc(s.branch || '')}">`;
      return `<div class="job-node ${kindClass(s)}" data-node="${esc(s.id)}">${head}<input aria-label="${kindLabel(s)} title ${i + 1}" data-title="${i}" maxlength="180" value="${esc(s.title)}">${where(s)}${branchInput}
        <details class="job-node-deps" data-deps="${esc(s.id)}" ${openDeps.has(s.id) ? 'open' : ''}><summary>${esc(deps || 'Independent')}</summary>${others.map((d) => `<label><input type="checkbox" data-dep="${i}" value="${esc(d.id)}" ${s.dependsOn.includes(d.id) ? 'checked' : ''}>${kindChipHtml(d)}<span>${esc(d.title)}</span></label>`).join('') || '<span>No other sub-jobs</span>'}</details></div>`;
    }
    const line = deps ? `<span class="job-node-line">${esc(deps)}</span>` : '';
    if (!statusOf) return `<div class="job-node ${kindClass(s)}" data-node="${esc(s.id)}">${head}<strong>${esc(s.title)}</strong>${where(s)}${branch(s)}${line}</div>`;
    const status = statusOf(s);
    return `<button type="button" class="job-node ${kindClass(s)} ${s.stage === 'done' ? 'done' : ''}" data-node="${esc(s.id)}" data-open-sub="${esc(s.id)}">${head}<strong>${esc(s.title)}</strong>${where(s)}${branch(s)}${line}<span class="job-status ${esc(status.tone)}"><i></i>${esc(status.text)}</span></button>`;
  };
  const columns = Array.from({ length: waves }, (_, w) => `<div class="job-graph-col"><h4>Wave ${w + 1}</h4>${subs.map((s, i) => levels.get(s.id) === w ? node(s, i) : '').join('')}</div>`).join('');
  const edges = subs.flatMap((s) => s.dependsOn.filter((id) => levels.has(id)).map((id) => `<path data-from="${esc(id)}" data-to="${esc(s.id)}" marker-end="url(#job-graph-arrow)"/>`)).join('');
  const mixed = subs.some(isSessionSub) && subs.some((s) => !isSessionSub(s));
  const legend = [mixed ? `${kindChipHtml({})} opens a pull request` : '', mixed ? `${kindChipHtml({ kind: 'session' })} runs as an agent session here, no PR` : '', edges ? '<span>Arrows point from a prerequisite to the work that waits on it</span>' : ''].filter(Boolean);
  return `<div class="job-graph ${editable ? 'editable' : ''}">${legend.length ? `<p class="job-graph-legend">${legend.join('')}</p>` : ''}
    <div class="job-graph-scroll"><div class="job-graph-canvas" style="--waves:${waves}"><div class="job-graph-columns">${columns}</div>
    <svg class="job-graph-edges" aria-hidden="true"><defs><marker id="job-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5 0 10z"/></marker></defs>${edges}</svg></div></div></div>`;
}

// Trace each arrow between the boxes it names, in the canvas's own pixel space
// (the SVG fills the canvas and has no viewBox, so user units are CSS px). A
// canvas with no size — hidden, or a DOM with no layout — leaves the paths
// without geometry rather than drawing them all at the origin.
export function layoutGraphEdges(graph) {
  const canvas = graph?.querySelector('.job-graph-canvas');
  if (!canvas) return;
  const base = canvas.getBoundingClientRect();
  if (!base.width) return;
  const boxes = new Map([...graph.querySelectorAll('[data-node]')].map((el) => [el.dataset.node, el.getBoundingClientRect()]));
  for (const path of graph.querySelectorAll('.job-graph-edges path[data-from]')) {
    const a = boxes.get(path.dataset.from), b = boxes.get(path.dataset.to);
    if (!a || !b) { path.removeAttribute('d'); continue; }
    const x1 = a.right - base.left, y1 = a.top + a.height / 2 - base.top;
    const x2 = b.left - base.left - 1, y2 = b.top + b.height / 2 - base.top;
    const bend = Math.max(24, Math.abs(x2 - x1) / 2);
    path.setAttribute('d', `M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
  }
}
