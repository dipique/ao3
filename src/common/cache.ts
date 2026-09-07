import { createStorage } from './storage.ts'

/**
 * Everything needed to re-fetch a listing from somewhere that isn't the AO3 page
 * it came from — the options page, which has no `location`, no live document to
 * read a page count off, and none of the closures a `SearchSource` is built from.
 *
 * Stored with the snapshot rather than derived, because by the time anything
 * wants to refresh a list, the page that knew how to build its URL is long gone.
 */
export interface SnapshotDescriptor {
  /** The `SearchSource` id this came from, e.g. `marked-for-later`. */
  sourceId: string
  /** Human label for the options list, e.g. `Marked for Later — someuser`. */
  label: string
  /**
   * Absolute URL of the listing, page unspecified. Callers set the page with
   * `withPage` ({@link file://./listUrl.ts}) rather than appending to it.
   */
  listUrl: string
  /** Where the blurbs sit, when the source needs something other than the default. */
  blurbSelector?: string
}

export interface SearchSnapshot {
  /** Schema version, so stale-shaped snapshots are ignored after upgrades. */
  version: number
  /** Epoch ms the snapshot was scraped (for "as of" display + staleness). */
  scrapedAt: number
  /** Each work's blurb `outerHTML`, in list order — re-mounted to rebuild the view instantly. */
  blurbsHtml: string[]
  /**
   * How to re-fetch this listing. Absent on a v1 snapshot, written before
   * descriptors existed — such a snapshot still renders, it just can't be
   * refreshed until the reader visits its page once more.
   */
  descriptor?: SnapshotDescriptor
}

/**
 * Local (never-synced) UI preferences for one application of the in-memory search
 * view, keyed by an app id (e.g. `marked-for-later`). Stored as plain strings so
 * this module stays independent of the content-script facet types; the search
 * view casts them back to its own `FacetKey`/`SortKey` unions.
 */
export interface SearchViewPrefs {
  /** Facet groups the user has collapsed. */
  collapsed?: string[]
  /** The user's custom facet-group order (a permutation of the facet keys). */
  order?: string[]
  /** Last-used sort field. */
  sort?: string
  /** Last-used sort direction. */
  dir?: 'asc' | 'desc'
}

/**
 * The work ids on one user's Marked for Later list as of the last bulk scrape.
 * Lets listings show the saved indicator without a request per work; see
 * {@link file://./../content_script/markedForLaterIndex.ts} for what it can and
 * can't be trusted to say.
 */
export interface MarkedForLaterIndex {
  /** The (lower-cased) AO3 user the ids belong to; '' when there's no index yet. */
  userId: string
  /** Epoch ms the list was last scraped, for staleness. */
  updatedAt: number
  /** The saved work ids, delta-packed like the read/favourite marks. */
  ids: string
}

export interface Cache {
  chapterDates: { [workId: string]: string[] }
  /**
   * Persisted aggregated-listing snapshots for the in-memory search view, keyed
   * by source (e.g. `marked-for-later:USERID`). Lets a future visit render
   * instantly from cache while a fresh scrape runs in the background.
   */
  searchSnapshots: { [key: string]: SearchSnapshot }
  /** Per-application local UI prefs for the search view (see {@link SearchViewPrefs}). */
  searchViewPrefs: { [appId: string]: SearchViewPrefs }
  /** Which works are on your Marked for Later list (see {@link MarkedForLaterIndex}). */
  markedForLater: MarkedForLaterIndex
}

export const cache = createStorage<Cache>({
  area: 'local',
  name: 'Cache',
  prefix: 'cache.',
  defaults: {
    chapterDates: {},
    searchSnapshots: {},
    searchViewPrefs: {},
    markedForLater: { userId: '', updatedAt: 0, ids: '' },
  },
})

// eslint-disable-next-line ts/no-namespace, ts/no-redeclare
export namespace cache {
  export type Id = keyof Cache
}
