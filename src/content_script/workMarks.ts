import type { WorkMarks } from '#common'

import { options, withId } from '#common'

/**
 * Read and write the per-work read/favourite marks from the content script.
 *
 * The packed representation and its rationale live in
 * {@link file://./../common/workMarks.ts}; this module is the write shell,
 * mirroring how {@link file://./persistentFilters.ts} wraps the filter lists.
 *
 * Read marks go through {@link applyReadMark} and nothing else — there is
 * deliberately no general "set any mark" helper, because read marks have several
 * entry points (our menu, the search view, AO3's own buttons) and a second way to
 * write one is a second behaviour waiting to drift from the first.
 */

/**
 * Set or clear a work's *favourite* mark, reading the freshest options first so a
 * change made in another tab (or by the options page) isn't clobbered. A no-op
 * write is skipped — every `option.*` write wakes the sync engine and the
 * daily-backup check.
 */
export async function setFavoriteMark(id: string, favorite: boolean): Promise<void> {
  const marks = await options.get('workMarks')
  const next = withId(marks.favorite, id, favorite)
  if (next === marks.favorite)
    return
  await options.set({ workMarks: { ...marks, favorite: next } })
}

/**
 * Set or clear a work's read mark — **the only thing that writes one**.
 *
 * Every entry point funnels through here: our menu's read action, our menu's
 * Marked-for-Later action, and AO3's own Mark as Read / Mark for Later buttons.
 * They used to record the mark in two separate places, which is exactly the kind
 * of pair that drifts the moment "mark as read" grows another side effect.
 *
 * It's synchronous because the strictest caller is the one that can't await:
 * AO3's own buttons submit a form and navigate immediately, so there's no time
 * for a `storage.get` round-trip before the frame is torn down. Instead the new
 * value is computed from the already-loaded `marks` and the write is dispatched
 * unawaited — it completes in the browser process even if this frame dies, and
 * only the completion callback is lost.
 *
 * `marks` is mutated in place, so it stays true for later callers in the same
 * run — including the capture unit, which then sees a mark our menu already made
 * and skips a redundant write. Returns whether anything actually changed.
 */
export function applyReadMark(marks: WorkMarks, id: string, read: boolean): boolean {
  const next = withId(marks.read, id, read)
  if (next === marks.read)
    return false
  marks.read = next
  void options.set({ workMarks: { ...marks, read: next } })
  return true
}
