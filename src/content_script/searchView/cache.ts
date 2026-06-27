import { cache } from '#common'
import { parseWork, type Work } from '#content_script/blurb.js'

/**
 * Persistent snapshot cache for aggregated listings, keyed by an arbitrary
 * source string (e.g. `marked-for-later:USERID`). Stores each work's blurb
 * `outerHTML` in `browser.storage.local` (extension-private, effectively
 * unbounded via the `unlimitedStorage` permission), so a later visit can render
 * the view instantly from cache while a fresh scrape runs in the background.
 */

/** Bump when the cached shape changes so old snapshots are ignored. */
const SNAPSHOT_VERSION = 1

export interface CachedSnapshot {
  scrapedAt: number
  works: Work[]
}

/** Read and rehydrate a cached snapshot, or null if absent/stale-shaped. */
export async function readSnapshot(key: string): Promise<CachedSnapshot | null> {
  const snapshots = await cache.get('searchSnapshots')
  const entry = snapshots[key]
  if (!entry || entry.version !== SNAPSHOT_VERSION)
    return null
  return { scrapedAt: entry.scrapedAt, works: worksFromHtml(entry.blurbsHtml) }
}

/** Persist a snapshot of the given works (their blurb HTML, in order). */
export async function writeSnapshot(key: string, works: Work[]): Promise<void> {
  const snapshots = await cache.get('searchSnapshots')
  snapshots[key] = {
    version: SNAPSHOT_VERSION,
    scrapedAt: Date.now(),
    blurbsHtml: works.map(work => work.el.outerHTML),
  }
  await cache.set({ searchSnapshots: snapshots })
}

/** Rebuild `Work[]` from cached blurb HTML, mounting fresh nodes in the document. */
export function worksFromHtml(blurbsHtml: string[]): Work[] {
  const template = document.createElement('template')
  const works: Work[] = []
  blurbsHtml.forEach((html, index) => {
    template.innerHTML = html
    const li = template.content.firstElementChild
    if (li instanceof HTMLLIElement) {
      document.adoptNode(li)
      works.push(parseWork(li, index))
    }
  })
  return works
}
