import type { SnapshotDescriptor } from '#common'

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
const SNAPSHOT_VERSION = 2

/**
 * Oldest version still worth reading. v1 is v2 without a
 * {@link SnapshotDescriptor} — the blurbs are identical, so it renders exactly
 * as it always did; the only thing it can't do is be refreshed from outside the
 * page it was scraped on.
 */
const MIN_SNAPSHOT_VERSION = 1

export interface CachedSnapshot {
  scrapedAt: number
  works: Work[]
  /** Absent on a v1 snapshot — see {@link MIN_SNAPSHOT_VERSION}. */
  descriptor?: SnapshotDescriptor
}

/** A snapshot's metadata, without paying to re-parse its blurbs. */
export interface SnapshotSummary {
  key: string
  scrapedAt: number
  /** Works held, from the stored blurb count. */
  count: number
  /**
   * The works' ids, in list order — one attribute match per stored blurb, not a
   * second blurb parser. The options page needs them to say how many of *this*
   * list's works are cached ({@link file://../siteExport/workTextCache.ts} keys
   * by work, not by list), and the HTML they come out of is already in hand.
   */
  workIds: string[]
  descriptor?: SnapshotDescriptor
}

/** The `id="work_123"` a blurb carries, which is where `parseWork` reads it from too. */
const BLURB_ID_RE = /\bid="work_(\d+)"/

/** Read and rehydrate a cached snapshot, or null if absent/stale-shaped. */
export async function readSnapshot(key: string): Promise<CachedSnapshot | null> {
  const snapshots = await cache.get('searchSnapshots')
  const entry = snapshots[key]
  if (!entry || entry.version < MIN_SNAPSHOT_VERSION || entry.version > SNAPSHOT_VERSION)
    return null
  return { scrapedAt: entry.scrapedAt, works: worksFromHtml(entry.blurbsHtml), descriptor: entry.descriptor }
}

/**
 * Every readable snapshot, newest first — what the options page lists. Metadata
 * only: rehydrating the blurbs of every list the reader has ever opened would
 * cost far more than the one they actually pick.
 */
export async function listSnapshots(): Promise<SnapshotSummary[]> {
  const snapshots = await cache.get('searchSnapshots')
  return Object.entries(snapshots)
    .filter(([, entry]) => entry.version >= MIN_SNAPSHOT_VERSION && entry.version <= SNAPSHOT_VERSION)
    .map(([key, entry]) => ({
      key,
      scrapedAt: entry.scrapedAt,
      count: entry.blurbsHtml.length,
      workIds: entry.blurbsHtml.map(html => BLURB_ID_RE.exec(html)?.[1]).filter((id): id is string => !!id),
      descriptor: entry.descriptor,
    }))
    .sort((a, b) => b.scrapedAt - a.scrapedAt)
}

/**
 * Every work id any stored snapshot holds, readable or not.
 *
 * The version gate {@link listSnapshots} applies is deliberately *not* applied
 * here, because the question is different. Listing asks "can this build render
 * it"; this asks "does any stored list still hold this work", which is what
 * decides whether its cached text is an orphan
 * ({@link file://../siteExport/workText.ts}). A snapshot written by a newer
 * build is one the reader kept, and discarding the work text under it because
 * this build cannot draw it would be the worst kind of tidying.
 */
export async function snapshotWorkIds(): Promise<Set<string>> {
  const snapshots = await cache.get('searchSnapshots')
  const ids = new Set<string>()
  for (const entry of Object.values(snapshots)) {
    for (const html of entry.blurbsHtml) {
      const id = BLURB_ID_RE.exec(html)?.[1]
      if (id)
        ids.add(id)
    }
  }
  return ids
}

/**
 * Persist a snapshot of the given works (their blurb HTML, in order), plus how
 * to re-fetch the listing later ({@link SnapshotDescriptor}).
 */
export async function writeSnapshot(key: string, works: Work[], descriptor: SnapshotDescriptor): Promise<void> {
  const snapshots = await cache.get('searchSnapshots')
  snapshots[key] = {
    version: SNAPSHOT_VERSION,
    scrapedAt: Date.now(),
    blurbsHtml: works.map(work => work.el.outerHTML),
    descriptor,
  }
  await cache.set({ searchSnapshots: snapshots })
}

/**
 * Forget a stored list.
 *
 * The blurbs go; the work text does not. That cache is keyed by work rather
 * than by list ({@link file://../siteExport/workTextCache.ts}), so a work this
 * list held may well be in another one — and the text is hours of requests to
 * AO3, where the blurbs are one scrape. Deleting it is its own action, and the
 * narrow version of that action — the works this leaves behind that nothing else
 * holds — reads its answer from {@link snapshotWorkIds}.
 */
export async function deleteSnapshot(key: string): Promise<void> {
  const snapshots = await cache.get('searchSnapshots')
  if (!(key in snapshots))
    return
  delete snapshots[key]
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
