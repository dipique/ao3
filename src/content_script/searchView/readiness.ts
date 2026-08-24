import type { Options } from '#common'
import type { Work } from '#content_script/blurb.js'

import { findProgress, progressSources, readiness, READINESS_LABELS, todayEpochDays } from '#common'

/**
 * Stamp each work with its Readiness facet value.
 *
 * A post-pass rather than something `parseWork` does, for two reasons that both
 * come down to the same thing — readiness isn't a property of the blurb. The
 * parser has no options access, and the snapshot cache re-runs it over yesterday's
 * stored HTML, so a value baked in there would still say "waiting" on the morning
 * the wait-until date came round. Hosts call this on every load (cached or fresh),
 * which also re-reads today's date — a background refresh can outlive midnight on
 * a tab left open.
 *
 * Nothing to do when no mark tracks progress (an older device's sync can hand us
 * a table without one), in which case every work reads as Ready by default.
 */
export function applyReadiness(works: Work[], options: Options): void {
  const { workMarks } = options
  const sources = workMarks.enabled ? progressSources(workMarks.marks) : []
  if (sources.length === 0)
    return
  const today = todayEpochDays()
  for (const work of works) {
    const found = findProgress(sources, work.workId)
    if (!found)
      continue
    // No work on AO3 has zero chapters, so a zero here means the count wasn't
    // there to read — which readiness() takes as null and fails open on.
    const published = work.chapters.written || null
    work.readiness = READINESS_LABELS[readiness(found.progress, published, today)]
  }
}
