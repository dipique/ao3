import type { Options, WorkProgress } from '#common'
import type { Work } from '#content_script/blurb.js'

import {
  localMarkIds,
  markGroup,
  markItems,
  markProgress,
  markTracksProgress,
  READ_MARK,
  readiness,
  READINESS_LABELS,
  SAVED_MARK,
  todayEpochDays,
} from '#common'
import { markedForLaterIds } from '#content_script/markedForLaterIndex.js'

/**
 * The Status value for a work carrying no verdict — nothing in the `read`
 * trigger group. Its own value rather than an absence, so it can be included
 * ("only what I haven't read") and excluded ("only what I have") like any other.
 */
export const UNREAD = 'Unread'

/**
 * Stamp each work with its Status facet values — everything the reader has (or
 * hasn't) done with it, as opposed to anything the blurb says about the work
 * itself. Four kinds of value, all in one group because they're all answers to
 * the same question, "where am I with this one?":
 *
 * - **every mark it carries**, by the mark's own label ("Read", "Favorite",
 *   "Ongoing", …), so a renamed or added mark needs nothing here;
 * - **Unread**, when it carries no mark from the `read` trigger group at all —
 *   the complement of the above, and the one value you can't get by excluding,
 *   since "not Favorite" includes every other verdict;
 * - **Ready / Waiting / Caught up**, how ready it is to be read *on*
 *   ({@link file://../../common/workProgress.ts});
 * - **Marked for later**, when the cached index says it's on that list.
 *
 * Readiness is only stamped where it means something: on an ongoing work, which
 * is what the states are about, and on a work with no verdict yet, which is
 * ready by definition. A work already read is neither ready nor caught up — it's
 * done, and the mark that says so is the value it carries instead.
 *
 * A post-pass rather than something `parseWork` does, for two reasons that both
 * come down to the same thing — none of this is a property of the blurb. The
 * parser has no options access, and the snapshot cache re-runs it over
 * yesterday's stored HTML, so a value baked in there would still say "waiting"
 * on the morning the wait-until date came round. Hosts call this on every load
 * (cached or fresh), which also re-reads today's date — a background refresh can
 * outlive midnight on a tab left open.
 */
export function applyStatus(works: Work[], options: Options): void {
  const { workMarks } = options
  // With marks off there is nothing to say: the facet simply doesn't appear.
  if (!workMarks.enabled)
    return
  const { marks } = workMarks

  // Unpack each mark's id set (and the progress payload of the one that has one)
  // once for the whole run, rather than per work.
  const carriers = localMarkIds(marks).map(id => ({
    id,
    label: marks[id]?.label || id,
    items: markItems(marks, id),
    progress: markTracksProgress(marks, id) ? markProgress(marks, id) : null,
  }))
  // "Done with it" is the trigger group, not the `read` mark alone — a work
  // called `gross` has a verdict just as much as one called `read`.
  const readGroup = new Set(markGroup(marks, READ_MARK))
  const savedLabel = marks[SAVED_MARK]?.label
  // A cache, and one that only says who *is* saved — a work missing from it is
  // unknown, never "not saved" — so it contributes a value and never withholds
  // one. Null until some unit has read it this run (see the module's own notes).
  const saved = savedLabel ? markedForLaterIds() : null
  const today = todayEpochDays()

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
    if (!verdict)
      values.push(UNREAD)
    if (savedLabel && saved?.has(work.workId))
      values.push(savedLabel)
    // No work on AO3 has zero chapters, so a zero here means the count wasn't
    // there to read — which readiness() takes as null and fails open on.
    if (progress || !verdict)
      values.push(READINESS_LABELS[readiness(progress, work.chapters.written || null, today)])
    work.statuses = values
  }
}
