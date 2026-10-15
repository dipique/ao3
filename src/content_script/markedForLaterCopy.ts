import type { BlurbSource } from '#common'

import { cache } from '#common'
import { parseWork } from '#content_script/blurb.js'
import { pristineBlurb, putOnSnapshot } from '#content_script/searchView/cache.ts'

/** Where the Marked for Later list of `userId` is stored, as the list's own page names them. */
export function markedForLaterKey(userId: string): string {
  return `marked-for-later:${userId}`
}

/**
 * Put a work the reader just saved for later — or found saved — first on the
 * stored copy of their Marked for Later list, with `blurb` as its blurb
 * ({@link putOnSnapshot}). The blurb may be one on the page, decorated: what is
 * stored is a pristine copy of it. Nothing is written while no copy is stored.
 *
 * First is where AO3 puts it: the list runs from the work last visited, and
 * saving a work for later counts as a visit.
 */
export async function putOnMarkedForLater(userId: string, blurb: HTMLLIElement, src: BlurbSource): Promise<void> {
  // The key as the list's own page stored it, whatever case it named the reader in.
  const wanted = markedForLaterKey(userId).toLowerCase()
  const key = Object.keys(await cache.get('searchLists')).find(stored => stored.toLowerCase() === wanted)
  if (!key)
    return
  const work = parseWork(pristineBlurb(blurb), 0)
  work.src = src
  work.seenAt = Date.now()
  await putOnSnapshot(key, [work])
}
