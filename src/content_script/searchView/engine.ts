import type { Work } from '#content_script/blurb.js'
import type { Completion } from '#content_script/completionFilter.js'

/**
 * DOM-free filter/sort/facet engine for the in-memory search view. Operates on
 * a plain `Work[]` so it is reusable for any aggregated AO3 listing (and unit
 * testable in Node without a DOM).
 */

/** A facetable field. Each maps a work to zero or more string values. */
export type FacetKey
  = | 'status'
    | 'source'
    | 'rating'
    | 'warnings'
    | 'categories'
    | 'fandoms'
    | 'relationships'
    | 'characters'
    | 'freeforms'
    | 'language'
    | 'completion'

/** Facet groups in sidebar display order. */
export const FACET_KEYS: FacetKey[] = [
  'status',
  'source',
  'rating',
  'warnings',
  'categories',
  'fandoms',
  'relationships',
  'characters',
  'freeforms',
  'language',
  'completion',
]

export const FACET_LABELS: Record<FacetKey, string> = {
  status: 'Status',
  source: 'List source',
  rating: 'Rating',
  warnings: 'Archive Warnings',
  categories: 'Categories',
  fandoms: 'Fandoms',
  relationships: 'Relationships',
  characters: 'Characters',
  freeforms: 'Additional Tags',
  language: 'Language',
  completion: 'Completion Status',
}

/**
 * The facet keys in the reader's saved order, with any key that order doesn't
 * name put back at its **default** position — so a saved order stays valid as
 * facet keys are added or removed across versions.
 *
 * Default position, not the end: a key added to {@link FACET_KEYS} in the middle
 * belongs in the middle for everyone, and a reader who once dragged a group
 * around should not be the only one who finds the new group at the bottom. A
 * missing key goes after the last of its default predecessors the saved order
 * still holds, and at the front when it holds none of them.
 */
export function orderFacetKeys(saved: readonly string[] | undefined): FacetKey[] {
  if (!saved || saved.length === 0)
    return [...FACET_KEYS]
  const known = new Set<string>(FACET_KEYS)
  const seen = new Set<FacetKey>()
  const ordered: FacetKey[] = []
  for (const key of saved) {
    if (known.has(key) && !seen.has(key as FacetKey)) {
      ordered.push(key as FacetKey)
      seen.add(key as FacetKey)
    }
  }
  for (const [at, key] of FACET_KEYS.entries()) {
    if (seen.has(key))
      continue
    let insertAt = 0
    for (const before of FACET_KEYS.slice(0, at)) {
      const found = ordered.indexOf(before)
      if (found !== -1)
        insertAt = Math.max(insertAt, found + 1)
    }
    ordered.splice(insertAt, 0, key)
    seen.add(key)
  }
  return ordered
}

export type SortKey
  = | 'marked'
    | 'title'
    | 'author'
    | 'updated'
    | 'words'
    | 'kudos'
    | 'kudosPct'
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
  kudosPct: 'Kudos %',
  hits: 'Hits',
  comments: 'Comments',
  bookmarks: 'Bookmarks',
}

/** The two values of the `completion` facet group. */
export const COMPLETE_VALUE = 'Complete'
export const WIP_VALUE = 'Work in Progress'

export function facetValues(work: Work, key: FacetKey): string[] {
  switch (key) {
    // Precomputed by the host, not derived here: a work's statuses depend on the
    // mark table, on the Marked for Later index and on what day it is, none of
    // which belongs in a pure engine. A work the host never stamped falls back
    // to Ready — an untracked work on your to-read list is exactly that, with
    // nothing standing between you and reading it.
    case 'status': return work.statuses ?? ['Ready']
    // Which of the reader's own lists turned this work up — stamped by the host
    // for a view assembled from several queries at once, and absent everywhere
    // else, so the group has no values and the sidebar leaves it out.
    case 'source': return work.sources ?? []
    case 'rating': return work.rating ? [work.rating] : []
    case 'warnings': return work.warnings
    case 'categories': return work.categories
    case 'fandoms': return work.fandoms
    case 'relationships': return work.relationships
    case 'characters': return work.characters
    case 'freeforms': return work.freeforms
    case 'language': return work.language ? [work.language] : []
    case 'completion': return [work.complete ? COMPLETE_VALUE : WIP_VALUE]
  }
}

/** Whether a completion selection lets works carrying `value` through. */
function completionAdmits(sel: FacetSelection, value: string): boolean {
  if (sel.exclude.has(value))
    return false
  if (sel.include.size > 0 && !sel.include.has(value))
    return false
  // A work carries exactly one completion value, so requiring any other
  // shuts it out.
  return [...sel.require].every(required => required === value)
}

/**
 * Read a `completion` facet selection as the one choice AO3's own filter offers:
 * complete works only, works in progress only, or (null) either. Any spelling
 * that narrows to one side counts — including one, or excluding the other.
 */
export function completionOf(sel: FacetSelection): Completion | null {
  const complete = completionAdmits(sel, COMPLETE_VALUE)
  const wip = completionAdmits(sel, WIP_VALUE)
  if (complete === wip)
    return null
  return complete ? 'complete' : 'incomplete'
}

/** The facet value that stands for `completion`, for writing it into the group. */
export function completionValue(completion: Completion): string {
  return completion === 'complete' ? COMPLETE_VALUE : WIP_VALUE
}

/**
 * One value in one facet group — the pair a caller needs to name a single facet
 * row. Used to hand the view a set of selections worked out elsewhere (the
 * exclusions the reader's hide rules imply; see `searchView/hidden.ts`).
 */
export interface FacetValueRef {
  key: FacetKey
  value: string
}

export interface FacetSelection {
  /** OR within the group: a work matches if it has any included value. */
  include: Set<string>
  /** Drops a work that has any excluded value (exclude wins). */
  exclude: Set<string>
  /** AND within the group: a work matches only if it has every required value. */
  require: Set<string>
}

/** The three ways a value can be selected in a facet group. */
export type FacetDir = 'include' | 'exclude' | 'require'

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
    facets[key] = { include: new Set(), exclude: new Set(), require: new Set() }
  return { text: '', facets, wordsMin: null, wordsMax: null, sort: 'marked', dir: 'asc' }
}

/** Deep copy of a filter state (cloning the per-facet Sets), for snapshot/restore. */
export function cloneFilterState(f: FilterState): FilterState {
  const facets = {} as Record<FacetKey, FacetSelection>
  for (const key of FACET_KEYS) {
    facets[key] = {
      include: new Set(f.facets[key].include),
      exclude: new Set(f.facets[key].exclude),
      require: new Set(f.facets[key].require),
    }
  }
  return { text: f.text, facets, wordsMin: f.wordsMin, wordsMax: f.wordsMax, sort: f.sort, dir: f.dir }
}

/**
 * Facet groups whose selections describe how the reader is looking at a view,
 * never what the view is a search *for*, so they are no part of a filter kept
 * beyond it (a tracked list's):
 *
 * - **Status** depends on the reader's marks and on what day it is, and a list's
 *   review already leaves out the works the reader has dealt with;
 * - **List source** only exists in the review, which is assembled *from* lists.
 */
export const VIEW_ONLY_KEYS: readonly FacetKey[] = ['status', 'source']

/** How a view names one selected value in its bookkeeping: `key:value`. */
export function facetValueKey(key: FacetKey, value: string): string {
  return `${key}:${value}`
}

/**
 * The part of a view's filter the reader dialled in themselves.
 *
 * A view writes the exclusions the reader's hide rules imply into the same
 * selections the reader edits, so that the works they cover never reach a page.
 * Those are taken back out here — `auto` names them, as {@link facetValueKey}s —
 * because they belong to the rules rather than to this search: the rules apply
 * wherever the works turn up anyway, and freezing today's into a saved filter
 * would stop tomorrow's rule change from reaching it. The one exception is an
 * exclusion the reader lifted and then put back by hand (`released` names every
 * one they lifted): what is excluded now is their doing, not the rule's.
 *
 * The {@link VIEW_ONLY_KEYS} groups come back empty. Sort and direction are
 * carried over untouched; they are layout, and nothing that reads a filter as a
 * filter looks at them.
 */
export function readerFilter(f: FilterState, auto: ReadonlySet<string>, released: ReadonlySet<string>): FilterState {
  const out = cloneFilterState(f)
  for (const key of VIEW_ONLY_KEYS)
    out.facets[key] = { include: new Set(), exclude: new Set(), require: new Set() }
  for (const key of FACET_KEYS) {
    const excluded = out.facets[key].exclude
    for (const value of [...excluded]) {
      const id = facetValueKey(key, value)
      if (auto.has(id) && !released.has(id))
        excluded.delete(value)
    }
  }
  return out
}

// A work's searchable text never changes, so build it once and cache it. Keyed
// by the work object, so it's dropped automatically when works are replaced.
const haystackCache = new WeakMap<Work, string>()

/** Lowercased text blob a free-text query is matched against. */
function haystack(work: Work): string {
  let hay = haystackCache.get(work)
  if (hay === undefined) {
    hay = [
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
    haystackCache.set(work, hay)
  }
  return hay
}

/**
 * Whether a work passes the filter. Semantics: within a facet group *included*
 * values are OR'd while *required* values are AND'd (the work must carry every
 * one); across groups they're AND'd; an excluded value anywhere drops the work
 * (exclude wins). Free text splits into terms that must all appear.
 *
 * `ignoreKey` skips one facet group's selections — used to compute drill-down
 * counts for that group (each value's count over works passing every *other*
 * filter, i.e. "how many you'd see if you also picked this value").
 */
export function matches(work: Work, f: FilterState, ignoreKey?: FacetKey): boolean {
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
    if (key === ignoreKey)
      continue
    const sel = f.facets[key]
    if (sel.include.size === 0 && sel.exclude.size === 0 && sel.require.size === 0)
      continue
    const values = facetValues(work, key)
    if (sel.exclude.size && values.some(v => sel.exclude.has(v)))
      return false
    if (sel.include.size && !values.some(v => sel.include.has(v)))
      return false
    if (sel.require.size && ![...sel.require].every(v => values.includes(v)))
      return false
  }

  return true
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** Kudos-to-hits ratio; 0 when a work has no hits (mirrors the blurb's Stats display). */
function kudosRatio(w: Work): number {
  return w.hits > 0 ? w.kudos / w.hits : 0
}

function compareKey(a: Work, b: Work, sort: SortKey): number {
  switch (sort) {
    case 'marked': return a.markedOrder - b.markedOrder
    case 'title': return collator.compare(a.title, b.title)
    case 'author': return collator.compare(a.authors[0]?.text ?? '', b.authors[0]?.text ?? '')
    case 'updated': return a.dateUpdated - b.dateUpdated
    case 'words': return a.words - b.words
    case 'kudos': return a.kudos - b.kudos
    // Kudos as a share of hits (kudos/hits); no hits ⇒ 0, so unread works sort last.
    case 'kudosPct': return kudosRatio(a) - kudosRatio(b)
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

/** Drill-down counts: per facet, a `value → count` map. */
export type FacetCounts = Record<FacetKey, Map<string, number>>

function countFacet(works: Work[], key: FacetKey): FacetValueCount[] {
  const counts = new Map<string, number>()
  for (const work of works) {
    for (const value of facetValues(work, key))
      counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || collator.compare(a.value, b.value))
}

/** Per-facet value→count list, sorted by count desc then name, over the full set. */
export function buildFacets(works: Work[]): Record<FacetKey, FacetValueCount[]> {
  const result = {} as Record<FacetKey, FacetValueCount[]>
  for (const key of FACET_KEYS)
    result[key] = countFacet(works, key)
  return result
}

/**
 * Per-facet counts reflecting the current filter. Each group is counted over the
 * works passing every *other* active filter (drill-down faceting), so a value's
 * count reads as "results you'd get if you also picked this". Returns a flat
 * `value → count` map per key for cheap lookup; the view keeps its own row order.
 */
export function buildFilteredFacets(works: Work[], f: FilterState): FacetCounts {
  const result = {} as FacetCounts
  for (const key of FACET_KEYS) {
    const pool = works.filter(w => matches(w, f, key))
    result[key] = new Map(countFacet(pool, key).map(({ value, count }) => [value, count]))
  }
  return result
}

export interface ViewComputation {
  /** Works passing the full filter (unordered — the view sorts separately). */
  visible: Set<Work>
  /** Drill-down facet counts (equivalent to {@link buildFilteredFacets}). */
  facetCounts: FacetCounts
  /**
   * Per-facet `value → count` over the *currently visible* works only — i.e. how
   * many results would remain if you additionally required that value. Unlike
   * {@link facetCounts} this respects the value's own group selection.
   */
  resultCounts: FacetCounts
}

/**
 * Single-pass filter + drill-down faceting for the live view. Equivalent to
 * `applyFilters` (as a set) plus `buildFilteredFacets`, but computed together in
 * one O(works × facets) sweep instead of re-filtering once per facet, with the
 * text haystack cached — this is the hot path on every keystroke.
 *
 * The drill-down trick: a work passing every filter contributes to *all* groups'
 * counts; a work failing exactly one group contributes only to that group's
 * counts (it's what you'd gain by relaxing that group); a work failing two or
 * more contributes nowhere. That reproduces "count over works passing every
 * other filter" without a separate pass per group.
 */
export function computeView(works: Work[], f: FilterState): ViewComputation {
  const textTerms = f.text.trim() ? f.text.toLowerCase().split(/\s+/).filter(Boolean) : []
  // Only groups with a selection actually constrain matching.
  const activeKeys = FACET_KEYS.filter(k =>
    f.facets[k].include.size > 0 || f.facets[k].exclude.size > 0 || f.facets[k].require.size > 0,
  )

  const facetCounts = {} as FacetCounts
  const resultCounts = {} as FacetCounts
  for (const key of FACET_KEYS) {
    facetCounts[key] = new Map<string, number>()
    resultCounts[key] = new Map<string, number>()
  }
  const visible = new Set<Work>()

  const bump = (counts: FacetCounts, key: FacetKey, work: Work): void => {
    const map = counts[key]
    for (const value of facetValues(work, key))
      map.set(value, (map.get(value) ?? 0) + 1)
  }

  for (const work of works) {
    if (f.wordsMin !== null && work.words < f.wordsMin)
      continue
    if (f.wordsMax !== null && work.words > f.wordsMax)
      continue
    if (textTerms.length) {
      const hay = haystack(work)
      if (!textTerms.every(term => hay.includes(term)))
        continue
    }

    let failKey: FacetKey | null = null
    let failCount = 0
    for (const key of activeKeys) {
      const sel = f.facets[key]
      const values = facetValues(work, key)
      const excluded = sel.exclude.size > 0 && values.some(v => sel.exclude.has(v))
      const included = sel.include.size === 0 || values.some(v => sel.include.has(v))
      const required = sel.require.size === 0 || [...sel.require].every(v => values.includes(v))
      if (excluded || !included || !required) {
        if (++failCount > 1)
          break
        failKey = key
      }
    }

    if (failCount === 0) {
      visible.add(work)
      for (const key of FACET_KEYS) {
        // Drill-down counts (every group) and result counts both gain a fully
        // matching work; result counts track only the visible set.
        bump(facetCounts, key, work)
        bump(resultCounts, key, work)
      }
    }
    else if (failCount === 1 && failKey) {
      bump(facetCounts, failKey, work)
    }
  }

  return { visible, facetCounts, resultCounts }
}

/** Why a work kept a slot it no longer earns — what its reason line has to say. */
export type StableDrop
  /** The reader's rules or marks now take it out of the listing. */
  = | 'hidden'
    /** It still is a result, but the filter as it stands no longer passes it. */
    | 'filtered'

/** Where every work sits, and which of them are only holding their place. */
export interface StableLayout {
  /** The works to page over, in the order the pages are cut from. */
  ordered: Work[]
  /** Those of {@link ordered} that are drawn collapsed, and why. */
  dropped: Map<Work, StableDrop>
}

/**
 * Lay the pages out from a remembered order instead of from what passes the
 * filter right now, so that nothing the reader is part-way through paging can
 * move under them.
 *
 * Recomputing the layout is the obvious thing and the wrong one for a list being
 * worked through item by item. Anything that takes one work out of the results
 * mid-pass — a mark that hides works, a rule added from a context menu, a status
 * a live facet filter no longer admits — shortens the list, and every work after
 * it slides back a slot. The work that was first on the next page lands on the
 * page just read, and is never seen. Freezing the order costs a stale slot;
 * recomputing it costs works.
 *
 * `order` names works by id, in page order, as they stood when the reader last
 * said what they wanted. Given today's `visible` set and every work in today's
 * sort order:
 *
 * - a work named by `order` keeps its slot, whether or not it still passes — one
 *   that doesn't is reported in {@link StableLayout.dropped} for the caller to
 *   draw collapsed, with the reason taken from {@link Work.hidden} /
 *   {@link Work.filtered} (a rule or a mark) or, failing those, the filter;
 * - an id `order` names that no work answers to any more is simply gone: its
 *   slot goes with it, since there is nothing left to hold it;
 * - a work that passes now and `order` has never heard of goes on the end, in
 *   sort order. Nothing should reach here while the order is frozen — fresh
 *   works are held back rather than swapped in — but losing a work outright
 *   would be far worse than showing it late.
 */
export function layoutStablePages(
  order: readonly string[],
  sorted: readonly Work[],
  visible: ReadonlySet<Work>,
): StableLayout {
  const byId = new Map<string, Work>()
  for (const work of sorted) {
    if (!byId.has(work.workId))
      byId.set(work.workId, work)
  }
  const ordered: Work[] = []
  const dropped = new Map<Work, StableDrop>()
  const placed = new Set<Work>()
  for (const id of order) {
    const work = byId.get(id)
    // A repeated id claims one slot, not two.
    if (!work || placed.has(work))
      continue
    placed.add(work)
    ordered.push(work)
    if (!visible.has(work))
      dropped.set(work, work.hidden || work.filtered ? 'hidden' : 'filtered')
  }
  for (const work of sorted) {
    if (visible.has(work) && !placed.has(work)) {
      placed.add(work)
      ordered.push(work)
    }
  }
  return { ordered, dropped }
}
