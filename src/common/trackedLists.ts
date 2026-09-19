/**
 * Tracked lists — saved queries (a works search, a filtered works listing, an
 * uncommon tag's works, a series) whose new and updated works are gathered into
 * one review stream. The reader looks through a range of days of that stream,
 * marks whatever deserves marking, and then marks the *range* reviewed. Nothing
 * is ever marked reviewed one work at a time: the only review state is one day
 * number, {@link TrackedListsOption.reviewedThrough}.
 *
 * This module is the decidable half — days, URL normalization, the URLs a
 * review fetches, and the planner that says which page to read next and when a
 * review window is settled. The fetcher that runs the planner against the
 * archive lives with the content script.
 *
 * ## Two days per work
 *
 * The archive files a work under the **UTC calendar day of its update
 * timestamp** — the *archive day*. It's what `work_search[date_from]` filters on
 * (inclusively, in whole UTC days) and what sorting by `revised_at` orders by.
 *
 * The date printed on a blurb is something else: the latest chapter's date,
 * which the posting form fills in from the author's own timezone, and which an
 * author can also set by hand. The two usually agree, but a work posted near
 * UTC midnight can carry a blurb date one day either side of its archive day,
 * and a hand-set date can be anywhere in the past.
 *
 * The review groups works by the **blurb day**, because that's the date the
 * reader sees — a range labelled 12–19 Sep shouldn't hold a work dated 11 Sep.
 * The archive day is only ever a query bound, never stored. The one-day drift is
 * absorbed by reading one archive day further on each side of a window:
 *
 * - **below**, a list's query starts at its `base`, the day before the window
 *   (or before the list's own tracking start), so a work filed the day before
 *   but dated the first day is still read;
 * - **above**, a window ending on day E is only settled once every work filed up
 *   to E + 1 has been read, so a work filed on E + 1 but dated E lands in this
 *   window, and can't fall into the gap between it and the next one.
 *
 * Together those make a reviewed range airtight for any drift of one day.
 * Larger drifts are clamped by {@link assignDay} into the range the query
 * covered, which at worst shows a work twice and never loses one.
 *
 * Import-free, so it loads under a plain `node --test`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A calendar day, as a whole number of days since 1970-01-01 — always a **UTC**
 * date (`Date.UTC(y, m, d) / 86_400_000`), because the archive's date filters
 * work in UTC days. "Today" is the current UTC date, whatever the reader's zone.
 */
export type Day = number

/**
 * What kind of query a tracked list is. Three can be read by date; a series
 * can't (it's listed in series order), so it's scanned whole.
 *
 * - `works-filter` — any works listing with the archive's Sort & Filter sidebar:
 *   a tag's, a user's, a pseud's or a collection's works, or `/works?…` with the
 *   owner in the query.
 * - `text-search` — the results of a works search, `/works/search?work_search[…]`.
 * - `tag-works` — an uncommon (non-canonical) tag's own page. That page lists by
 *   work id, so an updated old work stays buried on an early page; it's fetched
 *   through a works search by the tag's name instead ({@link pageUrl}).
 * - `series-works` — a series. Scanned.
 */
export type TrackedKind = 'works-filter' | 'text-search' | 'tag-works' | 'series-works'

/** Every {@link TrackedKind}, for validating an entry that came from storage. */
export const TRACKED_KINDS: readonly TrackedKind[] = ['works-filter', 'text-search', 'tag-works', 'series-works']

/** One tracked (or paused) query. */
export interface TrackedList {
  /**
   * Permanent short id (random, base 36). Keys the List source facet and the
   * cached window, so it never changes when the alias or the URL is edited.
   */
  id: string
  kind: TrackedKind
  /**
   * Archive path plus normalized query, without the origin — see
   * {@link normalizeTrackedUrl}. The origin is supplied when a page is fetched,
   * so an entry can only ever name a page on the archive.
   */
  url: string
  /** `''` for none. The List source facet then falls back to the URL's tail ({@link sourceLabel}). */
  alias: string
  /**
   * Off means kept but not reviewed: the entry, alias and all, stays. Any entry,
   * tracked or paused, marks its list as one the reader wants kept.
   */
  tracked: boolean
  /**
   * The day tracking last started: set when the entry is created, and again
   * whenever `tracked` goes from false to true, so a paused stretch is never
   * backfilled. It's only ever a **floor** on this list's fetch
   * ({@link reviewStart}, {@link listBase}) — never a second review cursor.
   */
  since: Day
  /**
   * `tag-works` only: a search by the tag's name didn't match the tag page's
   * own list when the entry was created, so the tag page itself is read instead
   * ({@link pageUrl}). That catches new works but not updated ones. Absent
   * otherwise.
   */
  scan?: true
}

/** The `trackedLists` option's shape. */
export interface TrackedListsOption {
  /** Master switch: the review's entry point and the toolbar pill. */
  enabled: boolean
  /** How many works a review window aims for. */
  target: number
  /** The last day marked reviewed. 0 means nothing has been reviewed yet. */
  reviewedThrough: Day
  lists: TrackedList[]
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_INDEX = new Map(MONTHS.map((name, index) => [name.toLowerCase(), index]))

/** A blurb's date as the archive prints it: `19 Jun 2012`, the day zero-padded or not. */
const BLURB_DATE_RE = /^(\d{1,2})\s+([a-z]{3})\s+(\d{4})$/i

/**
 * Parse a blurb's date (the text of its `p.datetime`, e.g. `19 Jun 2012`) into
 * a {@link Day}. The text is a calendar date with no zone, and it's read as
 * exactly that date — never through `new Date(text)`, which would read it in the
 * browser's zone and could land a day off. Null for anything that isn't one,
 * including dates that don't exist (`31 Feb 2026`).
 */
export function dayOf(dateText: string): Day | null {
  if (typeof dateText !== 'string')
    return null
  const match = BLURB_DATE_RE.exec(dateText.trim())
  if (!match)
    return null
  const month = MONTH_INDEX.get(match[2]!.toLowerCase())
  if (month === undefined)
    return null
  const date = Number(match[1])
  const year = Number(match[3])
  const ms = Date.UTC(year, month, date)
  // Date.UTC rolls an overflow into the next month; a date that didn't survive
  // the round trip wasn't a real one.
  const check = new Date(ms)
  if (check.getUTCDate() !== date || check.getUTCMonth() !== month)
    return null
  return ms / MS_PER_DAY
}

/** The current UTC calendar day. `now` is an epoch-milliseconds time or a Date. */
export function today(now: number | Date = Date.now()): Day {
  const ms = typeof now === 'number' ? now : now.getTime()
  return Math.floor(ms / MS_PER_DAY)
}

/** A day as `YYYY-MM-DD`, the spelling the archive's `date_from` takes. */
export function isoDay(day: Day): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}

/** A day the way the archive writes dates on blurbs: `05 Sep 2026`. */
export function formatDay(day: Day): string {
  const date = new Date(day * MS_PER_DAY)
  return `${String(date.getUTCDate()).padStart(2, '0')} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

/** A whole number, or null for anything else — for fields read back from storage. */
function wholeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

// ---------------------------------------------------------------------------
// URLs
//
// Every trackable page comes down to a kind, a path and a set of criteria. The
// stored `url` keeps the criteria as the reader had them, sort included, so
// "open on the archive" shows what they were looking at. The `key` leaves the
// sort out and puts everything in one order, so the same search reached two
// ways is recognised as one list. Both use the compact spelling the filter
// form's own URL compression produces — literal brackets in names, `+` for a
// space — which the archive reads exactly like the percent-encoded one and
// which costs less of the synced options' quota.
// ---------------------------------------------------------------------------

/** What {@link normalizeTrackedUrl} makes of a trackable page. */
export interface NormalizedTrackedUrl {
  kind: TrackedKind
  /** Path plus normalized query, no origin. What {@link TrackedList.url} stores. */
  url: string
  /** Kind, path and criteria in one canonical order, sort left out. See {@link trackedKey}. */
  key: string
}

const ARCHIVE_HOST = 'archiveofourown.org'

/**
 * Parameters that never change which works a query matches, dropped from both
 * the stored URL and the key: the page, the submit button's label, the form's
 * encoding marker, and the flag that re-renders the search form.
 *
 * The date bounds go too. A review always sets its own `date_from` and never
 * sends a `date_to` ({@link pageUrl}), so a bound the reader's URL happened to
 * carry never reaches the archive — keeping it would only make one tracked
 * query look like two.
 */
const DROPPED_PARAMS = new Set([
  'page',
  'commit',
  'utf8',
  'edit_search',
  'work_search[date_from]',
  'work_search[date_to]',
])

/** Kept in the stored URL, left out of the key, and overridden at fetch time. */
const SORT_PARAMS = new Set(['work_search[sort_column]', 'work_search[sort_direction]'])

/**
 * Query parameters that make `/works` somebody's listing — a tag's, a user's or
 * a collection's. They are what the Sort & Filter sidebar submits in place of
 * the path it was on. Bare `/works` is no particular list.
 */
const OWNER_PARAMS = ['tag_id', 'user_id', 'collection_id']

/** `/tags/…` paths that are the archive's own pages rather than a tag's. */
const RESERVED_TAG_PATHS = new Set(['search', 'new'])

/**
 * Recognise a trackable page, or say why not with a null.
 *
 * Accepts a full URL or a path rooted at `/`. **The origin has to be the
 * archive's** — `archiveofourown.org` or one of its subdomains, over http or
 * https — because a review fetches the page with the reader's session, so an
 * entry naming any other host (a synced or imported one, say) must never be
 * followed. Only the path is kept.
 *
 * Trackable: works listings with the Sort & Filter sidebar (`works-filter`),
 * works search results (`text-search`), a tag's own page (`tag-works` —
 * whether the tag is uncommon is for the caller to check against the page) and
 * a series (`series-works`). Everything else is null: Marked for Later, History
 * and the rest of a reader's readings, bookmark listings, a single work, and any
 * page that isn't a list of works at all. So is a search with no criteria —
 * the empty form — since it isn't a query of anything.
 *
 * Every criterion the page carries is kept: includes, excludes, word counts,
 * languages, completion, crossovers, the query text. A tag or series page takes
 * no criteria, so anything on its query string is dropped.
 */
export function normalizeTrackedUrl(href: string): NormalizedTrackedUrl | null {
  const url = parseArchiveUrl(href)
  if (!url)
    return null
  const path = canonicalPath(url.pathname)
  if (path === null)
    return null
  const kind = kindOf(path, url.searchParams)
  if (!kind)
    return null

  const params = kind === 'works-filter' || kind === 'text-search'
    ? [...url.searchParams].filter(([name, value]) => !DROPPED_PARAMS.has(name) && value.trim() !== '')
    : []
  const criteria = params.filter(([name]) => !SORT_PARAMS.has(name))
  if (kind === 'text-search' && criteria.length === 0)
    return null

  const canonical = [...new Set(criteria.map(serializeParam))].sort(compareStrings)
  return {
    kind,
    url: withQuery(path, params.map(serializeParam)),
    key: `${kind}:${withQuery(path, canonical)}`,
  }
}

/**
 * The key a stored entry is matched by — to the page the reader is on (is it
 * already tracked?) and to a stored list (which entry is it?). Derived from the
 * entry's URL alone, the kind included, so an entry can't be matched under a
 * kind its URL doesn't have.
 *
 * Null for an entry whose URL isn't trackable (a foreign host, say). Callers
 * comparing keys must treat a null as matching nothing — two broken entries
 * don't make one list.
 */
export function trackedKey(entry: Pick<TrackedList, 'url'>): string | null {
  return normalizeTrackedUrl(entry.url)?.key ?? null
}

/** How many characters of a URL a label without an alias shows. */
const LABEL_TAIL_LENGTH = 30

/**
 * The List source facet's value for a list: its alias, or when it has none,
 * `…` and the last 30 characters of its decoded URL — the end of a URL being
 * where a search's words or a listing's last filter sit.
 *
 * Pass `all` (every entry, in stored order) to make the label unique: a label
 * already taken by an earlier entry gets ` (2)`, ` (3)`… so two lists never
 * merge into one facet value. The first entry to claim a label keeps it plain,
 * which keeps labels stable as lists are added at the end.
 */
export function sourceLabel(
  entry: Pick<TrackedList, 'id' | 'alias' | 'url'>,
  all?: readonly Pick<TrackedList, 'id' | 'alias' | 'url'>[],
): string {
  if (!all)
    return plainLabel(entry)
  const entries = all.some(other => other.id === entry.id) ? all : [...all, entry]
  const taken = new Set<string>()
  for (const other of entries) {
    const plain = plainLabel(other)
    let label = plain
    for (let n = 2; taken.has(label); n++)
      label = `${plain} (${n})`
    taken.add(label)
    if (other.id === entry.id)
      return label
  }
  return plainLabel(entry)
}

/** A list's label before it's made unique: the alias, or the URL's tail. */
function plainLabel(entry: Pick<TrackedList, 'alias' | 'url'>): string {
  const alias = typeof entry.alias === 'string' ? entry.alias.trim() : ''
  if (alias)
    return alias
  const decoded = decodeLoosely(typeof entry.url === 'string' ? entry.url : '')
  // By code point, so a character outside the BMP is never cut in half.
  const chars = Array.from(decoded)
  return chars.length <= LABEL_TAIL_LENGTH ? decoded : `…${chars.slice(-LABEL_TAIL_LENGTH).join('')}`
}

/** `url` with its escapes undone, for reading; itself when it doesn't decode. */
function decodeLoosely(url: string): string {
  try {
    return decodeURIComponent(url.replace(/\+/g, ' '))
  }
  catch {
    return url
  }
}

/** A full archive URL or a rooted path, as a URL — or null if it isn't the archive's. */
function parseArchiveUrl(href: string): URL | null {
  if (typeof href !== 'string')
    return null
  const text = href.trim()
  // A path must be rooted: a bare relative one means whatever page it's read
  // on, which is exactly what a stored entry can't depend on.
  if (!/^https?:\/\//i.test(text) && !text.startsWith('/'))
    return null
  let url: URL
  try {
    url = new URL(text, `https://${ARCHIVE_HOST}`)
  }
  catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return null
  // After parsing, not before: `//elsewhere/…` and `/\elsewhere/…` are rooted
  // paths that resolve to another host, and this is what catches them.
  const host = url.hostname
  if (host !== ARCHIVE_HOST && !host.endsWith(`.${ARCHIVE_HOST}`))
    return null
  return url
}

/**
 * The path with each segment in one spelling (decoded, then encoded again, so
 * `%c3%a9`, `%C3%A9` and `é` agree) and no trailing slash. Null for a path with
 * an empty segment, which no trackable page has.
 */
function canonicalPath(pathname: string): string | null {
  const segments = pathname.replace(/\/+$/, '').split('/').slice(1)
  if (segments.length === 0 || segments.includes(''))
    return null
  return `/${segments.map(canonicalSegment).join('/')}`
}

function canonicalSegment(segment: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(segment))
  }
  catch {
    return segment
  }
}

/** Which kind of trackable page a canonical path is, or null for none. */
function kindOf(path: string, params: URLSearchParams): TrackedKind | null {
  if (path === '/works/search')
    return 'text-search'
  if (path === '/works')
    return OWNER_PARAMS.some(name => params.get(name)?.trim()) ? 'works-filter' : null
  if (/^\/(?:tags|users|collections)\/[^/]+\/works$/.test(path) || /^\/users\/[^/]+\/pseuds\/[^/]+\/works$/.test(path))
    return 'works-filter'
  const tag = /^\/tags\/([^/]+)$/.exec(path)
  if (tag)
    return RESERVED_TAG_PATHS.has(tag[1]!) ? null : 'tag-works'
  if (/^\/series\/\d+$/.test(path))
    return 'series-works'
  return null
}

/** One parameter in the compact spelling: `name[]=a+b`. */
function serializeParam([name, value]: [string, string]): string {
  const key = encodeURIComponent(name).replace(/%5B/g, '[').replace(/%5D/g, ']')
  return `${key}=${encodeURIComponent(value).replace(/%20/g, '+')}`
}

function withQuery(path: string, params: string[]): string {
  return params.length ? `${path}?${params.join('&')}` : path
}

/** Plain code-unit order: the same on every machine, unlike `localeCompare`. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// ---------------------------------------------------------------------------
// The review window's start, and each list's query floor
// ---------------------------------------------------------------------------

/**
 * The first day of the review window: the day after the last one reviewed, or
 * the earliest day any tracked list began tracking, whichever is later. With no
 * review history the stream begins on the day the first list was tracked, and
 * a list added while the reader is weeks behind doesn't pour weeks of its
 * backlog in.
 *
 * Paused lists don't count. A `since` or watermark that isn't a whole number
 * (storage the options layer hasn't repaired) is ignored rather than trusted.
 */
export function reviewStart(option: Pick<TrackedListsOption, 'reviewedThrough' | 'lists'>): Day {
  const next = (wholeNumber(option.reviewedThrough) ?? 0) + 1
  let earliest = Number.POSITIVE_INFINITY
  for (const list of option.lists ?? []) {
    const since = wholeNumber(list.since)
    if (list.tracked && since !== null)
      earliest = Math.min(earliest, since)
  }
  return Number.isFinite(earliest) ? Math.max(next, earliest) : next
}

/**
 * The day a list's query starts from: the later of its tracking start and the
 * window's start, less one day — the margin that catches a work the archive
 * filed the day before but whose blurb is dated the first day. This is
 * {@link ListProgress.base}, and the `from` a list's pages are fetched with.
 *
 * A list whose tracking began after the window starts adds nothing before that:
 * its query starts later, and the days in between are already complete for it
 * without reading a page.
 */
export function listBase(entry: Pick<TrackedList, 'since'>, start: Day): Day {
  return Math.max(wholeNumber(entry.since) ?? start, start) - 1
}

// ---------------------------------------------------------------------------
// Fetch URLs
// ---------------------------------------------------------------------------

/** Works per page on every archive listing a review reads. */
export const PAGE_SIZE = 20

/**
 * The path and query of one page of a list's fetch; the caller makes it
 * absolute against the archive.
 *
 * A dated list (`works-filter`, `text-search`, `tag-works`) is read **oldest
 * first from `from`**: `work_search[sort_column]=revised_at`,
 * `work_search[sort_direction]=asc` and `work_search[date_from]=from`, whatever
 * sort its URL had. There is never a `date_to`. The archive's date bounds are
 * inclusive whole UTC days, so a query from day X is everything filed on X or
 * later, and page 1's heading count is exactly how many that is — which is all
 * the planner needs to find where a day begins ({@link ListProgress.bounds}).
 *
 * A `tag-works` entry becomes a works search by the tag's name
 * (`/works/search?work_search[other_tag_names]=NAME`): the tag page lists by
 * work id and can't be filtered by date, while the search can, and also catches
 * an old work that has just been updated. Unless the entry is marked
 * {@link TrackedList.scan}, in which case the tag page itself is read, like a
 * series: just the page, since neither can be sorted or bounded, and `from` is
 * ignored.
 *
 * Null when the entry's URL isn't a trackable archive page, or doesn't match
 * its kind — an entry that arrived through sync or an import is re-checked
 * here, where it would otherwise be fetched with the reader's session.
 * Throws on a `page` or `from` that isn't a whole number, which is a caller bug.
 */
export function pageUrl(entry: Pick<TrackedList, 'kind' | 'url' | 'scan'>, from: Day, page: number): string | null {
  if (!Number.isSafeInteger(page) || page < 1)
    throw new RangeError(`Not a page number: ${page}`)
  if (!Number.isSafeInteger(from))
    throw new RangeError(`Not a day: ${from}`)

  const normalized = normalizeTrackedUrl(entry.url)
  if (!normalized || normalized.kind !== entry.kind)
    return null
  // A normalized URL has at most one `?`: any in a value is escaped.
  const at = normalized.url.indexOf('?')
  const path = at === -1 ? normalized.url : normalized.url.slice(0, at)
  const query = at === -1 ? '' : normalized.url.slice(at + 1)

  switch (normalized.kind) {
    case 'series-works':
      return `${path}?page=${page}`
    case 'tag-works':
      if (entry.scan)
        return `${path}?page=${page}`
      return datedUrl('/works/search', [['work_search[other_tag_names]', tagName(path)]], from, page)
    default: {
      const params = [...new URLSearchParams(query)].filter(([name]) => !SORT_PARAMS.has(name) && !DROPPED_PARAMS.has(name))
      return datedUrl(path, params, from, page)
    }
  }
}

function datedUrl(path: string, params: [string, string][], from: Day, page: number): string {
  const all: [string, string][] = [
    ...params,
    ['work_search[sort_column]', 'revised_at'],
    ['work_search[sort_direction]', 'asc'],
    ['work_search[date_from]', isoDay(from)],
    ['page', String(page)],
  ]
  return withQuery(path, all.map(serializeParam))
}

/**
 * The escapes the archive writes into a tag's path for characters a path
 * can't carry — the same table as `tagNameFromURL` in {@link file://./data.ts},
 * repeated because this module imports nothing.
 */
const TAG_PATH_ESCAPES: [string, string][] = [
  ['*s*', '/'],
  ['*a*', '&'],
  ['*d*', '.'],
  ['*q*', '?'],
  ['*h*', '#'],
]

/** `/tags/Martin*s*West` → `Martin/West`: the tag's name as a search takes it. */
function tagName(path: string): string {
  const segment = path.replace(/^\/tags\//, '')
  let name: string
  try {
    name = decodeURIComponent(segment)
  }
  catch {
    name = segment
  }
  for (const [escape, char] of TAG_PATH_ESCAPES)
    name = name.replaceAll(escape, char)
  return name
}

// ---------------------------------------------------------------------------
// Which day a work is reviewed on
// ---------------------------------------------------------------------------

/** What {@link assignDay} needs to know about the query a work was read from. */
export interface DayContext {
  /** The list's query floor, {@link listBase}: it read works filed on or after this day. */
  base: Day
  /** The window's first day, {@link reviewStart}. */
  start: Day
  /** The current UTC day. */
  today: Day
  /**
   * The list was scanned rather than read by date (a series, or a tag marked
   * {@link TrackedList.scan}), so it returned old works as well as new ones.
   */
  scanned?: boolean
}

/**
 * The day a work read from one list is reviewed on, given its blurb day — or
 * null when it doesn't belong in the stream at all.
 *
 * A work within a day of its archive day is reviewed on its blurb day. Anything
 * further off than that was hand-set, and is clamped into the range the query
 * covered, because a date outside it can't be trusted to have been shown, and
 * showing a work twice beats never showing it:
 *
 * - a blurb day of `base − 1` or `base` is **dropped**. For a list read from the
 *   window's start, that's the two days before the window, which were reviewed
 *   already. For a list whose tracking began inside the window, it's the two
 *   days before tracking began, which were never part of the stream. (The query
 *   reads from `base` only to catch works dated a day later.)
 * - a blurb day before `base − 1` counts on **`start`**. The query only returned
 *   the work because it was filed on or after `base`, so its date is hand-set,
 *   and it can't have been shown before.
 * - a blurb day after today counts on **today**.
 *
 * A **scanned** list returns old works as well as new, so a date before the
 * window is just an old work, not a suspicious one: anything up to `base` is
 * dropped, and only the future is clamped.
 *
 * A work with no readable date counts on `start` — except from a scanned list,
 * which would otherwise show it in every window.
 */
export function assignDay(blurbDay: Day, context: DayContext): Day | null {
  const { base, start, scanned } = context
  const top = Math.max(base, start - 1)
  if (!Number.isFinite(blurbDay))
    return scanned ? null : start
  const day = Math.min(blurbDay, context.today)
  if (scanned)
    return day > top ? day : null
  if (day > top)
    return day
  return day >= base - 1 ? null : start
}

// ---------------------------------------------------------------------------
// The planner
//
// A review window is whole days from `start`, as many as fit the target. Every
// tracked list is read oldest first from its `base`, one page at a time, and
// after each page the planner decides whether the window is settled or what to
// read next. It never reads further than the window needs: a reader three months
// behind costs about what a reader one day behind does.
// ---------------------------------------------------------------------------

/** One work read from a list's query. */
export interface ListItem {
  /** Short work id. The same work read from two lists is one work. */
  sid: string
  /** Its blurb day ({@link dayOf}) as read — {@link assignDay} is applied by the planner. */
  day: Day
  /**
   * Whether it counts toward the target: false for a work the rules hide, and
   * for one the reader has already dealt with (Read, or Marked for Later).
   */
  counts: boolean
}

/** How far one list's query has been read. */
export interface ListProgress {
  /** The {@link TrackedList.id}. */
  id: string
  /** The query's `date_from`, {@link listBase}. */
  base: Day
  /**
   * Works read so far, in the query's order — a contiguous prefix of it,
   * starting at its first work. **Every** work the query returned is here, the
   * ones that don't count included, and a work read twice is here twice: the
   * completeness rules compare positions in the query, so a missing row would
   * make every later one look a place early.
   */
  items: ListItem[]
  /** Page 1's heading count: how many works the query matches. Refreshed by every page. */
  total: number
  /**
   * Boundaries learned from a page-1 request at a later `date_from`: day X →
   * how many of the query's works were filed before X, i.e. `total` less that
   * request's count. Where day X begins in the query.
   */
  bounds: Map<Day, number>
  /** Every work in the query has been read (a page came back short, or `items` reached `total`). */
  exhausted: boolean
  /** A page stopped coming. Its works so far still show, but the window can't be marked reviewed. */
  failed: boolean
  /**
   * Scanned whole rather than read by date: a series, or a tag marked
   * {@link TrackedList.scan}. Its first fetch reads all of it and marks it
   * exhausted, and its old works are dropped rather than clamped ({@link assignDay}).
   */
  scanned?: boolean
}

/** A settled review window. */
export interface PlannedWindow {
  start: Day
  /** Inclusive. */
  end: Day
  /** Counting works on the window's days. */
  count: number
  /**
   * Whether the range may be marked reviewed: not when it reaches today, which
   * isn't over yet, and not when a list failed, whose works would be skipped.
   */
  reviewable: boolean
  /** Counting works per day, one entry for every day of the window, empty days included. */
  days: Map<Day, number>
  /**
   * Counting works read so far for the day after the window: what one more day
   * would add, at least. A lower bound — that day may not have been read in full.
   */
  nextDayCount: number
}

/**
 * What to do next:
 *
 * - `fetch` — read this page of the list's query;
 * - `boundary` — read page 1 of the list's query at `date_from = day`, and
 *   record where that day begins in {@link ListProgress.bounds};
 * - `window` — nothing: it's settled.
 */
export type Plan
  = | { fetch: string, page: number }
    | { boundary: string, day: Day }
    | { window: PlannedWindow }

export interface PlanOptions {
  /** The window's first day, {@link reviewStart}. */
  start: Day
  /** The current UTC day. */
  today: Day
  /** How many counting works a window aims for. */
  target: number
  /**
   * The reader moved the window's end by hand: plan exactly `[start, endOverride]`
   * instead of sizing it to the target. Kept within `start` and yesterday.
   */
  endOverride?: Day
}

/** One work of the merged stream. */
export interface MergedWork {
  /** The day it's reviewed on. */
  day: Day
  /** Whether it counts toward the target. */
  counts: boolean
  /** Every list that returned it, in list order: its List source facet values. */
  lists: string[]
}

/**
 * The lists' works as one stream, by short id, each on the day it's reviewed on
 * ({@link assignDay}, with the base of the list it was read from). Works no list
 * assigns a day are left out.
 *
 * A work read from two lists is one work. If the two reads disagree about its
 * day — it was updated in between — it goes on the **later** day, which is what
 * it is now; the earlier day would have it reviewed as a version it no longer
 * is. It counts if a read on that day says it does.
 *
 * The planner counts with this; the fetcher should build the window's works
 * and their facet values from it too, so the two can't disagree.
 */
export function mergeItems(lists: readonly ListProgress[], context: Pick<PlanOptions, 'start' | 'today'>): Map<string, MergedWork> {
  const seen = new Map<string, { day: Day | null, counts: boolean, lists: string[] }>()
  for (const list of lists) {
    const dayContext: DayContext = { base: list.base, start: context.start, today: context.today, scanned: list.scanned }
    for (const item of list.items) {
      let work = seen.get(item.sid)
      if (!work) {
        work = { day: null, counts: false, lists: [] }
        seen.set(item.sid, work)
      }
      if (!work.lists.includes(list.id))
        work.lists.push(list.id)
      const day = assignDay(item.day, dayContext)
      if (day === null)
        continue
      if (work.day === null || day > work.day) {
        work.day = day
        work.counts = item.counts
      }
      else if (day === work.day) {
        work.counts ||= item.counts
      }
    }
  }

  const merged = new Map<string, MergedWork>()
  for (const [sid, work] of seen) {
    if (work.day !== null)
      merged.set(sid, { day: work.day, counts: work.counts, lists: work.lists })
  }
  return merged
}

/**
 * Plan the next step of computing a review window: a page to read, a boundary
 * to learn, or the settled window. The fetcher calls this in a loop, applying
 * each request's result to the list's {@link ListProgress} before asking again.
 * Every request it's given changes that progress — rows are added, a bound is
 * recorded, or the list is marked exhausted or failed — which is what makes the
 * loop end.
 *
 * **When a day is complete for a list.** Blurb day `d` is complete once every
 * work filed up to `d + 1` has been read: a work filed later can't carry a
 * blurb day of `d` or earlier. That's known when
 *
 * - the list is exhausted;
 * - a boundary at `d + 2` is at or behind the rows read so far;
 * - `d` is at most the last row's blurb day less three. The rows after it were
 *   filed no earlier than it, so on the day before its blurb day at the
 *   earliest, and their own blurb days are at most a day before that;
 * - or `d` is at most the list's `base`, since the list adds nothing to those
 *   days ({@link assignDay}).
 *
 * The window is complete through `C`, the lowest of those over the lists that
 * haven't failed, and never later than yesterday.
 *
 * **Sizing it.** Works are counted per day across all the lists
 * ({@link mergeItems}). A day not yet complete has a partial count, but a
 * partial count is a lower bound, and that's all sizing needs: walking forward
 * from `start`, the first day `d` whose running total goes over the target
 * ends the window at `d − 1` (or at `start`, since a window is never less than
 * a day). That's settled once the window's own days are complete. The day that
 * tips it over only has to be *seen* tipping it — its count can only grow. If
 * nothing tips it, the window runs to yesterday once everything is complete
 * through yesterday, and the reader is caught up.
 *
 * **What to read next.** The window's tentative end `E` is where the counts so
 * far put it. The list with the lowest complete day is read further. When it has
 * already read a work dated after `E + 1`, it's probably near the point in its
 * query where `E + 2` begins, and one page-1 request at `date_from = E + 2` —
 * a boundary — says exactly where that is, which usually confirms `E` without
 * reading another page. Otherwise, or when a boundary it already has says more
 * rows are needed, it reads its next page.
 *
 * **Today** is never part of a reviewable window, because it isn't over:
 * marking it reviewed would bury every work posted later today. A reader
 * reviewed through yesterday (`start` past yesterday) gets a preview of
 * today instead, which can't be marked reviewed. So does a window whose lists
 * failed.
 *
 * **`endOverride`** replaces the sizing: the window is `[start, endOverride]`
 * once it's complete that far.
 */
export function planWindow(lists: readonly ListProgress[], options: PlanOptions): Plan {
  const { start, target } = options
  const now = options.today
  const yesterday = now - 1
  const perDay = countByDay(mergeItems(lists, { start, today: now }))
  const anyFailed = lists.some(list => list.failed)
  const active = lists.filter(list => !list.failed)
  const completeThrough = new Map(active.map(list => [list, lastCompleteDay(list)]))

  const settled = (end: Day): Plan => {
    const days = new Map<Day, number>()
    let count = 0
    for (let day = start; day <= end; day++) {
      const n = perDay.get(day) ?? 0
      days.set(day, n)
      count += n
    }
    return {
      window: {
        start,
        end,
        count,
        reviewable: !anyFailed && end < now,
        days,
        nextDayCount: perDay.get(end + 1) ?? 0,
      },
    }
  }

  const readFurther = (end: Day): Plan => {
    let pick: ListProgress | undefined
    let pickAt = Number.POSITIVE_INFINITY
    for (const [list, at] of completeThrough) {
      if (at < end && at < pickAt) {
        pick = list
        pickAt = at
      }
    }
    // Only reached when some list is short of `end`; if none is, it's settled.
    if (!pick)
      return settled(end)
    if (pick.items.length === 0)
      return { fetch: pick.id, page: 1 }
    // A boundary past today is known without asking (everything was filed
    // before it), and only exhaustion answers it. A scanned list has no dates
    // to ask about.
    const boundary = end + 2
    const latest = latestDay(pick.items)
    if (!pick.scanned && boundary <= now && latest !== null && latest > end + 1 && !boundaryPending(pick, boundary))
      return { boundary: pick.id, day: boundary }
    return { fetch: pick.id, page: Math.floor(pick.items.length / PAGE_SIZE) + 1 }
  }

  const lowest = Math.min(Number.POSITIVE_INFINITY, ...completeThrough.values())

  // Reviewed through yesterday: preview today (or, if a clock ahead of this
  // one set the watermark, an empty window at `start`), complete to the end.
  if (start > yesterday)
    return lowest >= start ? settled(start) : readFurther(start)

  const reached = Math.min(yesterday, lowest)

  if (options.endOverride !== undefined) {
    const end = Math.min(Math.max(options.endOverride, start), yesterday)
    return end <= reached ? settled(end) : readFurther(end)
  }

  const tip = tippingDay(perDay, start, now, target)
  const end = tip === null ? yesterday : Math.min(yesterday, Math.max(start, tip - 1))
  return end <= reached ? settled(end) : readFurther(end)
}

/** Counting works per day. */
function countByDay(merged: Map<string, MergedWork>): Map<Day, number> {
  const perDay = new Map<Day, number>()
  for (const work of merged.values()) {
    if (work.counts)
      perDay.set(work.day, (perDay.get(work.day) ?? 0) + 1)
  }
  return perDay
}

/** The first day from `start` whose running total goes over `target`, or null. */
function tippingDay(perDay: Map<Day, number>, start: Day, last: Day, target: number): Day | null {
  const days = [...perDay.keys()].filter(day => day >= start && day <= last).sort((a, b) => a - b)
  let total = 0
  for (const day of days) {
    total += perDay.get(day)!
    if (total > target)
      return day
  }
  return null
}

/** Whether every work in the list's query has been read. */
function isExhausted(list: ListProgress): boolean {
  return list.exhausted || (list.items.length > 0 && list.items.length >= list.total)
}

/** The last blurb day this list is complete through, by the rules on {@link planWindow}. */
function lastCompleteDay(list: ListProgress): Day {
  if (isExhausted(list))
    return Number.POSITIVE_INFINITY
  let through = list.base
  for (const [day, before] of list.bounds) {
    if (before <= list.items.length)
      through = Math.max(through, day - 2)
  }
  const last = lastDay(list.items)
  if (last !== null)
    through = Math.max(through, last - 3)
  return through
}

/** The blurb day of the last row read that has one. */
function lastDay(items: readonly ListItem[]): Day | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const day = items[i]!.day
    if (Number.isFinite(day))
      return day
  }
  return null
}

/** The latest blurb day among the rows read. */
function latestDay(items: readonly ListItem[]): Day | null {
  let latest: Day | null = null
  for (const item of items) {
    if (Number.isFinite(item.day) && (latest === null || item.day > latest))
      latest = item.day
  }
  return latest
}

/**
 * Whether a boundary at `day` is already known to be ahead of the rows read:
 * a recorded boundary at or before it is, and a day begins no earlier in the
 * query than any day before it. Asking would only say "read more" again.
 */
function boundaryPending(list: ListProgress, day: Day): boolean {
  for (const [at, before] of list.bounds) {
    if (at <= day && before > list.items.length)
      return true
  }
  return false
}
