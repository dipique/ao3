// Deep into `src/common` rather than through `#common`: the barrel reaches
// `browser` at import time, and this module is meant to load under a plain
// `node --test`.
import type { WorkMarks, WorkProgress } from '../../common/workMarks.ts'
import type { Work } from '../blurb.ts'

import {
  localMarkIds,
  markGroup,
  markItems,
  markLabel,
  markProgress,
  markTracksProgress,
  READ_MARK,
  SAVED_MARK,
} from '../../common/workMarks.ts'
import { readiness, READINESS_LABELS } from '../../common/workProgress.ts'
import { ownStatuses, UNREAD } from './engine.ts'

/** What the Status values need beyond the works and the marks. */
export interface StatusContext {
  /**
   * The works on the Marked for Later list, as the last bulk read of it found
   * them. A cache, and one that only says who *is* saved — a work missing from
   * it is unknown, never "not saved" — so it contributes a value and never
   * withholds one. Null when nothing has read it yet.
   */
  saved: ReadonlySet<string> | null
  /** The works whose text is cached; null when that isn't known. */
  cached: ReadonlySet<string> | null
  /** Today, in epoch days, for the wait-until dates. */
  today: number
}

/**
 * Stamp each work with its Status facet values ({@link Work.statuses}). Two
 * kinds of value share the group:
 *
 * - **What the reader has done with it**, when marks are on:
 *   - every mark it carries, by the mark's own label ("Read", "Favorite",
 *     "Ongoing", …), so a renamed or added mark needs nothing here;
 *   - **Unread**, when it carries no mark from the `read` trigger group at all —
 *     the complement of the above, and the one value you can't get by
 *     excluding, since "not Favorite" includes every other verdict;
 *   - **Ready / Waiting / Caught up**, how ready it is to be read *on*
 *     ({@link file://../../common/workProgress.ts}) — Ready only for a complete
 *     work;
 *   - **Marked for later**, when the saved index says it's on that list.
 * - **What state the work is in**, marks or no marks ({@link ownStatuses}):
 *   **Work in Progress**, **Cached** (its text) and **Deleted** (from AO3).
 *
 * Readiness is only stamped where it means something: on an ongoing work, which
 * is what the states are about, and on a work with no verdict yet, which is
 * ready by definition. A work already read is neither ready nor caught up — it's
 * done, and the mark that says so is the value it carries instead. With marks
 * off, a complete work is Ready, as an unread one is with them on.
 *
 * Every mark is a Status value rather than a group of its own on purpose. A
 * separate Marks group would repeat the marks with nothing beside them — and
 * what sits beside them here is the point: on the read list, where every work
 * has a verdict, a "Marked for later" value showing up among them is a work the
 * extension calls read and AO3 still has saved, which is a desync worth seeing.
 */
export function stampStatuses(works: Work[], workMarks: Pick<WorkMarks, 'enabled' | 'marks'>, ctx: StatusContext): void {
  const { marks } = workMarks
  // Unpack each mark's id set (and the progress payload of the one that has one)
  // once for the whole run, rather than per work.
  const carriers = workMarks.enabled
    ? localMarkIds(marks).map(id => ({
        id,
        label: markLabel(marks, id),
        items: markItems(marks, id),
        progress: markTracksProgress(marks, id) ? markProgress(marks, id) : null,
      }))
    : []
  // "Done with it" is the trigger group, not the `read` mark alone — a work
  // called `gross` has a verdict just as much as one called `read`.
  const readGroup = new Set(markGroup(marks, READ_MARK))
  const savedLabel = workMarks.enabled ? marks[SAVED_MARK]?.label : undefined

  for (const work of works) {
    const values: string[] = []
    let verdict = false
    let progress: WorkProgress | undefined
    for (const mark of carriers) {
      if (!mark.items.has(work.workId))
        continue
      values.push(mark.label)
      if (readGroup.has(mark.id))
        verdict = true
      progress ??= mark.progress?.get(work.workId)
    }
    if (workMarks.enabled && !verdict)
      values.push(UNREAD)
    if (savedLabel && ctx.saved?.has(work.workId))
      values.push(savedLabel)
    if (progress || !verdict) {
      // No work on AO3 has zero chapters, so a zero here means the count wasn't
      // there to read — which readiness() takes as null and fails open on.
      const state = readiness(progress, work.chapters.written || null, ctx.today)
      if (state !== 'ready' || work.complete)
        values.push(READINESS_LABELS[state])
    }
    values.push(...ownStatuses(work, !!ctx.cached?.has(work.workId)))
    work.statuses = values
  }
}
