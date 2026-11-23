import type { MarkConfig, MarkId } from './workMarks.ts'

import { markGroup, READ_MARK } from './workMarks.ts'

/**
 * What one write of the Marked for Later index changed, work by work: `true`
 * for a work that came onto it, `false` for one that went off. A tab reading
 * another tab's write learns from this which of the works it shows were saved
 * or cleared there.
 */
export function savedIndexChanges(before: ReadonlySet<string>, after: ReadonlySet<string>): Map<string, boolean> {
  const changes = new Map<string, boolean>()
  for (const id of after) {
    if (!before.has(id))
      changes.set(id, true)
  }
  for (const id of before) {
    if (!after.has(id))
      changes.set(id, false)
  }
  return changes
}

/**
 * Why a request to take a work off Marked for Later couldn't be made from an
 * AO3 tab, for a reader to act on: there was no AO3 page to make it from, or
 * none of them answered.
 */
export const NO_ARCHIVE_TAB = {
  none: 'the request has to come from an AO3 page — open AO3 in a tab and import this file again',
  silent: 'your AO3 tabs did not answer — reload one and import this file again',
} as const

/**
 * Why a request to take a work off Marked for Later failed when the fault is
 * AO3's rather than the request's: it answered with a server error, or nothing
 * answered at all.
 */
export const ARCHIVE_UNAVAILABLE = 'AO3 is down or could not be reached — your next import once it is back will send it'

/**
 * Whether a work's title offers the one-click Mark for later: it isn't on the
 * list, and the reader isn't done with it. Every mark in the read group counts,
 * the progress marks included — an ongoing work is kept on the list by the mark
 * itself, so offering to put it there would only be noise.
 */
export function offersMarkForLater(marks: Record<MarkId, MarkConfig>, carries: (markId: MarkId) => boolean, saved: boolean): boolean {
  return !saved && !markGroup(marks, READ_MARK).some(carries)
}
