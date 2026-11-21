import type { TrackedKind, TrackedList } from '#common'

import { addressOf, cache, copyDateFilterAt, copyKeyOf, createLogger, defaultTitle, getArchiveLink, options, storedListRefs, trackedMeta } from '#common'
import { refreshSnapshot } from '#content_script/searchView/refresh.ts'
import { SERIES_BLURB_SELECTOR } from '#content_script/searchView/scrape.ts'
import { TAG_BLURB_SELECTOR } from '#content_script/tagPage.ts'

/**
 * A list's first offline copy, kept as it starts being tracked, so a tracked
 * list has a copy without the reader having to open it on AO3 first.
 *
 * It is read as every refresh of a tracked list's copy is: from the day the
 * list is tracked from (`copyDateFilterAt`), which for a list tracked today is
 * usually one page. It is stored under the key the list's own search view
 * keeps its copy by (`copyKeyOf`), so the page and this share one copy. A
 * list with a copy at its address already is left alone. A read that fails
 * stores nothing, and the list's row goes on offering to keep a copy from its
 * page.
 *
 * Runs wherever the list is tracked: the floating toolbar on an AO3 page, or
 * the options page. Both carry the reader's session to the archive.
 */

const log = createLogger('firstCopy')

/** Where the pages that aren't an ordinary listing list their works. */
const BLURB_SELECTORS: Partial<Record<TrackedKind, string>> = {
  'tag-works': TAG_BLURB_SELECTOR,
  'series-works': SERIES_BLURB_SELECTOR,
}

/**
 * Keep the first copy of tracked list `id`, unless one is stored at its
 * address already. `entries` are the tracked lists as just written: the list
 * among them, and the days they say its copy is read from. Whether a copy was
 * stored; never throws.
 */
export async function keepFirstCopy(entries: readonly TrackedList[], id: string): Promise<boolean> {
  const list = entries.find(one => one.id === id && one.tracked)
  const cacheKey = list && copyKeyOf(list)
  const address = list && addressOf(list.url)
  if (!list || !cacheKey || !address)
    return false
  try {
    const stored = storedListRefs(await cache.get('searchLists'))
    if (stored.some(copy => copy.key === cacheKey || addressOf(copy.listUrl) === address))
      return false
    const meta = trackedMeta(list)
    const blurbSelector = BLURB_SELECTORS[list.kind]
    const result = await refreshSnapshot({
      cacheKey,
      descriptor: {
        sourceId: list.kind,
        label: meta ? defaultTitle(meta) : list.alias,
        listUrl: getArchiveLink(list.url),
        ...(blurbSelector ? { blurbSelector } : {}),
      },
      dateFilter: copyDateFilterAt(entries, list.url),
      limit: await options.get('searchMaxResults'),
    })
    return result.written
  }
  catch (err) {
    log.warn('Could not keep the list\'s first copy.', err)
    return false
  }
}
