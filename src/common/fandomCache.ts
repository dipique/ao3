import { createStorage } from './storage.ts'

/**
 * A tag id learned at runtime — either fetched on demand (when a displayed
 * fandom wasn't in the bundled index) or passively scraped from a filter
 * sidebar. `name` preserves the original casing for export; the map is keyed by
 * the lowercased name for case-insensitive lookup.
 */
export interface ScrapedTag {
  id: number
  name: string
}

export interface FandomCache {
  fandoms: Record<string, ScrapedTag>
  characters: Record<string, ScrapedTag>
  relationships: Record<string, ScrapedTag>
}

export type ScrapedTagType = keyof FandomCache

export const fandomCache = createStorage<FandomCache>({
  area: 'local',
  name: 'FandomCache',
  prefix: 'fandomCache.',
  defaults: {
    fandoms: {},
    characters: {},
    relationships: {},
  },
})

// eslint-disable-next-line ts/no-namespace, ts/no-redeclare
export namespace fandomCache {
  export type Id = keyof FandomCache
}
