import { z } from 'zod';
import { reportSchema } from '../../jobs-schema.js';
const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
export const jobReportTool = {
  name: 'job_report',
  description: 'Submit the required planning, Jira ticketing or verification receipt for your assigned automated job run, then stop. Verification is normally 1–3 bullets of a few words, e.g. "Build passed"; omit routine housekeeping and keep pending checks explicit. Only the assigned session can report; identical retries are safe. A terminal recap does not advance the Kanban. If the approved plan is wrong in a way you can see, attach amendment:{reason, ops:[...]} to the receipt (any kind, including blocked) rather than only describing it: ops are add-sub-job{spec}, add-dependency/remove-dependency{subJobId,dependsOn}, set-deployment{subJobId,deployment|null}, set-pending-checks{subJobId,pendingChecks}, set-instructions{subJobId,instructions}, set-recovered-by{subJobId,fixSubJobId}. It is validated against the live plan (an invalid one fails the whole report with the reason) and, unless the job auto-applies it, waits for the human as a one-click fix.',
  inputSchema: { runId: z.string(), report: reportSchema },
  async handler({ deps, caller }, { runId, report }) {
    try {
      const job = deps.jobStore.report(caller, runId, report);
      await deps.rebuild?.();
      return result({ accepted: true, jobId: job.id, next: 'Stop now. Wrangler coordinates the next step.' });
    } catch (e) { return { content: [{ type: 'text', text: e.message }], isError: true }; }
  },
};
export const getJobContextTool = {
  name: 'get_job_context',
  description: 'Get the current automated job, approved plan and run assigned to your own session. No other session or job can be selected.',
  inputSchema: {},
  async handler({ deps, caller }) {
    const job = deps.jobStore?.snapshot().jobs.find((j) => j.runs.some((r) => r.sessionId === caller));
    if (!job || !caller) return result({ job: null });
    // Pending amendments and the job's authority tell an agent whether a proposal
    // of its own would apply on the spot or wait for the human.
    return result({ job, run: job.runs.findLast((r) => r.sessionId === caller),
      amendmentAuthority: job.amendmentAuthority ?? 'review', pendingAmendments: (job.amendments || []).filter((a) => a.status === 'proposed') });
  },
};
