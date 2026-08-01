import type { MarkKind, WorkMarks } from '#common'

import { options, withId } from '#common'

/**
 * Read and write the per-work read/favourite marks from the content script.
 *
 * The packed representation and its rationale live in
 * {@link file://./../common/workMarks.ts}; this module is just the
 * read-freshest → toggle → `options.set` shell, mirroring how
 * {@link file://./persistentFilters.ts} wraps the filter lists.
 */

/**
 * Set or clear one mark, reading the freshest options first so a change made in
 * another tab (or by the options page) isn't clobbered. A no-op write is skipped
 * — every `option.*` write wakes the sync engine and the daily-backup check.
 */
export async function setWorkMark(kind: MarkKind, id: string, value: boolean): Promise<void> {
  const marks = await options.get('workMarks')
  const next = withId(marks[kind], id, value)
  if (next === marks[kind])
    return
  await options.set({ workMarks: { ...marks, [kind]: next } })
}

/**
 * Record a work as read *synchronously*, from an already-loaded `workMarks`.
 *
 * Used on the path where AO3's own "Mark as Read" button is about to navigate
 * away: there's no time for a `storage.get` round-trip before the frame is torn
 * down, but a `storage.set` dispatched now completes in the browser process even
 * if this frame dies (only its completion callback is lost). So the new value is
 * computed from the in-memory copy and the write is fired off unawaited.
 *
 * `marks` is mutated in place so a second button press on the same page builds on
 * the first. Returns whether anything actually changed.
 */
export function recordReadNow(marks: WorkMarks, id: string): boolean {
  const next = withId(marks.read, id, true)
  if (next === marks.read)
    return false
  marks.read = next
  void options.set({ workMarks: { ...marks, read: next } })
  return true
}
