import type { SavedList, SavedListJoin, StoredListRef } from '../../common/savedLists.ts'
import type { Day, TrackedFilterSummary, TrackedKind, TrackedList, TrackedMeta } from '../../common/trackedLists.ts'
import type { CachingBuckets } from '../../content_script/siteExport/workText.ts'
import type { BucketBar } from './buckets.ts'
import type { JobView } from './jobView.ts'

import { hostPage, openLink } from '../../common/listLinks.ts'
import { aliasOf, defaultTitleOf, SAVED_LIST_SOURCE_IDS, storedListMeta } from '../../common/savedLists.ts'
import { defaultTitle, describeFilters, formatDay, normalizeTrackedUrl, refineLink, sourceLabel, TRACKED_TYPE_LABELS, trackedMeta } from '../../common/trackedLists.ts'
import { bucketBar, formatBytes } from './buckets.ts'
import { isRunning, jobVerb, listJob, removeOff } from './jobView.ts'
import { timeAgo } from './moments.ts'
import { sentence, withReason } from './phrases.ts'

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

/**
 * What removing a stored copy does to the blurbs saved for it, for a remove
 * confirmation to say. They go at once only while *Discard unneeded blurbs
 * automatically* is on, and then only the ones no other list holds; otherwise
 * they wait for *Discard orphans*.
 */
export function blurbsOnRemove(prune: boolean): string {
  return prune
    ? 'The blurbs saved for it that no other list holds go now, since Discard unneeded blurbs automatically is on.'
    : 'The blurbs saved for it stay until Discard orphans clears them, since Discard unneeded blurbs automatically is off.'
}

/** What a row's Caching cell shows. */
export type SavedListCaching
  /** The stored list at its address, by its key. */
  = | { kind: 'copy', key: string, buckets: CachingBuckets, scrapedAt: number, unstored: number }
    /** Not cached: nothing is stored at the list's address. */
    | { kind: 'none' }

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
  /**
   * The saved list's open URL ({@link openLink}), by its id: a path, for the
   * page to make absolute. What Copy URL copies, and, with no copy, where one
   * is kept from.
   */
  open?: string
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
    const pending = address === null ? 'not-archive' : null
    const ref = { kind: 'list', id: list.id } as const
    const page = hostPage(ref, list)
    return defined({
      id: list.id,
      title: titleOf(list),
      placeholder: titlePlaceholder(list),
      titleEditable: true,
      rawKey: false,
      ...badge(trackedMeta(list), list.kind),
      filters: describeFilters(list),
      viewEdit: refineLink(list) ?? undefined,
      open: page ? openLink(ref, page) : undefined,
      status: entry ? 'tracked' : 'saved',
      pending,
      since: entry?.since,
      sharedTitle: (titles.get(titleKey(list.title)) ?? 0) > 1,
      sameAddressAs: one.sameAddress.map(nameOf),
      caching: copy ? cachingOf(copy, ctx) : { kind: 'none' },
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
      title: copyTitle(copy),
      placeholder: '',
      titleEditable: false,
      rawKey: !describedCopy,
      ...(normalized ? badge(meta, normalized.kind) : {}),
      filters: normalized ? describeFilters({ url: normalized.url }) : NO_FILTERS,
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
  return { kind: 'copy', key: copy.key, buckets, scrapedAt: copy.scrapedAt, unstored }
}

/** The row without the fields it has no value for. */
function defined(row: SavedListRow): SavedListRow {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as unknown as SavedListRow
}

/** The title a stored list no saved list is at goes by: the default its record will take, else its label, else, undescribed, its raw key. */
export function copyTitle(copy: StoredListRef): string {
  const normalized = SAVED_LIST_SOURCE_IDS.includes(copy.sourceId ?? '') ? normalizeTrackedUrl(copy.listUrl ?? '') : null
  const meta = normalized ? storedListMeta(normalized.url, copy.label ?? '') : null
  return (meta && defaultTitle(meta)) || (copy.sourceId !== undefined && copy.label?.trim()) || copy.key
}

/** A list by its title, and by what it searches where the title doesn't say: “Mine” (Search: tea). */
export function describeList(list: Pick<TrackedList, 'id' | 'alias' | 'url' | 'type' | 'entity'>): string {
  const meta = trackedMeta(list)
  const title = sourceLabel(list)
  const what = meta && titleKey(defaultTitle(meta)) !== titleKey(title) ? ` (${defaultTitle(meta)})` : ''
  return `“${title}”${what}`
}

/** Why a title typed for a list isn't saved: `takenBy` has it. */
export function titleRefusal(takenBy: SavedList): string {
  return `Another list is already called ${describeList(aliasOf(takenBy))}, so this title isn't saved. Choose a different one.`
}

/** Titles as a sentence names them: “A”, “A” and “B”, “A”, “B” and “C”. */
export function titlesInWords(titles: readonly string[]): string {
  const quoted = titles.map(title => `“${title}”`)
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}` : quoted.join('')
}

/** The other lists at a list's address, which search what it does, by title; null with none. */
export function sameSearchNote(row: Pick<SavedListRow, 'sameAddressAs'>): string | null {
  return row.sameAddressAs.length ? `Same search as ${titlesInWords(row.sameAddressAs)}` : null
}

/** How long Copy URL says it copied, in milliseconds, before it reads Copy URL again. */
export const COPIED_MS = 2000

/** Two lists share a title, as sync can bring about. */
export const SHARED_TITLE_NOTE = 'Another list has this title too. Rename one of them so they can be told apart.'

/** What View/Edit does, beside it in a row's details. */
export const VIEW_EDIT_NOTE = 'opens it ready to edit: change the search there, and the floating toolbar offers to update this list'

/** A list stored before it could be fetched again, and the one visit that fixes it. */
export const NEEDS_VISIT_NOTE = 'Needs user help. Open on AO3 using the link beside its name and press the search button. From then on, future refreshes can be done from here.'

/** A list at an address that isn't the archive's. */
export const NOT_ARCHIVE_NOTE = 'This address isn\'t a page on AO3, so it can\'t be reviewed. Remove it and track the list again from the page itself.'

/** What stopping tracking keeps, and what tracking again won't fill in. */
export const STOP_NOTE = 'It stays a Saved list, title and all. Tracking it again starts from that day, so anything it turns up in between is never reviewed.'

const STATUS_TIPS = {
  tracked: 'Tracked for your review: its new and updated works are gathered there. It does everything any other saved list does as well.',
  saved: 'Saved: kept, refreshed, cached and editable like any list, but not tracked for review. Switch it on to track it from today.',
  notSearch: 'Saved: kept, refreshed and cached like any list. Only a search, an uncommon tag or a series can be tracked for review.',
  trackedNotArchive: 'Tracked, but waiting on you: its address isn\'t a page on AO3, so nothing from it can be reviewed. Remove it and track the list again from its page.',
  savedNotArchive: 'Saved, but waiting on you: its address isn\'t a page on AO3, so it can\'t be tracked. Remove it, and keep the list again from its page.',
  needsVisit: 'Saved, but waiting on you: it was saved before the extension could fetch it again. Open it on AO3 and press its search button; until then it can\'t be refreshed or tracked.',
} as const

/** Why a row that can never be tracked from here has no switch at all. */
const NO_SWITCH = {
  needsVisit: 'Can\'t be tracked until it has been opened on AO3 once',
  notSearch: 'Can\'t be tracked: only a search, an uncommon tag or a series can be',
} as const

/**
 * A row's Status cell: the word and the line under it, what the status means
 * (its tooltip), and the tracking switch with its tooltip, which says why it
 * is off while it is. A row that can't be tracked from here at all has a glyph
 * saying so in the switch's place.
 */
export interface SavedListStatusCell {
  word: string
  detail: string
  tip: string
  toggle: { kind: 'switch' | 'none', title: string }
}

export function statusCell(row: SavedListRow): SavedListStatusCell {
  const tracked = row.status === 'tracked'
  const switchTitle = withReason(tracked ? 'Track this list for review' : 'Track this list for review, from today on', row.trackOff)
  if (row.pending === 'needs-visit')
    return { word: 'Saved (pending)', detail: 'needs one visit', tip: STATUS_TIPS.needsVisit, toggle: { kind: 'none', title: NO_SWITCH.needsVisit } }
  if (row.pending === 'not-archive') {
    return {
      word: `${tracked ? 'Tracked' : 'Saved'} (pending)`,
      detail: 'not an AO3 address',
      tip: tracked ? STATUS_TIPS.trackedNotArchive : STATUS_TIPS.savedNotArchive,
      toggle: { kind: 'switch', title: switchTitle },
    }
  }
  if (row.trackOff === TRACK_OFF.notSearch)
    return { word: 'Saved', detail: 'not tracked', tip: STATUS_TIPS.notSearch, toggle: { kind: 'none', title: NO_SWITCH.notSearch } }
  return tracked
    ? { word: 'Tracked', detail: row.since === undefined ? '' : `since ${formatDay(row.since)}`, tip: STATUS_TIPS.tracked, toggle: { kind: 'switch', title: switchTitle } }
    : { word: 'Saved', detail: 'not tracked', tip: STATUS_TIPS.saved, toggle: { kind: 'switch', title: switchTitle } }
}

/** A count and the noun it counts. */
function counted(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

/** What a job on this row's copy is doing while it runs, in the word that names it ({@link jobVerb}), or null. */
function runningHere(row: SavedListRow, view: JobView): string | null {
  return row.caching.kind === 'copy' && view.key === row.caching.key && isRunning(view) ? jobVerb(view) : null
}

/**
 * A row's Caching cell: the bar, what of its offline copy is cached and its
 * size, and how old the copy is, with its failures, or what its job is doing
 * now. Without a copy, where one comes from, muted: opening the list by its
 * open URL keeps one, whatever kind of list it is, so the line links it. A
 * list with no open URL, at no address on the archive, is kept again from its
 * page.
 */
export interface SavedListCachingCell {
  bar: BucketBar | null
  line: string
  detail: string
  muted: boolean
  /** What the detail links: the list's open URL, a path, while it has no copy. */
  link: string | null
}

export function cachingCell(row: SavedListRow, view: JobView, now: number): SavedListCachingCell {
  const { caching } = row
  if (caching.kind === 'none') {
    return row.open
      ? { bar: null, line: 'Not cached', detail: 'open it on AO3 to keep a copy', muted: true, link: row.open }
      : { bar: null, line: 'Not cached', detail: 'cache it from its page on AO3', muted: true, link: null }
  }
  const { total, cached, failed, bytes } = caching.buckets
  const phase = runningHere(row, view)
  const failures = failed ? ` · ${failed.toLocaleString()} failed` : ''
  return {
    bar: bucketBar(caching.buckets),
    line: `${cached.toLocaleString()} of ${total.toLocaleString()} cached · ${formatBytes(bytes)}`,
    detail: phase ? `${phase} now` : `as of ${timeAgo(caching.scrapedAt, now)}${failures}`,
    muted: false,
    link: null,
  }
}

/**
 * The row's own control in its Offline copy column: Download, off with the
 * reason while it can't run; Stop while its own job runs; nothing while its
 * job is stopped, whose line offers Continue and Discard, or with no copy.
 */
export type SavedListRowAction
  = | { kind: 'download', off: string | null }
    | { kind: 'stop', verb: string }
    | { kind: 'none' }

export function rowAction(row: SavedListRow, view: JobView): SavedListRowAction {
  if (row.caching.kind !== 'copy')
    return { kind: 'none' }
  const { actions } = listJob(view, row.caching.key)
  if (actions === 'stop')
    return { kind: 'stop', verb: runningHere(row, view) ?? 'working' }
  if (actions === 'resume')
    return { kind: 'none' }
  return { kind: 'download', off: row.offlineOff ?? null }
}

/** Something that can be removed, why it is off while it is, and what removing it does. */
export interface SavedListRemove {
  off: string | null
  note: string
}

/**
 * The Offline copy half of a row's details: the copy's figures, or why there
 * is none; why its actions are off, said where the reader is looking; how
 * many works a retry asks for again and how many are cached (with none, there
 * is no retry, or download without refreshing); and Remove offline copy.
 */
export interface SavedListOfflineDetails {
  summary: string | null
  empty: string | null
  note: { severity: 'neutral' | 'warning', text: string } | null
  /** Why refreshing, caching and downloading are off. */
  off: string | null
  retry: number
  cached: number
  remove: SavedListRemove | null
}

export function offlineDetails(row: SavedListRow, view: JobView, now: number, prune: boolean): SavedListOfflineDetails {
  const { caching } = row
  if (caching.kind !== 'copy') {
    const empty = row.open
      ? 'None yet. Open it on AO3 to keep a copy: from then on, it refreshes from here.'
      : 'None yet. Open the list on AO3 and press the search button there: a copy is kept from then on, and refreshes from here.'
    return { summary: null, empty, note: null, off: null, retry: 0, cached: 0, remove: null }
  }

  const { total, cached, failed, unfetched, bytes, staleFailures } = caching.buckets
  const summary = [`${counted(total, 'work', 'works')} as of ${timeAgo(caching.scrapedAt, now)}`, `${cached.toLocaleString()} cached (${formatBytes(bytes)})`]
  if (unfetched)
    summary.push(`${(failed + unfetched).toLocaleString()} uncached`)
  if (failed)
    summary.push(`${failed.toLocaleString()} failed`)
  if (caching.unstored)
    summary.push(`${caching.unstored.toLocaleString()} need refreshing`)

  const off = row.offlineOff ?? null
  const note = row.pending === 'needs-visit'
    ? { severity: 'warning' as const, text: NEEDS_VISIT_NOTE }
    : off ? { severity: 'neutral' as const, text: `${sentence(off)}.` } : null

  const others = row.sameAddressAs
  const removing = [blurbsOnRemove(prune)]
  if (cached)
    removing.push(`The ${counted(cached, 'cached work', 'cached works')} (${formatBytes(bytes)}) ${cached === 1 ? 'stays' : 'stay'}, since another list may be reading the same copies.`)
  removing.push('Opening the list on AO3 again brings it straight back.')
  if (others.length)
    removing.push(`${titlesInWords(others)} ${others.length === 1 ? 'shares this copy, and loses' : 'share this copy, and lose'} it too.`)
  if (view.key === caching.key && view.state === 'stopped')
    removing.push('Its stopped job is discarded with it.')

  return {
    summary: summary.join(' · '),
    empty: null,
    note,
    off,
    retry: failed + staleFailures,
    cached,
    remove: { off: removeOff(view, caching.key), note: removing.join(' ') },
  }
}

/**
 * The Tracking half of a row's details: what its status means, and what it
 * searches while it is tracked; what is wrong with it, for one at no address on
 * the archive; Stop tracking or Track this list, off with the reason while
 * Tracked lists is off; and Remove list, on every list with a record. A row
 * that can't be tracked from here says why, muted.
 */
export interface SavedListTrackingDetails {
  state: string | null
  muted: boolean
  what: string | null
  problem: string | null
  action: { kind: 'stop' | 'track', off: string | null } | null
  remove: SavedListRemove | null
}

export function trackingDetails(row: SavedListRow, view: JobView, prune: boolean): SavedListTrackingDetails {
  const none = { state: null, muted: false, what: null, problem: null, action: null, remove: null }
  const copyKey = row.caching.kind === 'copy' ? row.caching.key : null
  const removeList = (note: string): SavedListRemove | null => (row.titleEditable ? { off: copyKey ? removeOff(view, copyKey) : null, note } : null)
  if (row.pending === 'not-archive')
    return { ...none, problem: NOT_ARCHIVE_NOTE, remove: removeList('Forgets the list and its title. Its address isn\'t a page on AO3, so nothing was ever fetched for it.') }
  if (row.pending === 'needs-visit')
    return { ...none, state: 'Can\'t be tracked until it has been opened on AO3 once — the same visit that lets it refresh.', muted: true }
  if (row.trackOff === TRACK_OFF.notSearch)
    return { ...none, state: 'Can\'t be tracked: only a search, an uncommon tag or a series can be.', muted: true }

  const tracked = row.status === 'tracked'
  const state = tracked
    ? `Tracked since ${formatDay(row.since ?? 0)}. Its new and updated works turn up in your review.`
    : copyKey
      ? 'Not tracked. Tracking starts from today: however many works the offline copy already holds, none of them reaches the review.'
      : 'Not tracked. Tracking starts from today, so nothing from before it reaches the review.'

  const others = row.sameAddressAs
  const removing = [`Forgets the list and its title${tracked ? ', and stops tracking it' : ''}.`]
  if (copyKey) {
    removing.push(others.length
      ? `Its offline copy stays: ${titlesInWords(others)} ${others.length === 1 ? 'searches' : 'search'} the same thing.`
      : `Its offline copy goes too. ${blurbsOnRemove(prune)} Cached work text stays.`)
  }
  if (tracked)
    removing.push('To keep it without reviewing it, stop tracking it instead.')

  return {
    state,
    muted: false,
    what: tracked ? [row.kind, row.filters.text].filter(Boolean).join(' · ') || null : null,
    problem: null,
    action: { kind: tracked ? 'stop' : 'track', off: row.trackOff ?? null },
    remove: removeList(removing.join(' ')),
  }
}
