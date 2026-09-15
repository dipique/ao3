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

/**
 * A list as it was stored before blurbs were shared between lists: every work's
 * blurb HTML, inline. Nothing writes this shape any more. It is read only to
 * migrate it (see the background's migrations), and — for the release that does
 * that — by a reader that opens a list before the migration has reached it.
 */
export interface LegacySearchSnapshot {
  /** 1 (no descriptor) or 2. */
  version: number
  scrapedAt: number
  /** Each work's blurb `outerHTML`, in list order. */
  blurbsHtml: string[]
  descriptor?: SnapshotDescriptor
}

/**
 * One stored list: which works it holds, in order, and how to fetch it again.
 *
 * **Keys, not blurbs.** A work's blurb is stored once, under the work
 * ({@link file://./blurbRecord.ts}), however many lists hold it — the same
 * work on Marked for Later, the read list and a tag search used to be three
 * copies of its markup, and every list write rewrote every copy. What a list
 * keeps is the short id each blurb (and each work's cached text) is found by.
 */
export interface StoredList {
  /** Schema version — {@link file://./blurbRecord.ts}'s `LIST_VERSION`. */
  v: number
  /** Epoch ms the listing was last scraped (for "as of" display + staleness). */
  scrapedAt: number
  /**
   * Ordered short work ids (`packOrderedIds` in {@link file://./workId.ts}).
   * The order is the listing's, and is what the view's "listing order" sort shows.
   */
  ids: string
  /**
   * How to re-fetch this listing. Absent on a list first stored before
   * descriptors existed — it still renders, it just can't be refreshed until the
   * reader visits its page once more.
   */
  descriptor?: SnapshotDescriptor
  /**
   * Markup that belongs to this list rather than to the work, by short id — the
   * reading-history block ("Last visited … (Marked for Later.)") a readings page
   * ends each blurb with, its forms taken out. Kept here so a tag search that
   * refreshes a shared blurb can't take "Last visited" off the read list, nor a
   * readings scrape put it on a tag search.
   */
  ctx?: { [sid: string]: string }
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
   * The in-memory search view's stored lists, keyed by source (e.g.
   * `marked-for-later:USERID`). Lets a future visit render instantly from cache
   * while a fresh scrape runs in the background. Holds work keys only; the
   * blurbs are shared between lists (see {@link StoredList}).
   */
  searchLists: { [key: string]: StoredList }
  /** Per-application local UI prefs for the search view (see {@link SearchViewPrefs}). */
  searchViewPrefs: { [appId: string]: SearchViewPrefs }
  /**
   * Work ids a search view went looking for in its listing and did not find, by
   * snapshot key, delta-packed like the marks. Only a view that knows its works
   * before it scrapes has any: the read list, whose works are the reader's marks
   * and whose listing is AO3's history — where a work marked read without being
   * opened, or read before a history was cleared, is simply not there.
   *
   * Recorded so that an automatic reload doesn't go looking for them again. A
   * work that isn't in the history can only be found by reading all of it, and
   * doing that on a timer for a handful of works that will never turn up is
   * exactly the cost the timer exists to avoid. The Refresh button still looks.
   */
  searchMisses: { [key: string]: string }
  /** Which works are on your Marked for Later list (see {@link MarkedForLaterIndex}). */
  markedForLater: MarkedForLaterIndex
  /**
   * Op ids from change files imported out of a site export, oldest first.
   *
   * The idempotency ledger for that round trip: an op named here has been
   * honoured, so importing the same file twice does nothing, and a later file
   * that still carries an old op can't undo a change made by hand since. Ids
   * only — an op's contents are in the file the reader keeps.
   */
  appliedChangeOps: string[]
}

export const cache = createStorage<Cache>({
  area: 'local',
  name: 'Cache',
  prefix: 'cache.',
  defaults: {
    chapterDates: {},
    searchLists: {},
    searchViewPrefs: {},
    searchMisses: {},
    markedForLater: { userId: '', updatedAt: 0, ids: '' },
    appliedChangeOps: [],
  },
})

// eslint-disable-next-line ts/no-namespace, ts/no-redeclare
export namespace cache {
  export type Id = keyof Cache
}
