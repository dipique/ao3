import { createStorage } from './storage.ts'

export interface SearchSnapshot {
  /** Schema version, so stale-shaped snapshots are ignored after upgrades. */
  version: number
  /** Epoch ms the snapshot was scraped (for "as of" display + staleness). */
  scrapedAt: number
  /** Each work's blurb `outerHTML`, in list order — re-mounted to rebuild the view instantly. */
  blurbsHtml: string[]
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
}

export const cache = createStorage<Cache>({
  area: 'local',
  name: 'Cache',
  prefix: 'cache.',
  defaults: {
    chapterDates: {},
    searchSnapshots: {},
    searchViewPrefs: {},
  },
})

// eslint-disable-next-line ts/no-namespace, ts/no-redeclare
export namespace cache {
  export type Id = keyof Cache
}
