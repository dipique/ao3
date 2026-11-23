import type { TrackedList } from '#common'
import type { RefreshHolder } from '#content_script/searchView/listRefresh.ts'

import { addressOf, cache, copyKeyOf, createLogger, storedListRefs, utcToday } from '#common'
import { PATIENCE, WAIT_BUDGET } from '#content_script/archiveFetch.js'

import { updateTrackedCopies } from './updateCopies.ts'

/**
 * A list's first offline copy, kept as it starts being tracked, so a tracked
 * list has a copy without the reader having to open it on AO3 first.
 *
 * It is read as every tracked list's copy is, by date from the day the list
 * is tracked from ({@link updateTrackedCopies}), which for a list tracked today
 * is usually one page. It is stored under the key the list's own search view
 * keeps its copy by (`copyKeyOf`), so the page and this share one copy. A list
 * with a copy at its address already is left alone. A read that fails keeps
 * the copy saying why, and the next read tries again.
 *
 * Runs wherever the list is tracked: the floating toolbar on an AO3 page, or
 * the options page. Both carry the reader's session to the archive.
 */

const log = createLogger('firstCopy')

/**
 * Keep the first copy of tracked list `id`, unless one is stored at its
 * address already. `entries` are the tracked lists as just written: the list
 * among them, and the lists it shares its copy with. Whether the copy was
 * read; never throws.
 */
export async function keepFirstCopy(entries: readonly TrackedList[], id: string, holder: RefreshHolder = 'page'): Promise<boolean> {
  const list = entries.find(one => one.id === id && one.tracked)
  const cacheKey = list && copyKeyOf(list)
  const address = list && addressOf(list.url)
  if (!list || !cacheKey || !address)
    return false
  try {
    const stored = storedListRefs(await cache.get('searchLists'))
    if (stored.some(copy => copy.key === cacheKey || addressOf(copy.listUrl) === address))
      return false
    const outcome = await updateTrackedCopies({
      entries,
      only: [id],
      through: utcToday(),
      holder,
      patience: PATIENCE.bulk,
      waitBudget: WAIT_BUDGET.bulk,
    })
    return !outcome.blocked && !outcome.failed.includes(id) && !outcome.elsewhere.includes(id)
  }
  catch (err) {
    log.warn('Could not keep the list\'s first copy.', err)
    return false
  }
}
