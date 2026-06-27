import { createStorage } from './storage.ts'

export interface SearchSnapshot {
  /** Schema version, so stale-shaped snapshots are ignored after upgrades. */
  version: number
  /** Epoch ms the snapshot was scraped (for "as of" display + staleness). */
  scrapedAt: number
  /** Each work's blurb `outerHTML`, in list order — re-mounted to rebuild the view instantly. */
  blurbsHtml: string[]
}

export interface Cache {
  chapterDates: { [workId: string]: string[] }
  /**
   * Persisted aggregated-listing snapshots for the in-memory search view, keyed
   * by source (e.g. `marked-for-later:USERID`). Lets a future visit render
   * instantly from cache while a fresh scrape runs in the background.
   */
  searchSnapshots: { [key: string]: SearchSnapshot }
}

export const cache = createStorage<Cache>({
  area: 'local',
  name: 'Cache',
  prefix: 'cache.',
  defaults: {
    chapterDates: {},
    searchSnapshots: {},
  },
})

// eslint-disable-next-line ts/no-namespace, ts/no-redeclare
export namespace cache {
  export type Id = keyof Cache
}
