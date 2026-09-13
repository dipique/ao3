import type { Work } from '#content_script/blurb.js'
import type { Recovered, RecoverOptions } from '#content_script/searchView/workPageBlurb.tsx'

import { readMisses, writeMisses } from '#content_script/searchView/cache.ts'
import { fetchWorkBlurbs } from '#content_script/searchView/workPageBlurb.tsx'

/**
 * Fetch, from their own pages, the read works a history scrape didn't turn up,
 * and keep the record of which ones can't be had at all.
 *
 * The read list's works are the reader's marks and its listing is their AO3
 * history, but plenty of read works are in no history: marked from a listing
 * without being opened, or read before a history was cleared. For each of those
 * the work page is the next place to look, and only a work whose own page fails
 * — deleted, or locked away from this reader — is recorded as missing
 * (`searchMisses`), so that an automatic reload stops asking for it.
 *
 * Shared by the live view and the stored-list refresh behind the site export,
 * which is why it lives outside both.
 *
 * `found` is every work the list already holds, from the scrape and from the
 * stored copy; what comes back is only the works fetched here.
 */
export async function recoverReadWorks(
  cacheKey: string,
  wanted: ReadonlySet<string>,
  found: readonly Work[],
  opts: RecoverOptions,
): Promise<Recovered> {
  const missing = await readMisses(cacheKey)
  const have = new Set(found.map(work => work.workId))
  // An automatic reload leaves known-missing works alone; one the reader asked
  // for gives them another chance, since a locked work may have been unlocked.
  const lost = [...wanted].filter(id => !have.has(id) && (opts.full || !missing.has(id)))
  const result = lost.length
    ? await fetchWorkBlurbs(lost, opts)
    : { works: [], failed: [], blocked: false }

  // Only definite answers move the record. A work found (in the history or on
  // its own page) comes off it; a work whose page failed goes on; a work that
  // wasn't reached — AO3 stopped answering, or the connection dropped — stays
  // as it was. And nothing the reader no longer counts as read stays on at all.
  const next = new Set([...missing].filter(id => wanted.has(id) && !have.has(id)))
  for (const work of result.works)
    next.delete(work.workId)
  for (const id of result.failed)
    next.add(id)
  await writeMisses(cacheKey, next)

  return { works: result.works, blocked: result.blocked }
}
