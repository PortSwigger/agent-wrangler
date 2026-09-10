import { z } from 'zod';
import { reportSchema } from '../../jobs-schema.js';
const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
export const jobReportTool = {
  name: 'job_report',
  description: 'Submit the receipt for your assigned automated job run, then stop. One receipt per run: plan, jira, published (the PR url), repaired, deployed or completed. Checks are normally 1–3 bullets of a few words, e.g. "Build passed"; keep the detail in the transcript. Only the assigned session can report; identical retries are safe, and a terminal recap does not advance the job. If you cannot finish, submit {kind:"blocked", summary:"one sentence"} and optionally name the move a human should make: move:"fix-here" (a new commit on this PR), "split-out" (a second PR on this ticket), "new-ticket" (scope nobody knew about), "reorder" (this must land after something else), "drop" or "mark" (it is already done elsewhere). You never change the plan yourself; the human clicks the move.',
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
    return result({ job, run: job.runs.findLast((r) => r.sessionId === caller) });
  },
};
