// The one decision behind "review this sub-job's code, then come back to it".
//
// The Jobs view's `Review code in Wrangler` is a round trip, not a view change:
// the diff panel only overlays the board, so the user is sent to the grid to read
// the diff and wants the job's detail dialog back the moment they close it.
// Nothing about a close says which trip it ended (every close path — button,
// Escape, the toggle, a view or selection change — funnels through the same
// teardown), so the arm carries both the card whose diff was opened and the
// job/sub it was opened from, and the two have to agree.
//
// Split out as a pure function for the same reason chat-handoff.js is: the guards
// all have to hold at once, and a wrong one moves a view the user is looking at.
// app.js owns the armed state and does the switching.

// `armed` is {sid, jobId, subId} (null when nothing is armed), `closedSid` the card
// whose diff just closed, and `jobs` the latest jobs snapshot's array. Returns null
// to stay put, else the detail to re-open — {jobId, subId} — or a null `jobId` for
// "back to the Jobs view, but with no dialog".
export function diffReturnTarget({ armed, closedSid, jobs }) {
  // Nothing armed, or the diff that closed isn't the one the trip was for: another
  // session's diff is another review, and returning off it would yank away a view
  // the user never came to the board from Jobs for.
  if (!armed || !armed.sid || armed.sid !== closedSid) return null;
  const job = (jobs || []).find((j) => j.id === armed.jobId);
  const sub = armed.subId ? job?.subJobs?.find((s) => s.id === armed.subId) : null;
  // The job or sub-job can be gone by the time a review ends — cancelled, or the
  // whole job purged. Jobs is still where the user came from, so go back there
  // without a dialog: re-opening one for a missing job renders nothing at all, and
  // for a missing SUB it silently shows the parent job's detail instead, which
  // reads as the wrong dialog rather than as an absence.
  if (!job || (armed.subId && !sub)) return { jobId: null, subId: null };
  return { jobId: armed.jobId, subId: armed.subId || '' };
}
