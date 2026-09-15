import type { Work } from '#content_script/blurb.js'
import type { Recovered, RecoverOptions } from '#content_script/searchView/workPageBlurb.tsx'

import { readStoredWorks } from '#content_script/searchView/blurbStore.ts'
import { readMisses, writeMisses } from '#content_script/searchView/cache.ts'
import { fetchWorkBlurbs } from '#content_script/searchView/workPageBlurb.tsx'

/**
 * How recently another list must have seen a work for its stored blurb to stand
 * in for the work's own page. Blurbs are shared between lists, so a work marked
 * read off Marked for Later usually has one already; a month-old copy is as good
 * as anything a list refresh would bring, and far cheaper than a request each.
 */
const STORED_BLURB_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

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
 * Before any of that, the shared blurb store is asked: a work another stored
 * list holds — Marked for Later, a tag search — has its blurb already, and a
 * recent one saves a request to AO3.
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
  const stored = lost.length ? await readStoredWorks(lost, STORED_BLURB_MAX_AGE_MS) : []
  const known = new Set(stored.map(work => work.workId))
  const unknown = lost.filter(id => !known.has(id))
  const fetched = unknown.length
    ? await fetchWorkBlurbs(unknown, opts)
    : { works: [], failed: [], blocked: false }
  const result = { ...fetched, works: [...stored, ...fetched.works] }

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
