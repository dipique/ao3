import type { AuthorFilter, EntityFilter, FilterBehavior, TagType } from '#common'

import { options } from '#common'

/**
 * Toggle and read the *persistent* extension filters — the saved `hideTags`,
 * `hideAuthors`, `hideWorks` and `hideSeries` lists (as opposed to the ephemeral
 * AO3 sidebar filters handled by `filterSidebar.tsx`).
 *
 * Every menu that sets a hide/always-show/highlight state goes through here so
 * the read-freshest → find-exact → toggle → `options.set` pattern (previously
 * duplicated across the toolbars and background menus) lives in one place. All
 * four kinds share menu-toggle semantics: choosing the behaviour an item already
 * has clears it, and choosing a different behaviour replaces it.
 *
 * The behaviours map onto {@link FilterBehavior}: `hide` hides the item,
 * `invert` force-shows it ("always show"), `highlight` only highlights it.
 */

/** The single exact-match tag the menus target (name + optional type). */
export interface TagTarget {
  name: string
  type?: TagType
}

function sameType(a: TagType | undefined, b: TagType | undefined): boolean {
  return (a ?? undefined) === (b ?? undefined)
}

// --- Tags / fandoms (stored together in `hideTags` as exact TagFilters). -----

/** The behaviour currently applied to this exact tag, or `null` if none. */
export function tagBehavior(filters: { name: string, type?: TagType, matcher: string, behavior?: FilterBehavior }[], tag: TagTarget): FilterBehavior | null {
  const filter = filters.find(f => f.matcher === 'exact' && f.name === tag.name && sameType(f.type, tag.type))
  return filter ? (filter.behavior ?? 'hide') : null
}

/** Toggle `behavior` for an exact tag/fandom in `hideTags` (re-selecting clears it). */
export async function toggleTagBehavior(tag: TagTarget, behavior: FilterBehavior): Promise<void> {
  const hideTags = await options.get('hideTags')
  const filters = hideTags.filters
  const index = filters.findIndex(f => f.matcher === 'exact' && f.name === tag.name && sameType(f.type, tag.type))
  const current = index !== -1 ? (filters[index]!.behavior ?? 'hide') : null
  if (index !== -1)
    filters.splice(index, 1)
  if (current !== behavior)
    filters.push({ name: tag.name, ...(tag.type !== undefined ? { type: tag.type } : {}), matcher: 'exact', behavior })

  await options.set({ hideTags: { ...hideTags, enabled: true, filters } })
}

/** Remove any exact hide/always-show/highlight on a tag/fandom (back to no rule). */
export async function clearTagBehavior(tag: TagTarget): Promise<void> {
  const hideTags = await options.get('hideTags')
  const filters = hideTags.filters.filter(f => !(f.matcher === 'exact' && f.name === tag.name && sameType(f.type, tag.type)))
  await options.set({ hideTags: { ...hideTags, filters } })
}

// --- Authors (stored in `hideAuthors`, keyed by userId + optional pseud). -----

/** The behaviour currently applied to this author (or specific pseud), or `null`. */
export function authorBehavior(filters: AuthorFilter[], userId: string, pseud?: string): FilterBehavior | null {
  const filter = filters.find(f => f.userId === userId && f.pseud === pseud)
  return filter ? (filter.behavior ?? 'hide') : null
}

/** Toggle `behavior` for an author (or a specific pseud) in `hideAuthors`. */
export async function toggleAuthorBehavior(userId: string, behavior: FilterBehavior, pseud?: string): Promise<void> {
  const hideAuthors = await options.get('hideAuthors')
  const filters = hideAuthors.filters
  const index = filters.findIndex(f => f.userId === userId && f.pseud === pseud)
  const current = index !== -1 ? (filters[index]!.behavior ?? 'hide') : null
  if (index !== -1)
    filters.splice(index, 1)
  if (current !== behavior)
    filters.push({ userId, ...(pseud !== undefined ? { pseud } : {}), behavior })

  await options.set({ hideAuthors: { ...hideAuthors, enabled: true, filters } })
}

/** Remove any hide/always-show/highlight on an author (or a specific pseud). */
export async function clearAuthorBehavior(userId: string, pseud?: string): Promise<void> {
  const hideAuthors = await options.get('hideAuthors')
  const filters = hideAuthors.filters.filter(f => !(f.userId === userId && f.pseud === pseud))
  await options.set({ hideAuthors: { ...hideAuthors, filters } })
}

// --- Works / series (stored in `hideWorks` / `hideSeries` by numeric id). -----

export type EntityOptionKey = 'hideWorks' | 'hideSeries'

/** The behaviour currently applied to this work/series id, or `null` if none. */
export function entityBehavior(filters: EntityFilter[], value: string): FilterBehavior | null {
  const filter = filters.find(f => f.value.trim() === value)
  return filter ? (filter.behavior ?? 'hide') : null
}

/** Toggle `behavior` for a work/series id in the given option (re-selecting clears it). */
export async function toggleEntityBehavior(optionKey: EntityOptionKey, value: string, behavior: FilterBehavior): Promise<void> {
  const option = await options.get(optionKey)
  const filters = option.filters
  const index = filters.findIndex(f => f.value.trim() === value)
  const current = index !== -1 ? (filters[index]!.behavior ?? 'hide') : null
  if (index !== -1)
    filters.splice(index, 1)
  if (current !== behavior)
    filters.push({ value, matcher: 'exact', behavior })

  await options.set({ [optionKey]: { ...option, enabled: true, filters } })
}

/** Remove any hide/always-show/highlight on a work/series id (back to no rule). */
export async function clearEntityBehavior(optionKey: EntityOptionKey, value: string): Promise<void> {
  const option = await options.get(optionKey)
  const filters = option.filters.filter(f => f.value.trim() !== value)
  await options.set({ [optionKey]: { ...option, filters } })
}
