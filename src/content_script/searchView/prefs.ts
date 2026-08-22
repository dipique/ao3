import { cache } from '#common'

import type { FacetKey, SortKey } from './engine.ts'

/**
 * Local (never-synced) per-application UI preferences for the search view: which
 * facet groups are collapsed, the user's custom facet ordering, the last sort
 * field/direction, and how wide the filter column was dragged. Persisted in `browser.storage.local` via {@link cache}, keyed
 * by an app id so each place the view is used (e.g. `marked-for-later`) keeps its
 * own layout. Deliberately *not* part of the synced options — layout is a
 * per-device convenience, not a setting worth carrying across machines.
 */
export interface SearchViewPrefs {
  collapsed: FacetKey[]
  order: FacetKey[]
  sort: SortKey
  dir: 'asc' | 'desc'
  /**
   * The Readiness values the view opens with. Sticky, unlike every other facet
   * selection, because it's the only thing standing between a to-read list and
   * the works on it that aren't worth opening yet — nothing is collapsed inside
   * the view, so if this didn't persist the feature would be off by default
   * every single time.
   */
  readiness?: string[]
  /**
   * Width of the filter column in pixels, as last dragged. Pixels rather than
   * `em` because the drag is in pixels and round-tripping through a font size
   * that AO3 skins are free to change would make the handle drift from the
   * pointer. Absent means the default, and the view clamps whatever it reads
   * against the space actually available.
   */
  sidebarWidth?: number
}

/** Filter-column width bounds, in pixels. */
export const SIDEBAR_WIDTH = { min: 160, max: 640, default: 240 }

/** What the Readiness facet is set to on a first-ever open: only what's ready. */
export const DEFAULT_READINESS: string[] = ['Ready']

/** Read the stored prefs for an app id (a partial — any field may be absent). */
export async function loadPrefs(appId: string): Promise<Partial<SearchViewPrefs>> {
  const all = await cache.get('searchViewPrefs')
  // Stored loosely as strings; the view validates keys against its facet list.
  return (all[appId] ?? {}) as Partial<SearchViewPrefs>
}

/** Persist the prefs for an app id, merging over any existing entry. */
export async function savePrefs(appId: string, prefs: SearchViewPrefs): Promise<void> {
  const all = await cache.get('searchViewPrefs')
  all[appId] = prefs
  await cache.set({ searchViewPrefs: all })
}
