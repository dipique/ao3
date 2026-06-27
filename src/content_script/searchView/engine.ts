import type { Work } from '#content_script/blurb.js'

/**
 * DOM-free filter/sort/facet engine for the in-memory search view. Operates on
 * a plain `Work[]` so it is reusable for any aggregated AO3 listing (and unit
 * testable in Node without a DOM).
 */

/** A facetable field. Each maps a work to zero or more string values. */
export type FacetKey
  = | 'rating'
    | 'warnings'
    | 'categories'
    | 'fandoms'
    | 'relationships'
    | 'characters'
    | 'freeforms'
    | 'language'
    | 'status'

/** Facet groups in sidebar display order. */
export const FACET_KEYS: FacetKey[] = [
  'rating',
  'warnings',
  'categories',
  'fandoms',
  'relationships',
  'characters',
  'freeforms',
  'language',
  'status',
]

export const FACET_LABELS: Record<FacetKey, string> = {
  rating: 'Rating',
  warnings: 'Archive Warnings',
  categories: 'Categories',
  fandoms: 'Fandoms',
  relationships: 'Relationships',
  characters: 'Characters',
  freeforms: 'Additional Tags',
  language: 'Language',
  status: 'Completion Status',
}

export type SortKey
  = | 'marked'
    | 'title'
    | 'author'
    | 'updated'
    | 'words'
    | 'kudos'
    | 'hits'
    | 'comments'
    | 'bookmarks'

export const SORT_LABELS: Record<SortKey, string> = {
  marked: 'Date marked for later',
  title: 'Title',
  author: 'Author',
  updated: 'Date updated',
  words: 'Word count',
  kudos: 'Kudos',
  hits: 'Hits',
  comments: 'Comments',
  bookmarks: 'Bookmarks',
}

export function facetValues(work: Work, key: FacetKey): string[] {
  switch (key) {
    case 'rating': return work.rating ? [work.rating] : []
    case 'warnings': return work.warnings
    case 'categories': return work.categories
    case 'fandoms': return work.fandoms
    case 'relationships': return work.relationships
    case 'characters': return work.characters
    case 'freeforms': return work.freeforms
    case 'language': return work.language ? [work.language] : []
    case 'status': return [work.complete ? 'Complete' : 'Work in Progress']
  }
}

export interface FacetSelection {
  include: Set<string>
  exclude: Set<string>
}

export interface FilterState {
  text: string
  facets: Record<FacetKey, FacetSelection>
  wordsMin: number | null
  wordsMax: number | null
  sort: SortKey
  dir: 'asc' | 'desc'
}

export function emptyFilterState(): FilterState {
  const facets = {} as Record<FacetKey, FacetSelection>
  for (const key of FACET_KEYS)
    facets[key] = { include: new Set(), exclude: new Set() }
  return { text: '', facets, wordsMin: null, wordsMax: null, sort: 'marked', dir: 'asc' }
}

/** Lowercased text blob a free-text query is matched against. */
function haystack(work: Work): string {
  return [
    work.title,
    ...work.authors.map(a => a.text),
    work.summaryText,
    ...work.fandoms,
    ...work.relationships,
    ...work.characters,
    ...work.freeforms,
    ...work.warnings,
    ...work.categories,
    work.rating ?? '',
    work.language ?? '',
  ].join(' \n ').toLowerCase()
}

/**
 * Whether a work passes the filter. Semantics: within a facet group selected
 * values are OR'd; across groups they're AND'd; an excluded value anywhere drops
 * the work (exclude wins). Free text splits into terms that must all appear.
 */
export function matches(work: Work, f: FilterState): boolean {
  if (f.wordsMin !== null && work.words < f.wordsMin)
    return false
  if (f.wordsMax !== null && work.words > f.wordsMax)
    return false

  if (f.text.trim()) {
    const hay = haystack(work)
    for (const term of f.text.toLowerCase().split(/\s+/).filter(Boolean)) {
      if (!hay.includes(term))
        return false
    }
  }

  for (const key of FACET_KEYS) {
    const sel = f.facets[key]
    if (sel.include.size === 0 && sel.exclude.size === 0)
      continue
    const values = facetValues(work, key)
    if (sel.exclude.size && values.some(v => sel.exclude.has(v)))
      return false
    if (sel.include.size && !values.some(v => sel.include.has(v)))
      return false
  }

  return true
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

function compareKey(a: Work, b: Work, sort: SortKey): number {
  switch (sort) {
    case 'marked': return a.markedOrder - b.markedOrder
    case 'title': return collator.compare(a.title, b.title)
    case 'author': return collator.compare(a.authors[0]?.text ?? '', b.authors[0]?.text ?? '')
    case 'updated': return a.dateUpdated - b.dateUpdated
    case 'words': return a.words - b.words
    case 'kudos': return a.kudos - b.kudos
    case 'hits': return a.hits - b.hits
    case 'comments': return a.comments - b.comments
    case 'bookmarks': return a.bookmarks - b.bookmarks
  }
}

export function sortWorks(works: Work[], sort: SortKey, dir: 'asc' | 'desc'): Work[] {
  const sign = dir === 'desc' ? -1 : 1
  // markedOrder is a stable tiebreaker so equal keys keep list order.
  return [...works].sort((a, b) => sign * (compareKey(a, b, sort) || a.markedOrder - b.markedOrder))
}

export function applyFilters(works: Work[], f: FilterState): Work[] {
  return sortWorks(works.filter(w => matches(w, f)), f.sort, f.dir)
}

export interface FacetValueCount {
  value: string
  count: number
}

/** Per-facet value→count list, sorted by count desc then name, over the full set. */
export function buildFacets(works: Work[]): Record<FacetKey, FacetValueCount[]> {
  const result = {} as Record<FacetKey, FacetValueCount[]>
  for (const key of FACET_KEYS) {
    const counts = new Map<string, number>()
    for (const work of works) {
      for (const value of facetValues(work, key))
        counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    result[key] = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || collator.compare(a.value, b.value))
  }
  return result
}
