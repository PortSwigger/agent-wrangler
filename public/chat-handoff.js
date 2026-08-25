// The one decision behind "go answer the prompt in the terminal, then come back".
//
// Pressing the chat view's needs-you bar (`Terminal →`) is a round trip, not a
// view change: the permission prompt only exists in the pane, so the user is
// sent there to answer it and wants to be back in the chat once it is answered.
// Nothing on the wire says "the prompt was answered", so the return is inferred
// from the session leaving `needs-you` — which is exactly what "the prompt is
// gone" looks like from outside the pane.
//
// Split out as a pure function because it is four guards that all have to hold
// at once, and getting any of them wrong yanks the view out from under someone
// (the same reason layout.js / chat-group.js / diff.js are separate leaves).
// app.js owns the armed-handoff state and the actual switching.

// `armedFor` is the card id the handoff was armed for (null when none), `selected`
// the card whose panel is open, `status` its current display status, and `view`
// the view showing right now.
export function shouldReturnToChat({ armedFor, selected, status, view }) {
  // Not armed, or armed for a session whose panel is no longer the open one:
  // arming is one-shot and belongs to one card. Returning a card the user has
  // navigated away from would switch a view they are not looking at, and would
  // then be wrong whenever they came back to it.
  if (!armedFor || armedFor !== selected) return false;
  // Already showing chat — either the user switched back by hand or a previous
  // tick already returned them. Either way there is nothing to do, and treating
  // it as pending would re-fire on every graph rebuild.
  if (view !== 'terminal') return false;
  // Still blocked: the prompt has not been answered yet, so the user is still
  // needed where they are. This is the case that holds for most of the trip.
  if (status === 'needs-you') return false;
  // A status we cannot interpret is not evidence the prompt went away. Being
  // conservative here means the failure mode is "you stay in the terminal",
  // which is merely the old behaviour, rather than "the view moved for no
  // reason you can see".
  return typeof status === 'string' && status.length > 0;
}
