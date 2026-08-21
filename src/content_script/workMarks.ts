import type { MarkId, WorkMarks, WorkProgress } from '#common'

import { options, READ_MARK, setMark, setMarkGroup, setMarkProgress } from '#common'

/**
 * Write the per-work marks from the content script.
 *
 * The mark table, its packed id sets and the trigger-alias rules live in
 * {@link file://./../common/workMarks.ts}; this module is the write shell,
 * mirroring how {@link file://./persistentFilters.ts} wraps the rules list.
 *
 * Marks are written through these three functions and nothing else — there is
 * deliberately no general "set any field" helper, because a mark has several
 * entry points (our menu, the search view, AO3's own buttons) and a second way to
 * write one is a second behaviour waiting to drift from the first.
 *
 * The third door, {@link applyMarkProgress}, exists because a progress mark's
 * payload cannot be set through {@link applyMark} at all: membership and the
 * chapter/date it carries are one change, and splitting them into two writes
 * would leave a window where the table says the work is ongoing but not where in
 * it the reader stopped. It writes through the same {@link commit}, so the
 * identity/re-run behaviour is shared with the other two.
 *
 * All three are synchronous because the strictest caller is the one that can't await:
 * AO3's own buttons submit a form and navigate immediately, so there's no time
 * for a `storage.get` round-trip before the frame is torn down. Instead the new
 * table is computed from the already-loaded `marks` and the write is dispatched
 * unawaited — it completes in the browser process even if this frame dies, and
 * only the completion callback is lost.
 *
 * `marks` is mutated in place, so it stays true for later callers in the same
 * run — including the capture unit, which then sees a mark our menu already made
 * and skips a redundant write.
 */

/** Commit a new mark table, in place and to storage. Returns whether anything changed. */
function commit(marks: WorkMarks, next: WorkMarks['marks']): boolean {
  if (next === marks.marks)
    return false
  marks.marks = next
  void options.set({ workMarks: { ...marks, marks: next } })
  return true
}

/**
 * Set or clear one specific mark on a work — an explicit choice from our menu,
 * so it replaces whatever else in that mark's trigger group the work carried
 * (see {@link setMark}).
 */
export function applyMark(marks: WorkMarks, workId: string, markId: MarkId, on: boolean): boolean {
  return commit(marks, setMark(marks.marks, workId, markId, on))
}

/**
 * Set or clear a work's disposition at the trigger-group level — what AO3's own
 * "Mark as Read" / "Mark for Later" buttons and the search view's bulk action
 * mean, as opposed to a specific choice from our menu. A work already marked
 * with something more specific keeps it (see {@link setMarkGroup}).
 */
export function applyMarkGroup(marks: WorkMarks, workId: string, on: boolean, groupId: MarkId = READ_MARK): boolean {
  return commit(marks, setMarkGroup(marks.marks, workId, groupId, on))
}

/**
 * Mark a work as in-progress and record where the reader got to, in one write
 * (see {@link setMarkProgress}). A no-op unless `markId` actually tracks
 * progress, so a mark table synced from a device that predates the ongoing mark
 * simply does nothing rather than writing a payload nothing can read.
 */
export function applyMarkProgress(marks: WorkMarks, workId: string, markId: MarkId, entry: WorkProgress): boolean {
  return commit(marks, setMarkProgress(marks.marks, workId, markId, entry))
}
