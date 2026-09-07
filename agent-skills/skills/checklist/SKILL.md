---
name: checklist
description: Use when deciding what to put on this session's visible checklist — the short list of work-in-progress the human sees on the Agent Wrangler board. Covers when an item is worth adding, how to phrase it, when to mark it done, and why this is never synced with your own internal planning tool.
---

# Checklist

Your session has a checklist on the Agent Wrangler board, shown as its own panel
beside the terminal. Four tools read and write it:

- `add_checklist_item({ text })` — append one item, returns its `id`
- `list_checklist()` — read the current list (ids, text, done)
- `update_checklist_item({ id, done })` / `({ id, text })` — tick off or reword
- `remove_checklist_item({ id })` — drop an item that turned out to be wrong

There is no `session` parameter on any of them, and that is deliberate: they
always act on the session you are running in, so you cannot read or write
another session's checklist even if you know its card id.

## This is not your own plan, and the two are never synced

You already have a private planning tool (`TaskCreate`/`TaskUpdate` for Claude,
`update_plan` for Codex). **Keep using it exactly as you would otherwise.** It
is your scratch space: fine-grained, churny, rewritten as you learn, and only
visible inside your own terminal.

The checklist is a different artifact with a different audience — a human
glancing at the board who wants to know where this session has got to without
reading a transcript. Nothing copies between the two. Don't mirror your plan
here item-for-item, and don't try to reconcile them when they diverge; they are
*supposed* to diverge.

## When an item is worth adding

Add an item when it names **a piece of work whose completion someone else would
care about**. Aim for a handful of items over a session, not a running
commentary.

Worth adding:

- "Add the store and its unit tests"
- "Wire the new panel into the sidebar"
- "Get the full test suite green"
- "Open the PR"

Not worth adding:

- "Read `server/index.js`" — a step in your own reasoning, not a deliverable
- "Run grep for `todoRowHtml`" — tool-call granularity; this belongs in your
  private plan if anywhere
- "Continue working on the feature" — says nothing a human didn't already know

If you find yourself adding an item for every tool call, you're using the wrong
list. If the whole session is one indivisible task, one item (or none) is the
right answer — an empty checklist is a perfectly good state.

## How to phrase an item

- One short imperative phrase, ideally under ~60 characters. It renders on a
  narrow panel; a long item is truncated on screen.
- Say the outcome, not the mechanics: "Make resume carry the workflow flag",
  not "edit buildResume in session-manager.js line 412".
- One step per item. Don't pack a whole plan into one string with semicolons.

## When to mark done

Mark an item done the moment the work it names is **actually finished** —
tests passing, file written, PR open. That transition is the signal the panel
exists to show, so a checklist full of accurate-but-unticked items is worse
than no checklist.

Use `remove_checklist_item` only for an item that turned out to be unnecessary
or plain wrong. A finished item should be *ticked*, not deleted — a human
wants to see that it happened.

## The human edits the same list

This list is shared, not yours alone. The person running you can add, reword,
reorder, tick and delete items from the board at any time. Two consequences:

- **Read before you write.** Call `list_checklist()` when you need ids, and
  don't assume the list is still what you last left — an item may have been
  reworded, reordered or added by hand since.
- **Every operation is per-item on purpose.** There is no "replace the whole
  list" tool, so your write can never silently wipe an edit someone made
  seconds earlier. Change one item at a time and leave the rest alone.

An item the human added is a request: treat it as work they want done, and tick
it off the same way you would your own.

## Lifecycle

The checklist is keyed to this session's board card, so it survives a resume and
is retained (not deleted) if the session is archived — resuming brings it back.
A **fork** starts with an empty checklist: a fork is a new exploratory branch,
so nothing is copied from the parent. It is deleted only when the card itself is
permanently purged from the board.
