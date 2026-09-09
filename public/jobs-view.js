import { esc, tildify } from './util.js';
import { JOB_COLUMNS, SESSION_COLUMNS, jobCostLabel, JOB_COST_TITLE, SUB_COST_TITLE, storyLabel, isSessionSub, hasSessionSubs, kindChipHtml, kindCountLabel, dependencySatisfied, sessionReviewLabel, jobCards, jobCardHtml, jobBoardHeaderHtml, jobNeedsReview, jobStatus, receiptHtml, cancelledDependencies, commentVerdict, redComments, mergeHeldByComments, COMMENT_TONE_LABEL } from './jobs.js';
import { planGraphHtml, layoutGraphEdges } from './job-graph.js';
const checkTone = (state) => ['SUCCESS', 'NEUTRAL', 'SKIPPED', 'passing'].includes(state) ? 'passed' : ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'failing'].includes(state) ? 'failed' : '';
const checkMark = (state) => checkTone(state) === 'passed' ? '✓' : checkTone(state) === 'failed' ? '×' : '○';
const link = (url, title) => /^https:\/\/github\.com\//.test(url || '') ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(title)} ↗</a>` : esc(title);
const commentWhere = (c) => c.kind === 'review' ? `review · ${c.state.toLowerCase().replace('_', ' ')}` : c.kind === 'thread' ? `${c.path || 'thread'}${c.line != null ? `:${c.line}` : ''}${c.outdated ? ' · outdated' : ''}${c.resolved ? ' · resolved' : ''}` : 'comment';
// Comment text is written by reviewers and bots: escaped, never trusted HTML.
// A body is only rendered once asked for — a long review thread otherwise buries
// the verdict and the actions under it — and the expanded keys are passed in from
// the view's own state rather than read back off this markup, which is rebuilt
// from scratch on every graph tick and would snap a just-opened comment shut.
function commentsHtml(sub, shown) {
  const c = sub.prComments;
  if (!c) return '';
  const verdict = commentVerdict(sub);
  const summary = verdict === undefined ? '<p class="job-comments-none">No comments yet</p>'
    : verdict === null ? '<div class="job-comment-summary pending">Summarising comments…</div>'
      : `<div class="job-comment-summary ${esc(verdict.tone)}"><b>${esc(COMMENT_TONE_LABEL[verdict.tone])}</b> ${esc(verdict.text)}</div>`;
  return `<h3>PR comments <small>${c.items.length}${c.unresolved ? ` · ${c.unresolved} unresolved thread${c.unresolved === 1 ? '' : 's'}` : ''}${c.truncated ? ` · ${c.truncated} older not shown` : ''}</small></h3>${summary}
    ${c.items.length ? `<ul class="job-comments">${c.items.map((i) => {
    const key = i.id || i.url;
    const open = shown.has(key);
    return `<li class="${i.resolved ? 'resolved' : ''}"><span class="job-comment-meta">${esc(i.author)}${i.bot ? ' (bot)' : ''} · ${esc(commentWhere(i))} ${link(i.url, 'view')}</span><button class="job-comment-toggle" data-comment-toggle="${esc(key)}" aria-expanded="${open}">${open ? 'Hide' : 'Show comment'}</button>${open ? `<p>${esc(i.body)}</p>` : ''}</li>`;
  }).join('')}</ul>` : ''}`;
}

export function initJobsView({ send, getAgents, onSession, onDiff, onBoard }) {
  const root = document.getElementById('jobs');
  const dialog = document.getElementById('job-dialog');
  let data = { jobs: [], settings: { concurrency: 2, maxRepairs: 2, maxRunMinutes: 120 } };
  let filter = '', needsOnly = false, showDone = false, selected = null, planDraft = null, revision = null;
  const commentsShown = new Set();
  // Which boxes in the plan graph have their dependency editor open: a dependency
  // change redraws the whole graph (the box moves wave), so the open state has to
  // outlive the markup or the editor snaps shut under the pointer.
  const openDeps = new Set();
  root.innerHTML = `<header class="jobs-header"><div><span class="jobs-kicker">AUTOMATED WORK</span><h1>Jobs</h1><p>From intent to deployed. Your decisions, at a glance.</p></div><button class="primary" id="job-new">＋ New job</button></header>
    <div class="jobs-toolbar"><label>Agents at once <input id="jobs-concurrency" type="number" min="1" max="16" value="2"></label><button id="jobs-pause">Pause new work</button><button id="jobs-settings">Automation settings</button><span class="jobs-cost-note">Pipeline watching uses no agents</span></div>
    <div class="jobs-filters"><select id="jobs-filter" aria-label="Show one job"><option value="">Every job</option></select><label><input id="jobs-needs" type="checkbox"> Needs me <span id="jobs-review-count">0</span></label><label><input id="jobs-done" type="checkbox"> Show delivered</label><span id="jobs-active-count" aria-live="polite"></span></div>
    <div id="jobs-boards" class="jobs-boards"></div>`;
  const q = (s) => root.querySelector(s);
  function update(snapshot) { data = snapshot || data; render(); }
  // One board per job: a job's sub-jobs only ever share columns with each other.
  // A job whose plan includes agent sessions gets a second lane of columns for
  // them beneath the PR lane; a PR-only job looks exactly as before.
  function columnsHtml(spec, cards) {
    return spec.map(([stage, title, note], i) => {
      const column = cards.filter((c) => c.stage === stage);
      return `<section class="job-column" aria-label="${esc(title)}"><header><span class="job-column-number">0${i + 1}</span><h2>${esc(title)}</h2><span class="job-column-count">${column.length}</span></header><p>${esc(note)}</p><div class="job-column-cards">${column.map(jobCardHtml).join('') || '<div class="job-empty job-empty-quiet" aria-hidden="true"></div>'}</div></section>`;
    }).join('');
  }
  function boardHtml(job, cards) {
    const split = hasSessionSubs(job);
    const lanes = `${split ? '<h3 class="job-board-lane">Pull requests</h3>' : ''}<div class="job-board-columns">${columnsHtml(JOB_COLUMNS, cards.filter((c) => c.board !== 'sessions'))}</div>
      ${split ? `<h3 class="job-board-lane">Agent sessions</h3><div class="job-board-columns job-board-sessions">${columnsHtml(SESSION_COLUMNS, cards.filter((c) => c.board === 'sessions'))}</div>` : ''}`;
    return `<section class="job-board" data-board="${esc(job.id)}" aria-label="${esc(job.title)}">${jobBoardHeaderHtml(job)}${lanes}</section>`;
  }
  function render() {
    const cards = jobCards(data.jobs);
    const active = data.jobs.flatMap((j) => j.runs).filter((r) => !r.stopped).length;
    q('#jobs-active-count').textContent = `${active} / ${data.settings.concurrency} agents · ${cards.filter((c) => c.sub?.stage === 'done' && !c.sub.cancelledAt).length} delivered`;
    const needsCount = cards.filter((c) => jobNeedsReview(c.job, c.sub)).length;
    q('#jobs-review-count').textContent = needsCount;
    const badge = document.getElementById('jobs-nav-badge');
    if (badge) { badge.textContent = needsCount; badge.hidden = !needsCount; }
    if (document.activeElement !== q('#jobs-concurrency')) q('#jobs-concurrency').value = data.settings.concurrency;
    q('#jobs-pause').textContent = data.settings.paused ? 'Resume automation' : 'Pause new work';
    q('#jobs-filter').innerHTML = `<option value="">Every job</option>${data.jobs.map((j) => `<option value="${esc(j.id)}" ${filter === j.id ? 'selected' : ''}>${esc(j.title)}</option>`).join('')}`;
    const visible = cards.filter((c) => (!filter || c.job.id === filter) && (!needsOnly || jobNeedsReview(c.job, c.sub)) && (showDone || c.sub?.stage !== 'done'));
    // A delivered job's board only returns with Show delivered; a board every filter emptied is dropped rather than drawn blank.
    const boards = data.jobs.filter((j) => (!filter || j.id === filter) && (showDone || j.stage !== 'done')).map((j) => [j, visible.filter((c) => c.job === j)]).filter(([, c]) => c.length);
    const empty = !data.jobs.length ? 'Start with an outcome.<br>Wrangler will shape the work.' : needsOnly ? 'Nothing needs you right now.' : 'No jobs match these filters.';
    q('#jobs-boards').innerHTML = boards.map(([job, c]) => boardHtml(job, c)).join('') || `<div class="job-empty jobs-empty">${empty}</div>`;
    // Keep a human's plan edits and review snapshot intact across live graph ticks.
    if (dialog.open && selected && !planDraft && !dialog.contains(document.activeElement?.closest('input, textarea, select'))) renderDetail();
  }
  function show(html) {
    dialog.innerHTML = `<button class="job-dialog-close" aria-label="Close">×</button>${html}`;
    dialog.querySelector('.job-dialog-close').onclick = () => dialog.close();
    if (!dialog.open) dialog.showModal();
  }
  function action(name, extra = {}) {
    send({ type: 'job-action', id: selected.jobId, subJobId: selected.subId || undefined, action: name, ...extra });
  }
  function openDetail(jobId, subId) {
    selected = { jobId, subId }; planDraft = null; revision = null; commentsShown.clear(); openDeps.clear();
    const job = data.jobs.find((j) => j.id === jobId);
    if (!subId && job?.stage === 'planning' && job.plan) { planDraft = structuredClone(job.plan); revision = job.revision; }
    renderDetail();
  }
  // Arrows follow the boxes' rendered rectangles, so anything that can move a box
  // (a dependency editor opening, the dialog resizing) re-traces them.
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layoutGraphEdges(dialog.querySelector('.job-graph'))) : null;
  function wireGraph() {
    const graph = dialog.querySelector('.job-graph');
    observer?.disconnect();
    if (!graph) return;
    graph.querySelectorAll('[data-title]').forEach((e) => e.oninput = () => { planDraft.subJobs[+e.dataset.title].title = e.value; });
    // A blanked branch is absent, not '': the schema's optional field rejects an
    // empty string, and absent means "use the dispatch-time placeholder".
    graph.querySelectorAll('[data-branch]').forEach((e) => e.oninput = () => { const s = planDraft.subJobs[+e.dataset.branch]; if (e.value.trim()) s.branch = e.value.trim(); else delete s.branch; });
    graph.querySelectorAll('details[data-deps]').forEach((d) => d.ontoggle = () => { if (d.open) openDeps.add(d.dataset.deps); else openDeps.delete(d.dataset.deps); layoutGraphEdges(graph); });
    // A dependency change can move the box to another wave, so the graph is redrawn
    // from the draft rather than patched; the changed checkbox keeps focus.
    graph.querySelectorAll('[data-dep]').forEach((e) => e.onchange = () => {
      const s = planDraft.subJobs[+e.dataset.dep]; s.dependsOn = e.checked ? [...s.dependsOn, e.value] : s.dependsOn.filter((d) => d !== e.value);
      graph.outerHTML = planGraphHtml(planDraft, { editable: true, openDeps });
      wireGraph();
      [...dialog.querySelectorAll(`[data-dep="${e.dataset.dep}"]`)].find((c) => c.value === e.value)?.focus();
    });
    observer?.observe(graph.querySelector('.job-graph-canvas'));
    layoutGraphEdges(graph);
  }
  function renderDetail() {
    const job = data.jobs.find((j) => j.id === selected?.jobId);
    if (!job) return;
    const sub = job.subJobs.find((s) => s.id === selected.subId);
    const status = jobStatus(job, sub);
    if (!sub && !planDraft && job.stage === 'planning' && job.plan) { planDraft = structuredClone(job.plan); revision = job.revision; }
    let body = '';
    if (planDraft) {
      const sessions = planDraft.subJobs.some(isSessionSub);
      const newStories = planDraft.stories.filter((s) => !s.key).length;
      body = `<h3>Business value <small>${newStories ? `${newStories} new Jira stor${newStories === 1 ? 'y' : 'ies'} · created only after you approve` : 'Existing Jira stories'}</small></h3><div class="job-stories">${planDraft.stories.map((s, i) => `<div><label><span class="job-story-key ${s.key ? '' : 'job-story-new'}">${esc(storyLabel(s))}</span><input aria-label="Story title ${i + 1}" data-story="${i}" maxlength="180" value="${esc(s.title)}"></label><p>${esc(s.value)}</p></div>`).join('')}</div>
        <h3>Landing order <small>${sessions ? 'Same wave can land independently · a PR deploys after its dependencies, a session starts after them' : 'Same wave can land independently'}</small></h3>${planGraphHtml(planDraft, { editable: true, openDeps })}
        <details class="job-more"><summary>Deployment checks & implementation detail</summary>${planDraft.subJobs.map((s) => `<h4>${esc(s.title)}</h4><p>${esc(s.instructions)}</p>${isSessionSub(s) ? '<p>Runs as an agent session in a scratch workspace; no PR.</p>' : `<p>Deployment: ${esc(s.deployment.workflows.join(', '))}</p><p>${esc(s.deployment.verify)}</p>`}`).join('')}</details>
        <p class="job-authority">${newStories ? `Approve creates the ${newStories === 1 ? 'new Jira story' : `${newStories} new Jira stories`} with these titles, then starts` : 'Approve starts'} local work in dedicated worktrees. ${job.reviewCode ? 'Code review is on.' : 'Verified work will publish automatically.'} ${job.reviewMerge ? 'You approve each merge.' : 'Green PRs merge automatically.'}${sessions ? ((job.reviewSessions ?? true) ? ' You approve each agent session’s result.' : ' Agent sessions count as done once they report.') : ''}</p>
        <div class="job-actions"><button class="primary" data-action="approve-plan" ${job.runs.some((r) => !r.stopped) ? 'disabled' : ''}>Approve ${planDraft.subJobs.length} sub-job${planDraft.subJobs.length === 1 ? '' : 's'}</button><button id="job-refine">Request changes</button></div>`;
    } else if (sub && isSessionSub(sub)) {
      const deps = sub.dependsOn.map((id) => job.subJobs.find((s) => s.id === id));
      body = `<p class="job-detail-meta">${kindChipHtml(sub)} ${esc(sub.jiraKey)} · Agent session on this machine</p>${deps.length ? `<div class="job-dependency-list">${deps.map((d) => `<span>${dependencySatisfied(d) ? '✓' : d?.cancelledAt ? '×' : '↳'} After ${esc(d?.title)}${d?.cancelledAt ? ' (cancelled)' : ''}</span>`).join('')}</div>` : ''}
        ${sub.cancelledAt ? '<p class="job-authority">Cancelled. Its session is archived; nothing on disk is removed.</p>' : ''}
        ${!sub.cancelledAt && sub.stage !== 'done' && cancelledDependencies(job, sub).length ? '<p class="job-authority">A dependency was cancelled, so this session can never start. Cancel it too, or start a new job for the remaining work.</p>' : ''}
        ${sub.feedback && !sub.result ? `<h3>Requested changes</h3><p>${esc(sub.feedback)}</p>` : ''}
        ${sub.result ? `<h3>Reported</h3>${receiptHtml(sub.result.checks)}` : ''}
        ${sub.stage === 'review' ? '<p class="job-authority">Approving marks the session done and lets the work depending on it start.</p>' : ''}
        <div class="job-actions">${sub.stage === 'review' && !sub.error ? '<button class="primary" data-action="approve-session">Approve</button><button id="job-revise-session">Request changes</button>' : ''}${sub.sessions.length ? `<button id="job-session">${onBoard(sub.sessions.at(-1)) ? 'Open session' : 'Restore session'}</button>` : ''}</div>
        <details class="job-more"><summary>Instructions</summary><p>${esc(sub.instructions)}</p></details>`;
    } else if (sub) {
      const deps = sub.dependsOn.map((id) => job.subJobs.find((s) => s.id === id));
      body = `<p class="job-detail-meta">${kindChipHtml(sub)} ${esc(sub.jiraKey)} · ${esc(tildify(sub.repo))}${sub.branch ? ` · <span class="job-plan-branch" title="Branch">${esc(sub.branch)}</span>` : ''}</p>${deps.length ? `<div class="job-dependency-list">${deps.map((d) => `<span>${dependencySatisfied(d) ? '✓' : d?.cancelledAt ? '×' : '↳'} ${isSessionSub(d) ? 'Start after' : 'Deploy after'} ${esc(d?.title)}${d?.cancelledAt ? ' (cancelled)' : ''}</span>`).join('')}</div>` : ''}
        ${sub.cancelledAt ? '<p class="job-authority">Cancelled. Nothing was merged. Cleanup archives its sessions and removes the worktree only if every commit is already on GitHub or the branch is unchanged.</p>' : ''}
        ${!sub.cancelledAt && sub.stage !== 'done' && cancelledDependencies(job, sub).length ? '<p class="job-authority">A dependency was cancelled, so this sub-job can never publish. Cancel it too, or start a new job for the remaining work.</p>' : ''}
        ${sub.local ? `<h3>Commit message proposition</h3><p class="job-commit">${esc(sub.local.commitMessage)}</p><h3>Verified</h3>${receiptHtml(sub.local.checks)}` : ''}
        ${sub.stage === 'implementation' && sub.local?.pendingChecks?.length ? `<h3>Still required in PR checks</h3><ul class="job-checks">${sub.local.pendingChecks.map((c) => `<li>○ ${esc(c)}</li>`).join('')}</ul>` : ''}
        ${sub.pr ? `<h3>${link(sub.pr.url, 'Pull request')}</h3><div class="job-pipeline-status ${checkTone(sub.pr.checkStatus)}">${esc(sub.pr.checkStatus)}${sub.pr.head ? ` · ${esc(sub.pr.head.slice(0, 8))}` : ''}</div>${sub.pr.checks?.length ? `<ul class="job-checks">${sub.pr.checks.map((c) => `<li class="${checkTone(c.state)}">${checkMark(c.state)} ${esc(c.name)} <small>${esc(c.state.toLowerCase())}</small></li>`).join('')}</ul>` : ''}` : ''}
        ${sub.pr ? commentsHtml(sub, commentsShown) : ''}
        ${mergeHeldByComments(job, sub) ? '<p class="job-authority">Comments read as blocking, so the automatic merge is on hold. Approve merge to override for this head.</p>' : ''}
        ${sub.stage === 'pr' && sub.pr?.mergeWithAdmin ? '<p class="job-authority">Checks have passed. Merging will override GitHub’s required review.</p>' : ''}
        ${sub.repairs.length ? `<h3>Changes after failed checks</h3>${sub.repairs.map((r, i) => `<div class="job-repair"><b>Repair ${i + 1}</b>${receiptHtml(r.changes)}<details><summary>Re-verified</summary>${receiptHtml(r.checks)}</details></div>`).join('')}` : ''}
        ${sub.deploymentResult ? `<h3>Deployment pipelines</h3><ul class="job-checks">${sub.deploymentResult.runs.map((r) => `<li class="${checkTone(r.status)}">${checkMark(r.status)} ${link(r.url, r.workflow)} <small>${esc(r.status)}</small></li>`).join('')}</ul>` : ''}
        ${sub.deployed ? `<h3>Verified live</h3>${receiptHtml(sub.deployed.checks)}` : ''}
        ${sub.recoveryJobId ? `<h3>Deployment failed</h3><p>${esc(sub.recoveryReason || '')}</p><p class="job-authority">The merged change stays deployed. A separate recovery job proposes the fix and waits for your approval.</p><button id="job-recovery">Review recovery job</button>` : ''}
        ${sub.observationError ? `<p class="job-error">${esc(sub.observationError)} · Retrying automatically</p>` : ''}
        <div class="job-actions">${sub.stage === 'implementation' && sub.local && job.reviewCode && !sub.codeApprovedAt && sub.dependenciesVerified ? '<button class="primary" data-action="approve-code">Approve code</button>' : ''}${sub.stage === 'pr' && sub.pr?.checkStatus === 'passing' && (job.reviewMerge || redComments(sub)) && sub.mergeApprovedHead !== sub.pr.head ? '<button class="primary" data-action="approve-merge">Approve merge</button>' : ''}${sub.stage === 'implementation' && sub.local ? '<button id="job-revise">Request code changes</button>' : ''}${sub.worktree && sub.stage !== 'done' ? '<button id="job-diff">Review code in Wrangler</button>' : ''}${sub.sessions.length ? `<button id="job-session">${onBoard(sub.sessions.at(-1)) ? 'Open session' : 'Restore session'}</button>` : ''}</div>
        <details class="job-more"><summary>Worktree & instructions</summary><code>${esc(sub.worktree?.path || 'Worktree created on dispatch')}</code><p>${esc(sub.instructions)}</p><p>${esc(sub.deployment.verify)}</p></details>`;
    } else body = `<p class="job-intent">${esc(job.intent)}</p><p>${job.repos.length ? job.repos.map((r) => esc(tildify(r))).join('<br>') : 'Wrangler will discover the repositories needed during planning.'}</p>${job.stage === 'backlog' ? `<p class="job-authority">Planning proposes Jira story titles without touching Jira. You review the plan before tickets are created or implementation begins.</p><button class="primary" data-action="start">${job.recoveryOf ? 'Approve recovery planning' : 'Start planning'}</button>` : job.stage === 'jira' ? `<h3>Approved stories</h3><div class="job-stories">${job.plan.stories.map((s) => `<div><b>${esc(storyLabel(s))} · ${esc(s.title)}</b><p>${esc(s.value)}</p></div>`).join('')}</div><p class="job-authority">Creating the approved Jira stories. Implementation starts once every story has a key.</p><h3>Approved work</h3>${planGraphHtml(job.plan)}` : job.stage === 'active' || job.stage === 'done' ? `<h3>Sub-jobs <small>${esc(kindCountLabel(job.subJobs))}</small></h3>${planGraphHtml({ subJobs: job.subJobs, stories: job.plan?.stories }, { statusOf: (s) => jobStatus(job, s) })}` : '<p>Wrangler will bring the plan here for review.</p>'}`;
    // The board's number, restated where the decision is actually taken — and on a
    // sub-job the job total beside it, so a step's price always reads against the whole.
    const subCost = sub ? jobCostLabel(sub.usd, sub.usdEstimated) : '';
    const jobCost = jobCostLabel(job.usd, job.usdEstimated);
    const costs = [subCost ? `<span class="job-detail-cost" title="${esc(SUB_COST_TITLE)}">${esc(subCost)} this sub-job</span>` : '',
      jobCost ? `<span class="job-detail-cost" title="${esc(JOB_COST_TITLE)}">${esc(jobCost)} job total</span>` : ''].filter(Boolean).join('');
    show(`<span class="jobs-kicker">${esc(sub ? job.title : 'JOB')}</span><h2>${esc(sub?.title || job.title)}</h2><span class="job-status ${status.tone}"><i></i>${esc(status.text)}</span>${costs}
      ${(sub?.error || job.error) ? `<p class="job-error">${esc(sub?.error || job.error)}</p><button data-action="retry">Retry</button>` : ''}${body}
      <footer class="job-detail-footer"><span class="job-footer-actions"><button data-action="${job.paused ? 'resume' : 'pause'}">${job.paused ? 'Resume job' : 'Pause new work for this job'}</button>${sub && sub.stage !== 'cleanup' && sub.stage !== 'done' ? '<button class="danger" id="job-cancel">Cancel sub-job</button>' : ''}</span><span>${job.reviewCode ? 'Code review on' : 'Code review off'} · ${job.reviewMerge ? 'Manual merge' : 'Automatic merge'}${hasSessionSubs(job) ? ` · ${sessionReviewLabel(job)}` : ''}</span></footer>`);
    dialog.querySelectorAll('[data-action]').forEach((b) => b.onclick = () => {
      const name = b.dataset.action;
      action(name, name === 'approve-plan' ? { plan: planDraft, revision }
        : name === 'retry' ? { subJobId: sub?.error ? sub.id : undefined }
          : { head: sub?.pr?.head, localReceiptId: sub?.local?.receiptId, sessionReceiptId: sub?.result?.receiptId });
    });
    dialog.querySelectorAll('[data-comment-toggle]').forEach((b) => b.onclick = () => {
      const key = b.dataset.commentToggle;
      if (!commentsShown.delete(key)) commentsShown.add(key);
      renderDetail();
    });
    dialog.querySelectorAll('[data-story]').forEach((e) => e.oninput = () => { planDraft.stories[+e.dataset.story].title = e.value; });
    dialog.querySelectorAll('[data-open-sub]').forEach((b) => b.onclick = () => openDetail(job.id, b.dataset.openSub));
    wireGraph();
    const bind = (id, fn) => { const e = dialog.querySelector(id); if (e) e.onclick = fn; };
    bind('#job-refine', () => {
      show('<h2>Refine the plan</h2><form id="job-feedback"><label>What should change?<textarea name="feedback" required maxlength="8000" rows="5"></textarea></label><button class="primary">Send to planning</button></form>');
      dialog.querySelector('form').onsubmit = (e) => { e.preventDefault(); action('replan', { feedback: new FormData(e.target).get('feedback') }); };
    });
    bind('#job-revise', () => {
      show('<h2>Request code changes</h2><form><label>What should change?<textarea name="feedback" required rows="4" maxlength="8000"></textarea></label><button class="primary">Send to implementation</button></form>');
      dialog.querySelector('form').onsubmit = (e) => { e.preventDefault(); action('revise-code', { feedback: new FormData(e.target).get('feedback') }); };
    });
    bind('#job-revise-session', () => {
      show('<h2>Request changes</h2><form><label>What should change?<textarea name="feedback" required rows="4" maxlength="8000"></textarea></label><button class="primary">Send to a new session</button></form>');
      dialog.querySelector('form').onsubmit = (e) => { e.preventDefault(); action('revise-session', { feedback: new FormData(e.target).get('feedback') }); };
    });
    bind('#job-cancel', () => {
      const live = job.runs.some((r) => !r.stopped && r.subJobId === sub.id);
      show(`<h2>Cancel ${esc(sub.title)}?</h2><p>This skips straight to cleanup. ${live ? 'The running step is stopped and its receipt is ignored. ' : ''}${sub.pr ? 'The pull request stays open on GitHub for you to close. ' : ''}${isSessionSub(sub) ? 'Its session is archived; nothing on disk is removed.' : 'Sessions are archived; the worktree is removed only if its commits are already pushed or the branch is unchanged.'} Sub-jobs that ${isSessionSub(sub) ? 'start' : 'deploy'} after this one will need cancelling too.</p><div class="job-actions"><button class="danger" data-action="cancel">Cancel sub-job</button><button id="job-cancel-back">Keep working</button></div>`);
      dialog.querySelector('[data-action="cancel"]').onclick = () => action('cancel');
      dialog.querySelector('#job-cancel-back').onclick = () => renderDetail();
    });
    bind('#job-session', () => { dialog.close(); onSession(sub.sessions.at(-1)); });
    // Reviewing the code is a round trip out to the board's diff panel, so hand over
    // where the reader came FROM as well as what to show — app.js re-opens this same
    // detail via openDetail once the panel closes.
    bind('#job-diff', () => { dialog.close(); onDiff(sub.sessions[0], { jobId: job.id, subId: sub.id }); });
    bind('#job-recovery', () => openDetail(sub.recoveryJobId, ''));
  }
  function createJob() {
    selected = null; planDraft = null;
    const agents = getAgents();
    show(`<span class="jobs-kicker">START WITH THE OUTCOME</span><h2>New job</h2><form id="job-create-form"><label>Title<input name="title" required maxlength="180" placeholder="What should we deliver?"></label><label>What does success look like?<textarea name="intent" required rows="4" maxlength="16000" placeholder="Describe the value and how we’ll know it works."></textarea></label><p>Wrangler will discover the repositories needed and include them in your plan.</p><div class="job-form-row"><label>Agent<select name="agent">${agents.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('')}</select></label><label>Model<select name="model"></select></label></div><fieldset><legend>Your review points</legend><label><input type="checkbox" checked disabled> Plan: titles, repositories, proposed Jira stories & landing order (tickets are created only after you approve)</label><label><input type="checkbox" name="reviewCode"> Review local code before publication</label><label><input type="checkbox" name="reviewMerge" checked> Review green PRs before merging</label><label><input type="checkbox" name="reviewSessions" checked> Review agent-session results before they count as done</label></fieldset><details class="job-more"><summary>Planning guidance & cleanup</summary><label>Repository hints <small>Optional · one local checkout path per line. Wrangler can discover others.</small><textarea name="repos" rows="2" placeholder="Leave blank to let Wrangler find the repositories"></textarea></label><label>Extra guidance for the planning agent<textarea name="planningPrompt" rows="4" maxlength="8000" placeholder="Your reusable planning guidance…"></textarea></label><label><input type="checkbox" name="updateMain"> Fast-forward my clean main checkout after delivery</label></details><p class="job-authority">Adds to Backlog. Start planning when ready. Automated work uses dedicated worktrees and the shared concurrency limit.</p><button class="primary">Add to backlog</button></form>`);
    const form = dialog.querySelector('form');
    const setModels = () => { form.elements.model.innerHTML = (agents.find((a) => a.id === form.elements.agent.value)?.models || []).map((m) => `<option value="${esc(m.value)}" ${m.default ? 'selected' : ''}>${esc(m.label || m.value)}</option>`).join(''); };
    setModels(); form.elements.agent.onchange = setModels;
    form.onsubmit = (e) => {
      e.preventDefault(); const values = new FormData(form);
      send({ type: 'job-create', job: { title: values.get('title'), intent: values.get('intent'), repos: [...new Set(values.get('repos').split('\n').map((s) => s.trim()).filter(Boolean))], agent: values.get('agent'), model: values.get('model') || '', planningPrompt: values.get('planningPrompt'), reviewCode: values.has('reviewCode'), reviewMerge: values.has('reviewMerge'), reviewSessions: values.has('reviewSessions'), updateMain: values.has('updateMain') } });
    };
  }
  q('#job-new').onclick = createJob;
  q('#jobs-concurrency').onchange = (e) => send({ type: 'job-settings', patch: { concurrency: Number(e.target.value) } });
  q('#jobs-pause').onclick = () => send({ type: 'job-settings', patch: { paused: !data.settings.paused } });
  q('#jobs-filter').onchange = (e) => { filter = e.target.value; render(); };
  q('#jobs-needs').onchange = (e) => { needsOnly = e.target.checked; render(); };
  q('#jobs-done').onchange = (e) => { showDone = e.target.checked; render(); };
  q('#jobs-boards').onclick = (e) => {
    const pause = e.target.closest('[data-pause]');
    if (pause) { send({ type: 'job-action', id: pause.dataset.pause, action: pause.dataset.paused ? 'resume' : 'pause' }); return; }
    const card = e.target.closest('[data-job]'); if (card) openDetail(card.dataset.job, card.dataset.sub);
  };
  q('#jobs-settings').onclick = () => {
    selected = null; planDraft = null;
    show(`<h2>Automation settings</h2><form id="job-settings-form"><label>Automatic CI repair attempts per sub-job<input type="number" name="maxRepairs" min="0" max="5" required value="${data.settings.maxRepairs}"></label><label>Maximum minutes per agent step<input type="number" name="maxRunMinutes" min="5" max="480" required value="${data.settings.maxRunMinutes}"></label><p>These limits apply across all automated jobs. Waiting for pipelines, dependencies and reviews uses no agent slots. Pause prevents new steps; sessions already working finish their current step.</p><button class="primary">Save settings</button></form>`);
    dialog.querySelector('form').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); send({ type: 'job-settings', patch: { maxRepairs: +f.get('maxRepairs'), maxRunMinutes: +f.get('maxRunMinutes') } }); dialog.close(); };
  };
  dialog.addEventListener('close', () => { selected = null; planDraft = null; commentsShown.clear(); openDeps.clear(); });
  render();
  // openDetail is exposed for the return leg of the diff round trip only — it opens
  // the same dialog a board card's click does, from a job/sub id pair app.js kept.
  return { update, created: () => dialog.close(), openDetail };
}
