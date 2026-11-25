import type { Options } from '#common'
import type { Work } from '#content_script/blurb.js'

import { todayEpochDays } from '#common'
import { markedForLaterIds } from '#content_script/markedForLaterIndex.js'
import { cachedTextIds } from '#content_script/siteExport/cachedTextIds.js'

import { stampStatuses } from './statusValues.ts'

/**
 * Stamp each work with its Status facet values ({@link stampStatuses} says
 * which), from the saved-work index and the cached-text index as this page last
 * read them — or from `cached`, for a host that knows better which works it
 * holds the text of (a site export).
 *
 * A post-pass rather than something `parseWork` does, for two reasons that both
 * come down to the same thing — none of this is a property of the blurb. The
 * parser has no options access, and the snapshot cache re-runs it over
 * yesterday's stored HTML, so a value baked in there would still say "waiting"
 * on the morning the wait-until date came round. Hosts call this on every load
 * (cached or fresh), which also re-reads today's date — a background refresh can
 * outlive midnight on a tab left open.
 */
export function applyStatus(works: Work[], options: Options, cached: ReadonlySet<string> | null = cachedTextIds()): void {
  stampStatuses(works, options.workMarks, { saved: markedForLaterIds(), cached, today: todayEpochDays() })
}
