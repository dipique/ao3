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
