import type { SavedList, SavedListJoin, StoredListRef } from '../../common/savedLists.ts'
import type { Day, TrackedFilterSummary, TrackedKind, TrackedMeta } from '../../common/trackedLists.ts'
import type { CachingBuckets } from '../../content_script/siteExport/workText.ts'

import { defaultTitleOf, SAVED_LIST_SOURCE_IDS, storedListMeta } from '../../common/savedLists.ts'
import { defaultTitle, describeFilters, normalizeTrackedUrl, refineLink, sourceLabel, TRACKED_TYPE_LABELS, trackedMeta } from '../../common/trackedLists.ts'

/** What each kind of query is called in the reader's words. */
export const KIND_LABELS: Readonly<Record<TrackedKind, string>> = {
  'works-filter': 'Filtered listing',
  'text-search': 'Works search',
  'tag-works': 'Uncommon tag',
  'series-works': 'Series',
}

/**
 * Why a row's tracking toggle is off, worded to follow the control's own name
 * after a dash ("Track this list for review — off while …").
 */
export const TRACK_OFF = {
  review: 'off while Tracked lists is switched off',
  notArchive: 'off: its address isn\'t a page on AO3, so nothing from it can be reviewed',
  needsVisit: 'off until it has been opened on AO3 once',
  notSearch: 'off: only a search, an uncommon tag or a series can be tracked',
} as const

/** Why a row's offline actions are off, when no job is the reason. */
export const OFFLINE_OFF = {
  undescribed: 'off until you open it on AO3 and press its search button: it was saved before the extension could fetch it again',
} as const

/** What a row's Caching cell shows. */
export type SavedListCaching
  = | { kind: 'copy', buckets: CachingBuckets, scrapedAt: number, unstored: number }
    /** Not cached: nothing is stored at the list's address. */
    | { kind: 'none' }
    /** A filtered listing, which no search view keeps a copy of. */
    | { kind: 'not-offline' }

/** One row of the saved lists: a saved list, or a stored list no saved list is at. */
export interface SavedListRow {
  /** The saved list's id, or `copy:<key>` for a stored list of its own. */
  id: string
  /**
   * What the row is called. A saved list's title, which it always has, its
   * default where it was never given one; only a list at no address on the
   * archive can lack one. A copy's: the default its record will take, its
   * label, or an undescribed one's raw key.
   */
  title: string
  /**
   * What an emptied title field shows, and commits to: the list's default
   * title — or, for a list that has none and no title either, its URL's tail.
   * `''` for a copy, whose title can't be edited.
   */
  placeholder: string
  /** Only a saved list has a record to keep a title on. */
  titleEditable: boolean
  /** The title is a raw stored key, to be shown as one. */
  rawKey: boolean
  /** What the list is of, for its badge ("Character"), and the whole of it, for the badge's tooltip ("Character: Draco Malfoy"). */
  type?: string
  typeTip?: string
  /** What kind of query it is ("Works search"). */
  kind?: string
  filters: TrackedFilterSummary
  /** The list's page on the archive, marked as being refined: a path, for the page to make absolute. */
  viewEdit?: string
  /** The list's plain address on the archive: a path, for the page to make absolute. */
  copyUrl?: string
  status: 'tracked' | 'saved'
  /** Why the list is waiting on the reader: its address isn't a page on AO3, or it needs one visit to be described. */
  pending: null | 'not-archive' | 'needs-visit'
  /** The day a tracked list has been tracked from. */
  since?: Day
  /** Another list has the same title, as sync can bring about. */
  sharedTitle: boolean
  /** The other lists at its address, by title or what stands in for one: they search the same thing. */
  sameAddressAs: string[]
  caching: SavedListCaching
  /** Why the tracking toggle is off ({@link TRACK_OFF}). */
  trackOff?: string
  /** Why the offline actions (refresh, cache, download) are off. */
  offlineOff?: string
}

/** The filter line of a list that filters by nothing it can name. */
const NO_FILTERS: TrackedFilterSummary = { text: '', full: '', more: 0 }

/** What the rows need beyond the join. */
export interface SavedListRowsContext {
  /** What one stored list holds: its caching figures, and how many of its works' blurbs aren't stored. */
  copy: (key: string) => { buckets: CachingBuckets, unstored: number }
  /** Whether *Tracked lists* is on: with it off, no list can be tracked or stopped. */
  review: boolean
  /** Why a running job keeps one stored list's offline actions off, or null. */
  jobOff: (key: string) => string | null
}

/**
 * The saved lists as rows: one per saved list, in the join's order, then one
 * per stored list no saved list is at, newest first. Each says what it is, how
 * it stands, what is cached of it, where it lives on AO3, and why any of its
 * controls is off. Pure display: the order the page shows is its own sort.
 */
export function savedListRows(join: SavedListJoin, ctx: SavedListRowsContext): SavedListRow[] {
  const titles = new Map<string, number>()
  for (const { list } of join.lists) {
    const key = titleKey(list.title)
    if (key)
      titles.set(key, (titles.get(key) ?? 0) + 1)
  }
  const nameOf = (id: string): string => {
    const one = join.lists.find(other => other.list.id === id)
    return one ? (titleOf(one.list) || titlePlaceholder(one.list)) : ''
  }

  const lists = join.lists.map((one): SavedListRow => {
    const { list, entry, address, copy } = one
    const normalized = normalizeTrackedUrl(list.url)
    const pending = address === null ? 'not-archive' : null
    return defined({
      id: list.id,
      title: titleOf(list),
      placeholder: titlePlaceholder(list),
      titleEditable: true,
      rawKey: false,
      ...badge(trackedMeta(list), list.kind),
      filters: describeFilters(list),
      viewEdit: refineLink(list) ?? undefined,
      copyUrl: normalized?.url,
      status: entry ? 'tracked' : 'saved',
      pending,
      since: entry?.since,
      sharedTitle: (titles.get(titleKey(list.title)) ?? 0) > 1,
      sameAddressAs: one.sameAddress.map(nameOf),
      caching: copy ? cachingOf(copy, ctx) : list.kind === 'works-filter' ? { kind: 'not-offline' } : { kind: 'none' },
      trackOff: trackOff(pending, true, ctx.review),
      offlineOff: copy ? ctx.jobOff(copy.key) ?? undefined : undefined,
    })
  })

  const copies = join.copies.map((copy): SavedListRow => {
    const describedCopy = copy.sourceId !== undefined
    const savedSearch = SAVED_LIST_SOURCE_IDS.includes(copy.sourceId ?? '')
    const normalized = savedSearch ? normalizeTrackedUrl(copy.listUrl ?? '') : null
    const pending = !describedCopy ? 'needs-visit' : savedSearch && !normalized ? 'not-archive' : null
    const meta = normalized ? storedListMeta(normalized.url, copy.label ?? '') : null
    return defined({
      id: `copy:${copy.key}`,
      title: (meta && defaultTitle(meta)) || (describedCopy && copy.label?.trim()) || copy.key,
      placeholder: '',
      titleEditable: false,
      rawKey: !describedCopy,
      ...(normalized ? badge(meta, normalized.kind) : {}),
      filters: normalized ? describeFilters({ url: normalized.url }) : NO_FILTERS,
      copyUrl: normalized?.url,
      status: 'saved',
      pending,
      sharedTitle: false,
      sameAddressAs: [],
      caching: cachingOf(copy, ctx),
      trackOff: trackOff(pending, savedSearch, ctx.review),
      offlineOff: pending === 'needs-visit' ? OFFLINE_OFF.undescribed : ctx.jobOff(copy.key) ?? undefined,
    })
  })

  return [...lists, ...copies]
}

/** A title as titles are compared: trimmed, in any case. */
function titleKey(title: unknown): string {
  return typeof title === 'string' ? title.trim().toLowerCase() : ''
}

function titleOf(list: SavedList): string {
  return typeof list.title === 'string' ? list.title : ''
}

/** What a list's emptied title field shows: its default title, which a blank title commits to, else, with none, the tail of its URL, as the review's List source facet names such a list. */
export function titlePlaceholder(list: SavedList): string {
  return defaultTitleOf(list) || sourceLabel({ id: list.id, alias: '', url: list.url })
}

function badge(meta: TrackedMeta | null, kind: TrackedKind): Pick<SavedListRow, 'type' | 'typeTip' | 'kind'> {
  return {
    type: meta ? TRACKED_TYPE_LABELS[meta.type] : undefined,
    typeTip: meta ? defaultTitle(meta) : undefined,
    kind: KIND_LABELS[kind] ?? kind,
  }
}

/** Why a row's toggle is off, if it is: what keeps the list from ever being tracked first, then Tracked lists being off. */
function trackOff(pending: SavedListRow['pending'], search: boolean, review: boolean): string | undefined {
  if (pending === 'needs-visit')
    return TRACK_OFF.needsVisit
  if (pending === 'not-archive')
    return TRACK_OFF.notArchive
  if (!search)
    return TRACK_OFF.notSearch
  return review ? undefined : TRACK_OFF.review
}

function cachingOf(copy: StoredListRef, ctx: SavedListRowsContext): SavedListCaching {
  const { buckets, unstored } = ctx.copy(copy.key)
  return { kind: 'copy', buckets, scrapedAt: copy.scrapedAt, unstored }
}

/** The row without the fields it has no value for. */
function defined(row: SavedListRow): SavedListRow {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as unknown as SavedListRow
}
