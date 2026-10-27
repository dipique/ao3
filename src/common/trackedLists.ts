/**
 * Tracked lists — saved queries (a works search, a filtered works listing, an
 * uncommon tag's works, a series) whose new and updated works are gathered into
 * one review stream. The reader looks through a range of days of that stream,
 * marks whatever deserves marking, and then marks the *range* reviewed. Nothing
 * is ever marked reviewed one work at a time: the only review state is one day
 * number, {@link TrackedListsOption.reviewedThrough}.
 *
 * This module is the decidable half of the lists themselves — days, URL
 * normalization, what a list is (its root, its type, its title and its view
 * filter), what it filters by in a line, what an update to one changes, the
 * URLs a review reads and the window's start. What the review keeps of each
 * list, and the window that makes, are `trackedReads.ts`; the reading itself
 * lives with the content script.
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
 * The archive day is only ever a query bound, never stored.
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

/**
 * What the reader calls a list: the word that heads its default title
 * ({@link defaultTitle}) and its badge. Kept apart from {@link TrackedKind}, which
 * is what the code switches on, because the two only partly line up:
 *
 * - a canonical character's listing and a fandom's are fetched identically (both
 *   `works-filter`); a tag's category never changes how its listing is read;
 * - an uncommon character tag and a canonical one read the same to the reader
 *   ("Character: Draco Malfoy") but are fetched in entirely different ways.
 *
 * The kind comes from the URL alone, because the URL is what gets fetched. The
 * type can need the page: a URL never says whether a tag is a character, so a
 * tag's list reads as `tag` until a page has named its category
 * ({@link trackedMeta}). The seven tag categories are the archive's own.
 *
 * `author` covers a user and every one of their pseuds. A pseud is never a type
 * of its own, just as it is never a root of its own ({@link trackedRoot}).
 */
export type TrackedType
  = | 'fandom'
    | 'character'
    | 'relationship'
    | 'freeform'
    | 'rating'
    | 'warning'
    | 'category'
    | 'tag'
    | 'author'
    | 'collection'
    | 'series'
    | 'search'

/**
 * Each {@link TrackedType} as the reader reads it. An additional tag reads as a
 * plain "Tag", the same as one whose category isn't known yet: readers call the
 * archive's freeform tags tags, though every category is technically one.
 */
export const TRACKED_TYPE_LABELS: Readonly<Record<TrackedType, string>> = {
  fandom: 'Fandom',
  character: 'Character',
  relationship: 'Relationship',
  freeform: 'Tag',
  rating: 'Rating',
  warning: 'Warning',
  category: 'Category',
  tag: 'Tag',
  author: 'Author',
  collection: 'Collection',
  series: 'Series',
  search: 'Search',
}

/** Every {@link TrackedType}, for validating an entry that came from storage. */
export const TRACKED_TYPES = Object.keys(TRACKED_TYPE_LABELS) as readonly TrackedType[]

/**
 * One facet group's selections in a {@link TrackedFilter}, with the search view's
 * own meaning: a work passes if it carries **any** value in `in`, **every** value
 * in `req`, and **none** in `ex`. Each list is sorted and deduplicated, and an
 * empty one is left out rather than stored.
 */
export interface TrackedFacetFilter {
  in?: string[]
  ex?: string[]
  req?: string[]
}

/**
 * A custom search's own filters: what the reader narrowed the in-memory search
 * view to, on top of the query the archive runs. The archive never sees these,
 * so they're kept on the entry and applied on this side.
 *
 * Always canonical as stored ({@link canonicalFilter}), so a key or a sync hash
 * never sees two spellings of one filter. Facet keys are the view's own group
 * names, kept as plain strings: this module doesn't need to know the list, and a
 * key a later build adds survives a round trip through an earlier one.
 */
export interface TrackedFilter {
  /** Per facet group, by its key. */
  facets?: { [key: string]: TrackedFacetFilter }
  /** The view's free-text box, trimmed, its spaces collapsed. */
  text?: string
  /** The view's word-count range, inclusive; either bound may be open (null), never both. */
  words?: [number | null, number | null]
}

/**
 * One tracked list's entry: what carries a saved list's title and query to
 * every other browser while it is tracked. Its record on each browser, under
 * the same id, is in `savedLists.ts`.
 */
export interface TrackedList {
  /**
   * Permanent short id (random, base 36). Keys the List source facet and the
   * cached window, so it never changes when the alias or the URL is edited.
   * It's also what the list *is* to the sync guard and to the refining link
   * ({@link refineLink}), since an update replaces the query and keeps the id.
   */
  id: string
  kind: TrackedKind
  /**
   * Archive path plus normalized query, without the origin — see
   * {@link normalizeTrackedUrl}. The origin is supplied when a page is fetched,
   * so an entry can only ever name a page on the archive.
   */
  url: string
  /**
   * The list's **title** — the name it's shown by everywhere. Unique among the
   * lists, compared trimmed and case-insensitively ({@link titleTakenBy}), and
   * made `Type: entity` by default ({@link defaultTitle}). Stored under its old
   * name, so nothing had to move.
   *
   * `''` for none, which only lists made before titles had a default can have.
   * The List source facet then falls back to the URL's tail ({@link sourceLabel}).
   */
  alias: string
  /**
   * What the reader calls it. Absent on lists made before it was recorded, and
   * read through {@link trackedMeta}, which fills a gap from the URL and ignores
   * a value that doesn't fit it.
   */
  type?: TrackedType
  /**
   * The root as a name: the tag, the author's account name (whichever pseud the
   * page was of), the collection, the series' title, or what's in the search's
   * subject field (its words, or failing those a title, creator or tag name).
   * Read through {@link trackedMeta}, like {@link type}.
   */
  entity?: string
  /**
   * A custom search's view filter, applied by the review on top of the query.
   * Canonical ({@link canonicalFilter}); absent when there's none, and part of
   * the list's key ({@link trackedKey}).
   */
  filter?: TrackedFilter
  /**
   * Always true on an entry: a list that isn't tracked has no entry, only its
   * saved-list record. An entry that says otherwise comes from an older build,
   * by a restore or an import, and the saved-list planner moves it into a
   * record; until it has, the review leaves it out.
   */
  tracked: boolean
  /**
   * The day tracking last started: set whenever the entry is made, so a
   * stretch the list spent untracked is never backfilled. It's only ever a
   * **floor** on this list's reading ({@link reviewStart}, and the first day
   * its read record covers) — never a second review cursor.
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

/**
 * A permanent short id for a new entry, unique among `existing`. Random rather
 * than derived from the address, because the address is editable while the id is
 * what the review's facet values and cached window are filed under.
 *
 * Every creator goes through this — the toolbar's pill and the options page
 * alike — so two entries made in two places can't collide.
 */
export function newTrackedListId(existing: readonly Pick<TrackedList, 'id'>[] = []): string {
  const taken = new Set(existing.map(entry => entry.id))
  let id = ''
  do
    id = Math.random().toString(36).slice(2, 10)
  while (!id || taken.has(id))
  return id
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

/**
 * The current **UTC** calendar day. `now` is an epoch-milliseconds time or a
 * Date. Spelled `utcToday` rather than `today` because it isn't the reader's
 * today: the archive's date filters work in UTC days, so a review's days are UTC
 * days, while the reader's own calendar (what `todayEpochDays` answers) can be
 * a day either side of it.
 */
export function utcToday(now: number | Date = Date.now()): Day {
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
export function wholeNumber(value: unknown): number | null {
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
  /**
   * Kind, path and criteria in one canonical order, sort left out, and a listing
   * filed under its path form however it was spelled ({@link listingOwner}). See
   * {@link trackedKey}.
   */
  key: string
  /**
   * The relative date bound the page carried, as the reader's query spelled it
   * (`< 2 weeks`), or null for none. It stays in {@link url} but is out of the
   * key and off every fetched page ({@link RELATIVE_DATE_PARAM}) — so a caller
   * creating a list from this page should say that it dropped it.
   */
  relativeDate: string | null
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

/**
 * The absolute date bounds a listing's sidebar and the search form set. Out of
 * every stored URL and key ({@link DROPPED_PARAMS}), and still a bound on what
 * a walk of the page reads ({@link dateFilterOf}).
 */
const DATE_BOUND_PARAMS = new Set(['work_search[date_from]', 'work_search[date_to]'])

/** Kept in the stored URL, left out of the key, and overridden at fetch time. */
const SORT_PARAMS = new Set(['work_search[sort_column]', 'work_search[sort_direction]'])

/**
 * The search form's own date field. Its values are *relative* — `< 2 weeks`,
 * `> 1 year` — so it means something different on every day it's read.
 *
 * A review supplies the date bound itself, always as an absolute day, and one of
 * these on top of it would silently empty the window of any reader further behind
 * than it reaches: "updated in the last 2 weeks" and "updated on or after three
 * weeks ago" have nothing in common. So it's kept in the stored URL (it's part of
 * the query the reader saved, and "open on the archive" should show it) but left
 * out of the key and dropped from every page a review fetches. A pill that drops
 * one says so, since the list it creates won't behave like the page it was made
 * from.
 */
const RELATIVE_DATE_PARAM = 'work_search[revised_at]'

/**
 * Parameters kept in the stored URL but left out of the key and off every
 * fetched page — the sort, which never changes *which* works a query matches,
 * and the relative date bound, which the review replaces with its own.
 */
const OVERRIDDEN_PARAMS = new Set([...SORT_PARAMS, RELATIVE_DATE_PARAM])

/**
 * Query parameters that make `/works` somebody's listing — a tag's, a user's or
 * a collection's. A tag's and a user's are what their Sort & Filter sidebar
 * submits in place of the path it was on ({@link listingOwner}). Bare `/works`
 * is no particular list. A `pseud_id` narrows a user's listing and means nothing
 * without one.
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
  const parsed = parseTracked(href)
  if (!parsed)
    return null
  return {
    kind: parsed.kind,
    url: withQuery(parsed.path, parsed.params.map(serializeParam)),
    key: keyOf(parsed),
    relativeDate: parsed.params.find(([name]) => name === RELATIVE_DATE_PARAM)?.[1] ?? null,
  }
}

/**
 * The page's date filter: the absolute date bounds its *Date Updated* sidebar
 * sets, which its {@link normalizeTrackedUrl} URL leaves out and a walk of the
 * page still reads, as a query in that URL's spelling. Null for a page with
 * none, and for one that isn't trackable. The relative bound is no part of it:
 * the URL keeps that.
 */
export function dateFilterOf(href: string): string | null {
  const bounds = parseTracked(href)?.bounds ?? []
  return bounds.length ? bounds.map(serializeParam).join('&') : null
}

/**
 * `url` with a date filter ({@link dateFilterOf}) put back on its query: the
 * read the two stand for, as {@link sameReading} compares it. `url` as it is
 * with none.
 */
export function withDateFilter(url: string, dateFilter: string | null | undefined): string {
  return dateFilter ? `${url}${url.includes('?') ? '&' : '?'}${dateFilter}` : url
}

/**
 * Whether two addresses are one read of one listing, however each is spelt:
 * the same key, and the same of what the key leaves out that still changes
 * what a walk reads — the sort, which decides which works a walk cut short by
 * the works ceiling reaches and in what order, and the date bounds, relative
 * and absolute. A sort left to the archive and the same sort chosen are told
 * apart, the archive's default not being ours to know.
 *
 * An address that isn't trackable (a reader's own readings) is the same read
 * only as the very same address.
 */
export function sameReading(a: string, b: string): boolean {
  const reading = readingOf(a)
  const other = readingOf(b)
  return reading === null && other === null ? a === b : reading === other
}

/** What {@link sameReading} compares: the key, then the sort and date bounds in one canonical order. */
function readingOf(href: string): string | null {
  const parsed = parseTracked(href)
  if (!parsed)
    return null
  const read = [...parsed.params.filter(([name]) => OVERRIDDEN_PARAMS.has(name)), ...parsed.bounds]
  return JSON.stringify([keyOf(parsed), read.map(serializeParam).sort(compareStrings)])
}

/** A parsed page's {@link NormalizedTrackedUrl.key}. */
function keyOf(parsed: ParsedTracked): string {
  const canonical = [...new Set(parsed.keyCriteria.map(serializeParam))].sort(compareStrings)
  return `${parsed.kind}:${withQuery(parsed.keyPath, canonical)}`
}

/** A trackable page taken apart: what {@link normalizeTrackedUrl}, the root, the metadata and the diff are all read from. */
interface ParsedTracked {
  kind: TrackedKind
  /** The canonical path, as the page was served. */
  path: string
  /** Every parameter the stored URL keeps, in the page's order, sort included. */
  params: [string, string][]
  /** The page's absolute date bounds, which {@link params} leaves out ({@link DATE_BOUND_PARAMS}). */
  bounds: [string, string][]
  /** The ones that decide which works match: {@link params} less the sort and the relative date bound. */
  criteria: [string, string][]
  /** Whose listing a `works-filter` page is. Null for every other kind. */
  owner: ListingOwner | null
  /** The path the key is filed under: a listing's path form, however the page spelled it. */
  keyPath: string
  /** {@link criteria} less whatever {@link keyPath} already says. */
  keyCriteria: [string, string][]
}

function parseTracked(href: string): ParsedTracked | null {
  const url = parseArchiveUrl(href)
  if (!url)
    return null
  const path = canonicalPath(url.pathname)
  if (path === null)
    return null
  const kind = kindOf(path, url.searchParams)
  if (!kind)
    return null

  const query = kind === 'works-filter' || kind === 'text-search'
    ? [...url.searchParams].filter(([, value]) => value.trim() !== '')
    : []
  const params = query.filter(([name]) => !DROPPED_PARAMS.has(name))
  const criteria = params.filter(([name]) => !OVERRIDDEN_PARAMS.has(name))
  if (kind === 'text-search' && criteria.length === 0)
    return null
  // The key puts a listing under its path form however the reader reached it,
  // so the sidebar can't move them onto a second key for the same works.
  const owner = kind === 'works-filter' ? listingOwner(path, criteria) : null
  if (kind === 'works-filter' && !owner)
    return null
  const folded = new Set(owner?.folded)
  return {
    kind,
    path,
    params,
    bounds: query.filter(([name]) => DATE_BOUND_PARAMS.has(name)),
    criteria,
    owner,
    keyPath: owner?.path ?? path,
    keyCriteria: folded.size ? criteria.filter(([name]) => !folded.has(name)) : criteria,
  }
}

/** Whose listing a `works-filter` page is ({@link listingOwner}). */
interface ListingOwner {
  type: 'tag' | 'author' | 'collection'
  /** The tag's name (the path's escapes undone), the author's account name, or the collection's name. */
  name: string
  /** The pseud, when the listing is one of an author's pseuds'. */
  pseud: string | null
  /**
   * The listing's path form, which its key is filed under. Null for a
   * collection named in the query, which is left as it is.
   */
  path: string | null
  /** What every list of this owner shares: the author's for a pseud, else the owner's own listing. */
  root: string
  /** The query parameters the path form already says, so the key leaves them out. */
  folded: readonly string[]
}

/**
 * Whose listing a `works-filter` page is, and the path form it's filed under.
 *
 * **One listing, two spellings.** Reached by a link — a tag in a blurb, an
 * author's name, the dashboard — a listing has the *path form*. Submit its Sort &
 * Filter sidebar, even with a single filter such as a language, and the archive
 * serves the very same works in the *query form*: the sidebar's form submits to
 * `/works`, with the filters first and the owner as hidden inputs last, and
 * pagination and further submits keep it there. Checked on the live archive for
 * each of the three:
 *
 * ```
 * /tags/NAME/works                 →  /works?…&tag_id=NAME
 * /users/NAME/works                →  /works?…&user_id=NAME
 * /users/NAME/pseuds/PSEUD/works   →  /works?…&pseud_id=PSEUD&user_id=NAME
 * /collections/NAME/works          →  /collections/NAME/works?…&collection_id=NUMBER
 * ```
 *
 * A list is usually tracked from the path form and refined in the query form,
 * so the key files both under the path form, or the reader's first filter would
 * move them off their own list.
 *
 * A collection's sidebar stays on the collection's own path and adds the
 * collection's **number** as `collection_id`. The archive goes by the path:
 * `/works?collection_id=1` is its Recent Works, not the collection numbered 1.
 * So on a collection's path the key leaves `collection_id` out, whatever its
 * value, and a submit that sets no filter is the link's list. The query form by
 * name, `/works?collection_id=NAME`, is served as the same listing, but the
 * archive's pages haven't been seen to lead to it, and it keeps a key of its
 * own.
 *
 * An author's listing and one of their pseuds' keep **different** keys, since
 * they match different works. Their *root* is the same — the author's
 * ({@link trackedRoot}) — because a pseud is a filter of its author, not a root
 * of its own.
 *
 * When a query names more than one owner, the archive's own order decides whose
 * listing it is — an author (with their pseud) before a collection before a tag
 * — and whatever else it names stays a filter of that listing. Owners are always
 * read by name, never by position: the sidebar does put them last, but neither
 * the key's canonical order nor the filter form's URL compression keeps them
 * there.
 *
 * `tag_id` carries the name in exactly the spelling a tag's path uses — the
 * archive's escapes for the characters a path segment can't hold already applied
 * (`*s*` for `/`, `*a*` for `&`, `*d*` for `.`, `*q*` for `?`, `*h*` for `#`),
 * and only the URL layer left to add. So the path segment is just the value
 * percent-encoded, and the lookup is by name either way. An account name and a
 * pseud's name need no escapes of their own, so theirs is the same.
 *
 * Null for a page that isn't a listing of anyone's.
 */
function listingOwner(path: string, criteria: readonly [string, string][]): ListingOwner | null {
  if (path === '/works') {
    const value = (name: string) => criteria.find(([param]) => param === name)?.[1]?.trim() || null
    const user = value('user_id')
    if (user) {
      const pseud = value('pseud_id')
      const author = `/users/${encodeURIComponent(user)}/works`
      return {
        type: 'author',
        name: user,
        pseud,
        path: pseud ? `/users/${encodeURIComponent(user)}/pseuds/${encodeURIComponent(pseud)}/works` : author,
        root: author,
        folded: pseud ? ['user_id', 'pseud_id'] : ['user_id'],
      }
    }
    const collection = value('collection_id')
    if (collection)
      return { type: 'collection', name: collection, pseud: null, path: null, root: withQuery('/works', [serializeParam(['collection_id', collection])]), folded: [] }
    const tag = value('tag_id')
    if (tag) {
      const tagPath = `/tags/${encodeURIComponent(tag)}/works`
      return { type: 'tag', name: unescapeTagName(tag), pseud: null, path: tagPath, root: tagPath, folded: ['tag_id'] }
    }
    return null
  }

  const pseud = /^\/users\/([^/]+)\/pseuds\/([^/]+)\/works$/.exec(path)
  if (pseud)
    return { type: 'author', name: decodeSegment(pseud[1]!), pseud: decodeSegment(pseud[2]!), path, root: `/users/${pseud[1]}/works`, folded: [] }
  const owner = /^\/(tags|users|collections)\/([^/]+)\/works$/.exec(path)
  if (!owner)
    return null
  const segment = decodeSegment(owner[2]!)
  const type = owner[1] === 'tags' ? 'tag' : owner[1] === 'users' ? 'author' : 'collection'
  return { type, name: type === 'tag' ? unescapeTagName(segment) : segment, pseud: null, path, root: path, folded: type === 'collection' ? ['collection_id'] : [] }
}

/**
 * The key a stored entry is matched by — to the page the reader is on (is it
 * already tracked?) and to another entry (would the two be twins?). Derived
 * from the entry's URL, the kind included, so an entry can't be matched under a
 * kind its URL doesn't have — plus its view filter, when it has one
 * ({@link filteredKey}): an exact match is the same query *and* the same view
 * filter. A stored list is joined to its list by address instead, which leaves
 * the view filter out (`addressOf`, in `savedLists.ts`), since the copy of a
 * page is the copy of every list filtering it.
 *
 * Null for an entry whose URL isn't trackable (a foreign host, say). Callers
 * comparing keys must treat a null as matching nothing — two broken entries
 * don't make one list.
 */
export function trackedKey(entry: Pick<TrackedList, 'url' | 'filter'>): string | null {
  const key = normalizeTrackedUrl(entry.url)?.key
  return key ? filteredKey(key, entry.filter) : null
}

/**
 * A URL's key ({@link NormalizedTrackedUrl.key}) with a view filter folded in:
 * the key itself when the filter is empty or absent, else the key, `#`, and the
 * filter's canonical JSON. `#` can't occur in a URL's key, whose values are all
 * escaped, so the two halves never run together.
 *
 * {@link trackedKey} is this for a stored entry. A page whose search view is open
 * is compared the same way, with the view's live filter, so a list and the page
 * it was made from key alike.
 */
export function filteredKey(key: string, filter: unknown): string {
  const canonical = canonicalFilter(filter)
  return canonical ? `${key}#${JSON.stringify(canonical)}` : key
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
export function parseArchiveUrl(href: string): URL | null {
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

/** A parameter's first value, or `''`. */
function paramValue(params: readonly [string, string][], name: string): string {
  return params.find(([param]) => param === name)?.[1] ?? ''
}

/** Trimmed, with every run of whitespace made one space. */
function collapseSpaces(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

// ---------------------------------------------------------------------------
// Roots
//
// A list is a search *of* something — a tag, an author, a collection, an
// uncommon tag, a series, a search's subject field — narrowed by filters. The
// root is that something. Two lists with one root are the same search filtered
// two ways, which is how a page that is exactly no list can still be offered as
// an update to one.
// ---------------------------------------------------------------------------

/**
 * A list's root, as `kind:identity`: what it's a search *of*. Everything else in
 * its query is a filter of that.
 *
 * - `works-filter` — the listing's owner: a tag, whatever its category (the
 *   archive runs every such listing off one tag, and to it they're all just
 *   tags); an author; or a collection. A sidebar's query form roots where its
 *   path form does, and a pseud's listing roots at its author's, the pseud being
 *   one more filter ({@link listingOwner}).
 * - `tag-works`, `series-works` — the tag's page; the series.
 * - `text-search` — its subject ({@link searchSubject}): the search's words,
 *   or, when the "Any Field" box was left empty, the first of its title,
 *   creator and tag-name fields it fills — lower-cased, and keyed with the
 *   field's name, so a fandom and a title spelled alike are two roots. So the
 *   same fandom searched for two different characters is one root, filtered
 *   two ways. A search that fills none of those fields has no root.
 *
 * Kinds never share a root, even where they name the same thing: a works search
 * for a tag's name and that tag's listing are different queries, and deciding
 * when a name means one tag across kinds would be guesswork.
 *
 * Null for an entry whose URL isn't trackable, and for a search with no subject.
 */
export function trackedRoot(entry: Pick<TrackedList, 'url'>): string | null {
  const parsed = parseTracked(entry.url)
  return parsed ? rootOf(parsed) : null
}

/** Whether two lists (or a list and a page) have a root, and the same one. */
export function sameRoot(a: Pick<TrackedList, 'url'>, b: Pick<TrackedList, 'url'>): boolean {
  const root = trackedRoot(a)
  return root !== null && root === trackedRoot(b)
}

function rootOf(parsed: ParsedTracked): string | null {
  switch (parsed.kind) {
    case 'works-filter':
      return `works-filter:${parsed.owner!.root}`
    case 'text-search': {
      const subject = searchSubject(parsed)
      return subject ? `text-search:${subject.field}=${subject.words.toLowerCase()}` : null
    }
    default:
      return `${parsed.kind}:${parsed.path}`
  }
}

/**
 * The works search fields a search can be a search *of*, first filled first: its
 * words, then its title and creator fields, then its tag fields. The form's other
 * fields — ratings, word counts, completion, excluded tags — only ever narrow
 * one of these.
 */
const SEARCH_SUBJECT_FIELDS = ['query', 'title', 'creators', 'fandom_names', 'character_names', 'relationship_names', 'freeform_names', 'other_tag_names']

/** What a works search is a search of ({@link searchSubject}). */
interface SearchSubject {
  /** The field, as the form names it inside `work_search[…]`: `query`, `fandom_names`… */
  field: string
  /** The field's parameter: `work_search[query]`. */
  param: string
  /** What's in it: trimmed, its spaces collapsed, its case as the reader typed it. */
  words: string
}

/**
 * A works search's subject: the first of {@link SEARCH_SUBJECT_FIELDS} it fills,
 * by that order rather than the address's. Null for any other kind of page, and
 * for a search that fills none of them (a rating and a word count, say).
 *
 * It is the one place that says what a search is of. Its root ({@link rootOf}),
 * the name its title gives it ({@link metaOf}) and the field its filter summary
 * leaves uncounted ({@link queryFilterCount}) are all read from it, so none of
 * them can settle on a different field from the others.
 */
function searchSubject(parsed: ParsedTracked): SearchSubject | null {
  if (parsed.kind !== 'text-search')
    return null
  for (const field of SEARCH_SUBJECT_FIELDS) {
    const param = `work_search[${field}]`
    const words = collapseSpaces(paramValue(parsed.criteria, param))
    if (words)
      return { field, param, words }
  }
  return null
}

// ---------------------------------------------------------------------------
// What a list is: its type, its entity, its title
// ---------------------------------------------------------------------------

/** What a list is, in the reader's words. */
export interface TrackedMeta {
  type: TrackedType
  /** The root as a name ({@link TrackedList.entity}); `''` when there's nothing to name it by. */
  entity: string
}

/** The archive's tag categories, and `tag` for one not yet known: all of them a tag's root. */
const TAG_TYPES = new Set<TrackedType>(['fandom', 'character', 'relationship', 'freeform', 'rating', 'warning', 'category', 'tag'])

const TYPE_NAMES = new Set<string>(TRACKED_TYPES)

/**
 * A list's type and entity: as stored, where what's stored fits the URL, and
 * otherwise what the URL alone can say. Null for an entry whose URL isn't a
 * trackable archive page.
 *
 * The URL supplies a tag's name, an author's account name (whichever pseud the
 * listing was of), a collection's name, a series' id and what a search is of
 * ({@link searchSubject}), from the same field as its root. It can't supply a
 * tag's category, so a tag's list reads as `tag` until something that has seen
 * the page stores one; nor a series' title, so a series reads as its id until
 * the same.
 *
 * What's stored is only trusted while it still describes the URL's root. Its
 * type has to be of the URL's family — any tag category on a tag's list,
 * `author` on an author's, and so on. And wherever the URL names the root itself
 * (everything but a series), a stored entity has to name the same thing, in any
 * case; the URL's spelling is the one shown. Anything else is left over from a
 * root the list has since moved off, so the type stored with it is ignored too
 * rather than shown wrong. A series' title can't be checked against its id, so
 * anything that moves a list to another series has to store its title afresh.
 */
export function trackedMeta(entry: Pick<TrackedList, 'url' | 'type' | 'entity'>): TrackedMeta | null {
  const parsed = parseTracked(entry.url)
  if (!parsed)
    return null
  const derived = metaOf(parsed)
  const stored = typeof entry.type === 'string' && TYPE_NAMES.has(entry.type) ? entry.type : null
  if (!stored || typeFamily(stored) !== typeFamily(derived.type))
    return derived
  const entity = typeof entry.entity === 'string' ? collapseSpaces(entry.entity) : ''
  if (stored === 'series')
    return { type: stored, entity: entity || derived.entity }
  if (entity && entity.toLowerCase() !== derived.entity.toLowerCase())
    return derived
  return { type: stored, entity: derived.entity }
}

/** What the URL alone says a list is. */
function metaOf(parsed: ParsedTracked): TrackedMeta {
  switch (parsed.kind) {
    case 'works-filter':
      return { type: parsed.owner!.type, entity: parsed.owner!.name }
    case 'tag-works':
      return { type: 'tag', entity: tagName(parsed.path) }
    case 'series-works':
      return { type: 'series', entity: parsed.path.replace(/^\/series\//, '') }
    case 'text-search':
      // Named for what it's a search of, so its title and its root agree.
      return { type: 'search', entity: searchSubject(parsed)?.words ?? '' }
  }
}

/** The type a stored one has to agree with: every tag category is a tag. */
function typeFamily(type: TrackedType): TrackedType {
  return TAG_TYPES.has(type) ? 'tag' : type
}

/**
 * A list's default title, `Type: entity` — "Character: Draco Malfoy", "Search:
 * coffee shop AU". The type leads because it's what a reader scans a list of
 * lists by, and lists sorted by title fall into groups by it. Just the type when
 * there's no entity. Not yet unique: offer it through {@link uniqueTitle}.
 */
export function defaultTitle(meta: TrackedMeta): string {
  const entity = collapseSpaces(meta.entity)
  return entity ? `${TRACKED_TYPE_LABELS[meta.type]}: ${entity}` : TRACKED_TYPE_LABELS[meta.type]
}

/** What a title is compared as: trimmed, in any case. */
function titleKey(title: unknown): string {
  return typeof title === 'string' ? title.trim().toLowerCase() : ''
}

/**
 * The list other than the one with id `except` whose title is already `title`,
 * or null when there's none. Titles are unique, compared trimmed and
 * case-insensitively: tracking, updating and renaming all refuse a title this
 * finds, and say which list has it.
 *
 * An empty title is never taken, so lists from before titles were unique, whose
 * alias may be blank, don't collide. Whether a blank title is acceptable at all
 * is the caller's to say.
 */
export function titleTakenBy<T extends Pick<TrackedList, 'id' | 'alias'>>(title: string, lists: readonly T[], except?: string): T | null {
  const key = titleKey(title)
  if (!key)
    return null
  return lists.find(list => list.id !== except && titleKey(list.alias) === key) ?? null
}

/**
 * `title`, trimmed — or, when another list than `except` already has it, the
 * first of `title (2)`, `title (3)`… that none has. For a generated default,
 * which is offered unique from the start; a title the reader typed is refused
 * instead ({@link titleTakenBy}).
 *
 * Two lists can still end up sharing one, made on two browsers before they
 * synced. {@link sourceLabel} tells them apart for display.
 */
export function uniqueTitle(title: string, lists: readonly Pick<TrackedList, 'id' | 'alias'>[], except?: string): string {
  const plain = typeof title === 'string' ? title.trim() : ''
  let candidate = plain
  for (let n = 2; titleTakenBy(candidate, lists, except); n++)
    candidate = `${plain} (${n})`
  return candidate
}

/** Each category as a tag's page names it, lower-cased, plus near spellings in case the wording shifts. */
const TAG_CATEGORIES: Readonly<Record<string, TrackedType>> = {
  'fandom': 'fandom',
  'character': 'character',
  'relationship': 'relationship',
  'additional tags': 'freeform',
  'additional tag': 'freeform',
  'freeform': 'freeform',
  'rating': 'rating',
  'archive warning': 'warning',
  'archive warnings': 'warning',
  'warning': 'warning',
  'category': 'category',
}

/**
 * A tag's category as its own page states it — "This tag belongs to the
 * Character Category." — or null for text that doesn't say. Every tag page the
 * archive serves, common or not, opens its profile with that sentence, so it's
 * the one place a tag's category can be read without inferring it. Takes the
 * profile's text as it comes, wrapped and indented.
 */
export function tagTypeFromProfile(text: unknown): TrackedType | null {
  if (typeof text !== 'string')
    return null
  const match = /this tag belongs to the (.+?) category/i.exec(collapseSpaces(text))
  return match ? TAG_CATEGORIES[match[1]!.toLowerCase()] ?? null : null
}

/**
 * What a page has learned about a list that the list doesn't say yet: a tag's
 * category where the list still reads "Tag", a series' title where it still
 * reads as its id. `known` is what the page says — its type and entity — and
 * the result is the list's `type` and `entity` with the gap filled, or null when
 * there's nothing to fill.
 *
 * Only placeholders are filled. A category or title the list already has stays,
 * whatever this page says. And `known` has to describe the list's own root, by
 * {@link trackedMeta}'s rule, so a page about another tag or series teaches this
 * list nothing.
 */
export function fillMeta(entry: Pick<TrackedList, 'url' | 'type' | 'entity'>, known: TrackedMeta): Pick<TrackedList, 'type' | 'entity'> | null {
  const current = trackedMeta(entry)
  const derived = trackedMeta({ url: entry.url })
  const learned = trackedMeta({ url: entry.url, type: known?.type, entity: known?.entity })
  if (!current || !derived || !learned)
    return null
  const type = current.type === 'tag' ? learned.type : current.type
  const entity = current.type === 'series' && current.entity === derived.entity && learned.type === 'series'
    ? learned.entity
    : current.entity
  if (type === current.type && entity === current.entity)
    return null
  return { type, entity }
}

// ---------------------------------------------------------------------------
// View filters
// ---------------------------------------------------------------------------

/** A facet group's selection modes, in the order a canonical filter spells them. */
const FACET_MODES = ['in', 'ex', 'req'] as const

/**
 * A view filter in its one spelling, or `undefined` when it filters nothing.
 * Every list is deduplicated and sorted; empty values, lists and groups are
 * dropped; the text is trimmed with its spaces collapsed; a word bound is kept
 * only as a whole, non-negative count; and the fields always come in the same
 * order, so the JSON of two equal filters is equal too. Anything that isn't part
 * of a filter is left out.
 *
 * It takes whatever storage or a sync handed over, so it checks every field
 * rather than trusting the type. A facet key it doesn't recognise is kept as it
 * is: the keys are the view's to interpret, and a later build's are no less
 * valid.
 */
export function canonicalFilter(filter: unknown): TrackedFilter | undefined {
  if (!isRecord(filter))
    return undefined
  const out: TrackedFilter = {}
  const facets = canonicalFacets(filter.facets)
  if (facets)
    out.facets = facets
  const text = typeof filter.text === 'string' ? collapseSpaces(filter.text) : ''
  if (text)
    out.text = text
  if (Array.isArray(filter.words)) {
    const words: [number | null, number | null] = [wordBound(filter.words[0]), wordBound(filter.words[1])]
    if (words[0] !== null || words[1] !== null)
      out.words = words
  }
  return out.facets || out.text || out.words ? out : undefined
}

function canonicalFacets(facets: unknown): TrackedFilter['facets'] {
  if (!isRecord(facets))
    return undefined
  const groups: [string, TrackedFacetFilter][] = []
  for (const key of Object.keys(facets).sort(compareStrings)) {
    const group = facets[key]
    if (!key || !isRecord(group))
      continue
    const selection: TrackedFacetFilter = {}
    for (const mode of FACET_MODES) {
      const values = Array.isArray(group[mode])
        ? [...new Set(group[mode].filter((value: unknown): value is string => typeof value === 'string' && value.trim() !== ''))]
        : []
      if (values.length)
        selection[mode] = values.sort(compareStrings)
    }
    if (FACET_MODES.some(mode => selection[mode]))
      groups.push([key, selection])
  }
  // Defined as own properties, so not even a key spelled `__proto__` can reach
  // the prototype.
  return groups.length ? Object.fromEntries(groups) : undefined
}

/**
 * The search view's facet groups whose values are the archive's own tags, by
 * the names a stored filter keeps them under. Language and completion aren't
 * tags: the archive filters them through fields of their own.
 */
const TAG_GROUPS: readonly string[] = ['rating', 'warnings', 'categories', 'fandoms', 'relationships', 'characters', 'freeforms']

/**
 * The tag names a stored filter excludes, in code-unit order: every excluded
 * value of a tag group. A works search can be asked to leave these out itself
 * (`work_search[excluded_tag_names]`), which the archive does for every kind of
 * tag, ratings, warnings and categories included — so a list whose view filter
 * excludes a common tag costs no more pages to read than one that doesn't.
 *
 * Only exclusions. What a filter includes or requires is still one tag among a
 * work's many, and the free text and word count are matched against the blurb,
 * so all of that stays on this side, where it is matched exactly as the view
 * matched it.
 */
export function excludedTagNames(filter: unknown): string[] {
  const facets = canonicalFilter(filter)?.facets
  const names = new Set<string>()
  for (const key of TAG_GROUPS) {
    for (const name of facets?.[key]?.ex ?? [])
      names.add(name)
  }
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A word-count bound: a whole, non-negative number, or null for none. */
function wordBound(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

// ---------------------------------------------------------------------------
// Refining a list
// ---------------------------------------------------------------------------

/** The fragment parameter a refining link carries a list's id in: `#ao3e-list=<id>`. */
export const REFINE_FRAGMENT = 'ao3e-list'

/** What an id may look like on a link: {@link newTrackedListId}'s base 36, with room to spare. */
const LINK_ID_RE = /^[0-9a-z]{1,32}$/i

/** Whether `value` can be a list's id: what {@link newTrackedListId} makes, or could have. */
export function isListId(value: unknown): value is string {
  return typeof value === 'string' && LINK_ID_RE.test(value)
}

/**
 * A list's own page on the archive — its stored URL, which for a filtered
 * listing or a works search already carries every filter of the archive's;
 * the tag's page; the series — as a path, like {@link pageUrl}'s: the caller
 * makes it absolute against the archive. Null for a list whose URL isn't an
 * archive page of its kind.
 */
export function listPage(list: Pick<TrackedList, 'kind' | 'url'>): string | null {
  const normalized = normalizeTrackedUrl(list.url)
  return normalized && normalized.kind === list.kind ? normalized.url : null
}

/**
 * Whether `href` is the list's own page ({@link listPage}): the same query,
 * whatever its page number, its sort or the spelling of its address.
 */
export function onListPage(list: Pick<TrackedList, 'kind' | 'url'>, href: string): boolean {
  const page = normalizeTrackedUrl(href)
  const own = normalizeTrackedUrl(list.url)
  return !!page && !!own && page.kind === list.kind && page.key === own.key
}

/**
 * The link that opens a list's page ({@link listPage}) to refine it, with
 * `#ao3e-list=<id>` on the end. The page it opens reads the id back
 * ({@link refiningId}) and remembers for the tab which list is being refined.
 * The fragment never reaches the archive.
 *
 * Null for an entry with no page, or whose id couldn't be read back off the
 * link.
 */
export function refineLink(entry: Pick<TrackedList, 'id' | 'kind' | 'url'>): string | null {
  const page = listPage(entry)
  if (!page || !isListId(entry.id))
    return null
  return `${page}#${REFINE_FRAGMENT}=${entry.id}`
}

/** A page's fragment (`location.hash`) without its `#`, if it has one; null for anything but a string. */
export function fragmentText(hash: unknown): string | null {
  if (typeof hash !== 'string')
    return null
  return hash.startsWith('#') ? hash.slice(1) : hash
}

/**
 * The value of parameter `name` on a fragment that is exactly `name=<value>`
 * ({@link fragmentText}), or null for any other fragment.
 */
export function fragmentParam(hash: unknown, name: string): string | null {
  const text = fragmentText(hash)
  const prefix = `${name}=`
  return text?.startsWith(prefix) ? text.slice(prefix.length) : null
}

/**
 * The list id on a refining link, read from the page's fragment
 * (`location.hash`, with or without its `#`) — or null for any fragment that
 * isn't exactly one {@link refineLink} writes. Whether the id still names a list
 * is for the caller to check.
 */
export function refiningId(hash: string): string | null {
  const id = fragmentParam(hash, REFINE_FRAGMENT)
  return isListId(id) ? id : null
}

/**
 * Where a tab keeps the list it's refining: a key in that tab's
 * `sessionStorage`. Per tab, so two tabs can refine two lists; and it outlives
 * navigation within the archive, which a fragment wouldn't — submitting a
 * listing's Sort & Filter sidebar, the very step refining is made of, loads a
 * new address without one.
 */
export const REFINING_STORAGE_KEY = 'ao3e:refining'

/** Which list a tab is refining ({@link REFINING_STORAGE_KEY}). */
export interface RefiningMark {
  /** The list's {@link TrackedList.id}. Whether it still names a list is the reader's to check. */
  id: string
  /**
   * Whether the list's view filter still has to be put back on screen. Set when
   * the tab arrives by a refining link, and cleared by whatever puts it back, so
   * that happens once, on arrival, and never over the reader's later changes.
   */
  restore: boolean
}

/** A mark as a tab stored it, or null for anything that isn't one. */
export function parseRefiningMark(text: unknown): RefiningMark | null {
  if (typeof text !== 'string')
    return null
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch {
    return null
  }
  if (!isRecord(value) || typeof value.id !== 'string' || !LINK_ID_RE.test(value.id))
    return null
  return { id: value.id, restore: value.restore === true }
}

// ---------------------------------------------------------------------------
// What an update changes
// ---------------------------------------------------------------------------

/** One line of {@link describeUpdate}. */
export interface TrackedChange {
  /**
   * Which filters it's in: `query`, the archive's own, in the URL (a listing's
   * sidebar, a search's form fields); `view`, the custom search's
   * ({@link TrackedList.filter}).
   */
  layer: 'query' | 'view'
  /** The change, for the reader: "Excludes: Draco Malfoy", "+1 excluded character", "Word count: ≥ 5,000 → any". */
  text: string
}

/** What replacing a list's query and view filter would change. */
export interface TrackedUpdate {
  /**
   * Set when the update moves the list to another root — another tag, author or
   * series, or a search for other words or of another fandom — with what it's a
   * search of now and would be after, so the move can be named before it's made.
   * Null when the root stays, or neither side has one.
   */
  root: { from: TrackedMeta, to: TrackedMeta } | null
  /** Every change, the query's before the view's. Empty when nothing a list is matched by changes. */
  changes: TrackedChange[]
}

export interface DescribeUpdateOptions {
  /**
   * A name for one value of an id parameter — the label the page's Sort &
   * Filter sidebar gives the checkbox with that `name` and `value` — or null.
   * The ids it can't name are counted instead.
   */
  nameId?: (param: string, id: string) => string | null | undefined
}

/**
 * What an update would change: `before` is the list, `after` the query and view
 * filter it would be given (and, if the caller knows them, the type and entity
 * that go with it).
 *
 * Every filter that changes gets a line, and every line says what changed by
 * name where there's a name to say: a works search's tag fields, the tags typed
 * into a sidebar's include and exclude boxes, every view filter, and whatever id
 * {@link DescribeUpdateOptions.nameId} can name. The sidebar's checkboxes submit
 * ids, which the URL alone can't name, so the rest are counted ("+1 excluded
 * character"). Other fields say what they were and would be ("Word count:
 * ≥ 5,000 → any").
 *
 * Neither the sort nor a relative date bound is a change: neither decides which
 * works a list holds. A listing's owner isn't a line either — moving to another
 * one is {@link TrackedUpdate.root} — but a pseud is, being a filter of its
 * author. A works search's subject field — its words, or the field that stands
 * in for them ({@link searchSubject}) — is both: it's the root, and a line.
 *
 * Nothing at all (no root, no lines) when either URL isn't trackable.
 */
export function describeUpdate(
  before: Pick<TrackedList, 'url' | 'filter' | 'type' | 'entity'>,
  after: Pick<TrackedList, 'url' | 'filter' | 'type' | 'entity'>,
  options: DescribeUpdateOptions = {},
): TrackedUpdate {
  const was = parseTracked(before.url)
  const now = parseTracked(after.url)
  if (!was || !now)
    return { root: null, changes: [] }
  return {
    root: rootOf(was) === rootOf(now) ? null : { from: trackedMeta(before)!, to: trackedMeta(after)! },
    changes: [
      ...queryChanges(filterParams(was), filterParams(now), now.kind, options),
      ...viewChanges(canonicalFilter(before.filter), canonicalFilter(after.filter)),
    ],
  }
}

type FilterVerb = 'include' | 'require' | 'exclude'

const FILTER_VERBS: readonly FilterVerb[] = ['include', 'require', 'exclude']
/** What heads the names a filter selects each way: in a summary and a change adding them, and a change taking them away. */
export const ADDED_VERBS: Readonly<Record<FilterVerb, string>> = { include: 'Includes', require: 'Requires', exclude: 'Excludes' }
export const REMOVED_VERBS: Readonly<Record<FilterVerb, string>> = { include: 'No longer includes', require: 'No longer requires', exclude: 'No longer excludes' }

/** One layer's changes, gathered, then written out in a fixed order by {@link changeLines}. */
interface LayerChanges {
  added: Map<FilterVerb, string[]>
  removed: Map<FilterVerb, string[]>
  /** Finished lines for what could only be counted. */
  counts: string[]
  /** `[label, was, would be]`. */
  values: [string, string, string][]
}

function newLayer(): LayerChanges {
  return { added: new Map(), removed: new Map(), counts: [], values: [] }
}

/** Names that were and would be selected one way: the difference, into the layer. */
function diffNames(layer: LayerChanges, verb: FilterVerb, was: readonly string[], now: readonly string[]): void {
  const added = now.filter(name => !was.includes(name))
  const removed = was.filter(name => !now.includes(name))
  if (added.length)
    layer.added.set(verb, [...layer.added.get(verb) ?? [], ...added])
  if (removed.length)
    layer.removed.set(verb, [...layer.removed.get(verb) ?? [], ...removed])
}

/** Additions, then removals (each by verb), then counts, then values by label. */
function changeLines(layer: LayerChanges, name: TrackedChange['layer']): TrackedChange[] {
  const texts = [
    ...verbClauses(layer.added, ADDED_VERBS).map(clauseText),
    ...verbClauses(layer.removed, REMOVED_VERBS).map(clauseText),
    ...layer.counts,
    ...valuesByLabel(layer).map(([label, was, now]) => clauseText({ head: label, items: [`${was} → ${now}`] })),
  ]
  return texts.map(text => ({ layer: name, text }))
}

/**
 * One heading and what's under it: a verb and its names, or a field's label and
 * its value. A change line and a list's filter summary ({@link describeFilters})
 * are both written in these, so the two read alike.
 */
interface Clause {
  head: string
  items: string[]
}

/** `Excludes: Draco Malfoy, Ron Weasley`. */
function clauseText(clause: Clause): string {
  return `${clause.head}: ${clause.items.join(', ')}`
}

/** The names gathered under each verb, in {@link FILTER_VERBS} order and headed by `words`: a clause for each verb that has any. */
function verbClauses(names: ReadonlyMap<FilterVerb, readonly string[]>, words: Readonly<Record<FilterVerb, string>>): Clause[] {
  return FILTER_VERBS.flatMap((verb) => {
    const list = [...new Set(names.get(verb))]
    return list.length ? [{ head: words[verb], items: list }] : []
  })
}

/** A layer's `[label, was, would be]` values, in the order its lines give them. */
function valuesByLabel(layer: LayerChanges): [string, string, string][] {
  return [...layer.values].sort((a, b) => compareStrings(a[0], b[0]))
}

/** A query's filters: what its key holds, with a pseud put back as the filter of its author that it is. */
function filterParams(parsed: ParsedTracked): [string, string][] {
  const params = [...parsed.keyCriteria]
  if (parsed.owner?.pseud)
    params.push(['pseud_id', parsed.owner.pseud])
  return params
}

/** How one of the archive's fields reads in a change. */
type FieldRule
  = | { family: 'ids', verb: 'include' | 'exclude', noun: string }
    | { family: 'names', verb: 'include' | 'exclude', tag?: true }
    | { family: 'words' }
    | { family: 'value', label: string, show: (value: string) => string }

/** What the sidebar's and the search form's id fields hold the ids of. */
export const ID_NOUNS: Readonly<Record<string, string>> = {
  rating: 'rating',
  archive_warning: 'warning',
  category: 'category',
  fandom: 'fandom',
  character: 'character',
  relationship: 'relationship',
  freeform: 'additional tag',
}

const quoted = (value: string): string => `“${value}”`
const asIs = (value: string): string => value
const COMPLETION: Readonly<Record<string, string>> = { T: 'complete only', F: 'in progress only' }
const CROSSOVERS: Readonly<Record<string, string>> = { T: 'crossovers only', F: 'no crossovers' }

/** The archive's other fields: each one's label, and how a value reads where the raw one doesn't. */
const VALUE_FIELDS: Readonly<Record<string, [string, (value: string) => string]>> = {
  'work_search[complete]': ['Completion', value => COMPLETION[value] ?? value],
  'work_search[crossover]': ['Crossovers', value => CROSSOVERS[value] ?? value],
  'work_search[single_chapter]': ['Single chapter', value => (value === '1' ? 'only' : value)],
  'work_search[language_id]': ['Language', asIs],
  'work_search[word_count]': ['Word count', asIs],
  'work_search[title]': ['Title', quoted],
  'work_search[creators]': ['Creators', quoted],
  'work_search[hits]': ['Hits', asIs],
  'work_search[kudos_count]': ['Kudos', asIs],
  'work_search[comments_count]': ['Comments', asIs],
  'work_search[bookmarks_count]': ['Bookmarks', asIs],
  'pseud_id': ['Pseud', asIs],
  'collection_id': ['Collection', asIs],
}

function fieldRule(name: string, kind: TrackedKind): FieldRule {
  const sidebarIds = /^(include|exclude)_work_search\[([a-z_]+)_ids\]\[\]$/.exec(name)
  if (sidebarIds)
    return { family: 'ids', verb: sidebarIds[1] as 'include' | 'exclude', noun: idNoun(sidebarIds[2]!) }
  const formIds = /^work_search\[([a-z_]+)_ids\](?:\[\])?$/.exec(name)
  if (formIds)
    return { family: 'ids', verb: 'include', noun: idNoun(formIds[1]!) }
  if (name === 'fandom_id')
    return { family: 'ids', verb: 'include', noun: 'fandom' }
  if (name === 'work_search[excluded_tag_names]')
    return { family: 'names', verb: 'exclude' }
  if (/^work_search\[[a-z_]+_names\]$/.test(name))
    return { family: 'names', verb: 'include' }
  // A tag named alongside an owner that outranks it: a filter of that listing.
  if (name === 'tag_id')
    return { family: 'names', verb: 'include', tag: true }
  if (name === 'work_search[words_from]' || name === 'work_search[words_to]')
    return { family: 'words' }
  if (name === 'work_search[query]')
    return { family: 'value', label: kind === 'text-search' ? 'Search words' : 'Search within results', show: quoted }
  const field = VALUE_FIELDS[name]
  if (field)
    return { family: 'value', label: field[0], show: field[1] }
  const inner = /\[([^\]]+)\]/.exec(name)?.[1] ?? name
  const label = inner.replace(/_/g, ' ')
  return { family: 'value', label: label.charAt(0).toUpperCase() + label.slice(1), show: asIs }
}

function idNoun(field: string): string {
  return ID_NOUNS[field] ?? field.replace(/_/g, ' ')
}

function plural(noun: string, count: number): string {
  if (count === 1)
    return noun
  return noun.endsWith('y') ? `${noun.slice(0, -1)}ies` : `${noun}s`
}

function queryChanges(was: [string, string][], now: [string, string][], kind: TrackedKind, options: DescribeUpdateOptions): TrackedChange[] {
  const layer = newLayer()
  const valuesOf = (params: [string, string][], name: string) => [...new Set(params.filter(([param]) => param === name).map(([, value]) => value))]
  const names = [...new Set([...was, ...now].map(([name]) => name))].sort(compareStrings)
  let words = false

  for (const name of names) {
    const before = valuesOf(was, name)
    const after = valuesOf(now, name)
    const rule = fieldRule(name, kind)
    switch (rule.family) {
      case 'words':
        words = true
        break
      case 'names': {
        const split = (values: string[]) => [...new Set(values
          .flatMap(value => value.split(','))
          .map(value => collapseSpaces(rule.tag ? unescapeTagName(value) : value))
          .filter(Boolean))]
        diffNames(layer, rule.verb, split(before), split(after))
        break
      }
      case 'ids': {
        for (const [ids, into, sign] of [
          [after.filter(id => !before.includes(id)), layer.added, '+'],
          [before.filter(id => !after.includes(id)), layer.removed, '−'],
        ] as const) {
          let unnamed = 0
          for (const id of ids) {
            const label = options.nameId?.(name, id)
            const text = typeof label === 'string' ? collapseSpaces(label) : ''
            if (text)
              into.set(rule.verb, [...into.get(rule.verb) ?? [], text])
            else
              unnamed++
          }
          if (unnamed)
            layer.counts.push(`${sign}${unnamed} ${rule.verb === 'exclude' ? 'excluded' : 'included'} ${plural(rule.noun, unnamed)}`)
        }
        break
      }
      case 'value': {
        const show = (values: string[]) => (values.length ? values.map(rule.show).join(', ') : 'any')
        if (show(before) !== show(after))
          layer.values.push([rule.label, show(before), show(after)])
        break
      }
    }
  }

  if (words) {
    const bound = (params: [string, string][], name: string) => {
      const value = paramValue(params, name).trim()
      return value === '' ? null : /^\d+$/.test(value) ? Number(value) : value
    }
    const range = (params: [string, string][]) => rangeText(bound(params, 'work_search[words_from]'), bound(params, 'work_search[words_to]'))
    if (range(was) !== range(now))
      layer.values.push(['Word count', range(was), range(now)])
  }
  return changeLines(layer, 'query')
}

function viewChanges(was: TrackedFilter | undefined, now: TrackedFilter | undefined): TrackedChange[] {
  return changeLines(viewLayer(was, now), 'view')
}

/** What differs between two view filters, gathered: selections by name, the text box and word range as values. */
function viewLayer(was: TrackedFilter | undefined, now: TrackedFilter | undefined): LayerChanges {
  const layer = newLayer()
  const keys = [...new Set([...Object.keys(was?.facets ?? {}), ...Object.keys(now?.facets ?? {})])].sort(compareStrings)
  for (const key of keys) {
    for (const [mode, verb] of [['in', 'include'], ['req', 'require'], ['ex', 'exclude']] as const)
      diffNames(layer, verb, was?.facets?.[key]?.[mode] ?? [], now?.facets?.[key]?.[mode] ?? [])
  }
  const text = (filter: TrackedFilter | undefined) => (filter?.text ? quoted(filter.text) : 'any')
  if (text(was) !== text(now))
    layer.values.push(['Text', text(was), text(now)])
  const words = (filter: TrackedFilter | undefined) => rangeText(filter?.words?.[0] ?? null, filter?.words?.[1] ?? null)
  if (words(was) !== words(now))
    layer.values.push(['Word count', words(was), words(now)])
  return layer
}

/** A word-count range as the reader reads it: `1,000–5,000`, `≥ 1,000`, `≤ 5,000`, or `any`. */
function rangeText(from: number | string | null, to: number | string | null): string {
  const show = (bound: number | string) => (typeof bound === 'number' ? bound.toLocaleString('en-US') : bound)
  if (from !== null && to !== null)
    return `${show(from)}–${show(to)}`
  if (from !== null)
    return `≥ ${show(from)}`
  if (to !== null)
    return `≤ ${show(to)}`
  return 'any'
}

// ---------------------------------------------------------------------------
// What a list filters by
// ---------------------------------------------------------------------------

/** A list's filters as one line ({@link describeFilters}). */
export interface TrackedFilterSummary {
  /**
   * The line to show: as many clauses as fit, then `+N more` for the rest —
   * "2 search filters · Excludes: Draco Malfoy, Ron Weasley +3 more". `''` for a
   * list with no filters of either kind.
   */
  text: string
  /** Every clause, nothing left out: {@link text} itself when that is all of it. */
  full: string
  /** How many conditions {@link text} leaves out: names, a text box, a word range. 0 when none. */
  more: number
}

export interface DescribeFiltersOptions {
  /**
   * How long {@link TrackedFilterSummary.text} may run, in characters, `+N more`
   * included. The archive's filters and one of the view's always show, however
   * long. By default {@link FILTER_SUMMARY_LENGTH}.
   */
  maxLength?: number
}

/** About what one line of small print holds on the options page before it has to wrap. */
export const FILTER_SUMMARY_LENGTH = 80

/** What the clauses of a summary are joined by. */
const SUMMARY_SEPARATOR = ' · '

/**
 * What a list filters by, in a line: the archive's filters **counted** ("4 search
 * filters"), then the view filter's **by name** ("Excludes: Draco Malfoy", "Word
 * count: ≥ 5,000").
 *
 * The view's are worded exactly as {@link describeUpdate} words adding them to a
 * list that had none, so the summary and the change lines an update shows speak
 * one vocabulary. The archive's are only counted, because a list's link opens its
 * search with every one of them on screen, and because most are ids the URL
 * can't name.
 *
 * A filter of the archive's is a criterion as the key holds it — each parameter
 * and value once, so neither the sort nor a relative date bound — less what the
 * list is a search *of*: a listing's owner, a works search's subject field (its
 * words, or the field that stands in for them). So a search of a fandom for one
 * character counts the character and not the fandom, just as an update that
 * changes the fandom moves its root and one that changes the character doesn't.
 * A pseud counts, being a filter of its author ({@link trackedRoot}); so does a
 * tag named beside an author who owns the listing.
 *
 * When the whole line is longer than {@link DescribeFiltersOptions.maxLength},
 * {@link TrackedFilterSummary.text} stops at the last name that fits, and says
 * how many conditions it left out. Nothing at all for a list with no filters, or
 * whose URL isn't trackable.
 */
export function describeFilters(entry: Pick<TrackedList, 'url' | 'filter'>, options: DescribeFiltersOptions = {}): TrackedFilterSummary {
  const parsed = parseTracked(entry.url)
  if (!parsed)
    return { text: '', full: '', more: 0 }
  const count = queryFilterCount(parsed)
  const lead = count ? [`${count} ${plural('search filter', count)}`] : []
  const layer = viewLayer(undefined, canonicalFilter(entry.filter))
  const clauses = [
    ...verbClauses(layer.added, ADDED_VERBS),
    ...valuesByLabel(layer).map(([label, , now]) => ({ head: label, items: [now] })),
  ]
  const full = [...lead, ...clauses.map(clauseText)].join(SUMMARY_SEPARATOR)
  const maxLength = options.maxLength ?? FILTER_SUMMARY_LENGTH
  if (full.length <= maxLength)
    return { text: full, full, more: 0 }

  // Name by name, so a long list of exclusions is cut between two names rather
  // than dropped whole — and never cut before its first one, so the line always
  // says something the view filters by.
  const total = clauses.reduce((sum, clause) => sum + clause.items.length, 0)
  const shown = [...lead]
  let used = 0
  for (const clause of clauses) {
    const taken: string[] = []
    for (const item of clause.items) {
      const line = [...shown, clauseText({ head: clause.head, items: [...taken, item] })].join(SUMMARY_SEPARATOR)
      const left = total - used - 1
      if (used > 0 && `${line}${moreText(left)}`.length > maxLength)
        break
      taken.push(item)
      used++
    }
    if (taken.length)
      shown.push(clauseText({ head: clause.head, items: taken }))
    if (taken.length < clause.items.length)
      break
  }
  const more = total - used
  return { text: `${shown.join(SUMMARY_SEPARATOR)}${moreText(more)}`, full, more }
}

/** ` +3 more`, or nothing for none. */
function moreText(count: number): string {
  return count > 0 ? ` +${count} more` : ''
}

/**
 * How many filters of the archive's a query holds, by {@link describeFilters}'
 * rule: the criteria its key holds, and a pseud, less the query's root.
 */
function queryFilterCount(parsed: ParsedTracked): number {
  const owner = parsed.owner
  const subject = searchSubject(parsed)
  const isRoot = ([name, value]: [string, string]): boolean =>
    name === subject?.param
    // A collection named in the query: the one owner the key doesn't fold into a path.
    || (name === 'collection_id' && owner?.type === 'collection' && value.trim() === owner.name)
  return new Set(filterParams(parsed).filter(param => !isRoot(param)).map(serializeParam)).size
}

// ---------------------------------------------------------------------------
// Updating a list
// ---------------------------------------------------------------------------

/** The page a list is to search instead ({@link requery}). */
export interface TrackedListChange {
  /** The page's address, as the reader has it; normalized on the way in. */
  url: string
  /** The page's view filter, or none. Stored canonical, and dropped when it filters nothing. */
  filter?: unknown
  /**
   * What the page says the list now is — a tag's category, a series' title —
   * where it knows. Whatever it doesn't know is kept from the list while that
   * still fits the new query, and otherwise read off the URL.
   */
  meta?: TrackedMeta | null
  /** A `tag-works` list's {@link TrackedList.scan}, when the page has checked it afresh. Kept when absent. */
  scan?: boolean
}

/**
 * The fields that say what a list searches: everything an update replaces, and
 * everything a saved list shares with its tracked entry besides the title.
 */
export type TrackedQuery = Pick<TrackedList, 'kind' | 'url' | 'type' | 'entity' | 'filter' | 'scan'>

const QUERY_FIELDS = ['kind', 'url', 'type', 'entity', 'filter', 'scan'] as const

/** A list's query fields alone, leaving out the ones it doesn't have. */
export function queryOf(list: TrackedQuery): TrackedQuery {
  const query: Partial<TrackedQuery> = {}
  for (const field of QUERY_FIELDS) {
    if (list[field] !== undefined)
      Object.assign(query, { [field]: list[field] })
  }
  return query as TrackedQuery
}

/**
 * `list` searching `query` instead: every query field replaced, including the
 * ones `query` leaves out, which go; everything else kept.
 */
export function withQueryOf<T extends object>(list: T, query: TrackedQuery): Omit<T, keyof TrackedQuery> & TrackedQuery {
  const rest: Partial<TrackedQuery> = { ...list }
  for (const field of QUERY_FIELDS)
    delete rest[field]
  return { ...rest, ...queryOf(query) } as Omit<T, keyof TrackedQuery> & TrackedQuery
}

/**
 * The query a list has once it searches the page `change` describes, or null
 * when that page isn't trackable.
 *
 * Its type and entity follow the query, because it may have moved to another
 * tag or series, and a list still named for the old one would say the wrong
 * thing. What the list had stored only carries over while it keeps its root (a
 * series' title can't be checked against another series' id, so a move drops
 * it); what the page knows fills the rest. `scan` stays unless the caller has
 * checked the new tag.
 */
export function requery(before: Pick<TrackedList, 'url' | 'type' | 'entity' | 'scan'>, change: TrackedListChange): TrackedQuery | null {
  const normalized = normalizeTrackedUrl(change.url)
  if (!normalized)
    return null
  const root = trackedRoot({ url: normalized.url })
  const kept = root !== null && root === trackedRoot(before)
    ? trackedMeta({ url: normalized.url, type: before.type, entity: before.entity })!
    : trackedMeta({ url: normalized.url })!
  const meta = change.meta ? fillMeta({ url: normalized.url, ...kept }, change.meta) ?? kept : kept

  const query: TrackedQuery = { kind: normalized.kind, url: normalized.url, type: meta.type }
  if (meta.entity)
    query.entity = meta.entity
  const filter = canonicalFilter(change.filter)
  if (filter)
    query.filter = filter
  if (change.scan === true || (change.scan === undefined && before.scan === true))
    query.scan = true
  return query
}

/**
 * The title an update offers a list: its own, unless it was the default for a
 * root the new search has left, when the new root's default takes its place,
 * made unique among `lists` — so "Search: coffee" refined into a search for tea
 * isn't left calling itself coffee.
 */
export function titleAfterUpdate(
  list: Pick<TrackedList, 'id' | 'alias' | 'url' | 'type' | 'entity'>,
  url: string,
  meta: TrackedMeta,
  lists: readonly Pick<TrackedList, 'id' | 'alias'>[],
): string {
  const was = trackedMeta(list)
  const moved = trackedRoot(list) !== trackedRoot({ url })
  return was && moved && sameTitle(list.alias, defaultTitle(was))
    ? uniqueTitle(defaultTitle(meta), lists, list.id)
    : list.alias
}

/** Whether two titles are one, the way titles are compared: trimmed, in any case. */
export function sameTitle(a: unknown, b: unknown): boolean {
  return titleKey(a) === titleKey(b)
}

/**
 * An entry, or a saved list's record, as one string, whatever order storage
 * handed its fields back in. Nested values are taken as they are: a view filter
 * is always stored canonical, so its spelling is already one.
 */
export function entrySignature(entry: object): string {
  const fields = Object.entries(entry)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => compareStrings(a, b))
  return JSON.stringify(fields)
}

// ---------------------------------------------------------------------------
// The review window's start
// ---------------------------------------------------------------------------

/**
 * The first day of the review window: the day after the last one reviewed, or
 * the earliest day any tracked list began tracking, whichever is later. With no
 * review history the stream begins on the day the first list was tracked, and
 * a list added while the reader is weeks behind doesn't pour weeks of its
 * backlog in.
 *
 * An entry that isn't tracked doesn't count. A `since` or watermark that isn't a
 * whole number (storage the options layer hasn't repaired) is ignored rather
 * than trusted.
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
 * What a stored review window was gathered against. A window whose basis no
 * longer matches the options ({@link sameReviewBasis}) is about nothing at all,
 * and is gathered again rather than shown.
 */
export interface ReviewBasis {
  /** The watermark: a window that no longer follows it covers a range since dealt with. */
  reviewedThrough: Day
  /**
   * Every tracked list's identity, address, view filter, tracking date and
   * reading mode, in one string. The alias is deliberately not in it: renaming
   * a list relabels its facet on the next re-run and is no reason to read the
   * archive again. A changed filter is, since it changes which works each list wants.
   */
  listsSig: string
  /** The target the window was sized to. */
  target: number
}

/** The basis a window gathered under `option` is stored with. */
export function reviewBasis(option: Pick<TrackedListsOption, 'reviewedThrough' | 'lists' | 'target'>): ReviewBasis {
  return {
    reviewedThrough: wholeNumber(option.reviewedThrough) ?? 0,
    listsSig: listsSig(option.lists),
    target: option.target,
  }
}

/** Whether a window stored with `stored` still answers to `option`. */
export function sameReviewBasis(stored: Partial<ReviewBasis>, option: Pick<TrackedListsOption, 'reviewedThrough' | 'lists' | 'target'>): boolean {
  const current = reviewBasis(option)
  return stored.reviewedThrough === current.reviewedThrough
    && stored.listsSig === current.listsSig
    && stored.target === current.target
}

function listsSig(lists: readonly TrackedList[]): string {
  // Serialized rather than joined on a separator: a URL can hold very nearly
  // any character, and two lists must never be able to spell one signature
  // between them. The filter goes on the end only when there is one, so a list
  // without one signs as it always has and no stored window goes stale over it.
  return JSON.stringify(lists
    .filter(list => list.tracked)
    .map((list) => {
      const sig: unknown[] = [list.id, list.kind, list.url, list.since, list.scan ? 1 : 0]
      const filter = canonicalFilter(list.filter)
      return filter ? [...sig, filter] : sig
    }))
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
 * The entry's own sort and its relative date bound are left off every page
 * ({@link OVERRIDDEN_PARAMS}): the review sets the sort it needs, and a bound
 * like `< 2 weeks` on top of the review's own `date_from` would empty the window
 * of any reader further behind than it reaches.
 *
 * A dated list (`works-filter`, `text-search`, `tag-works`) is read **oldest
 * first from `from`**: `work_search[sort_column]=revised_at`,
 * `work_search[sort_direction]=asc` and `work_search[date_from]=from`, whatever
 * sort its URL had. There is never a `date_to`. The archive's date bounds are
 * inclusive whole UTC days, so a query from day X is everything filed on X or
 * later, and page 1's heading count is exactly how many that is.
 *
 * A `tag-works` entry becomes a works search by the tag's name
 * (`/works/search?work_search[other_tag_names]=NAME`): the tag page lists by
 * work id and can't be filtered by date, while the search can, and also catches
 * an old work that has just been updated. Unless the entry is marked
 * {@link TrackedList.scan}, in which case the tag page itself is read, like a
 * series: just the page, since neither can be sorted or bounded, and `from` is
 * ignored.
 *
 * `exclude` is tag names the page should leave out on the archive's side
 * ({@link PageUrlOptions.exclude}).
 *
 * Null when the entry's URL isn't a trackable archive page, or doesn't match
 * its kind — an entry that arrived through sync or an import is re-checked
 * here, where it would otherwise be fetched with the reader's session.
 * Throws on a `page` or `from` that isn't a whole number, which is a caller bug.
 */
export function pageUrl(entry: Pick<TrackedList, 'kind' | 'url' | 'scan'>, from: Day, page: number, options: PageUrlOptions = {}): string | null {
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
      return datedUrl('/works/search', withExclusions([['work_search[other_tag_names]', tagName(path)]], options.exclude), from, page)
    default: {
      const params = [...new URLSearchParams(query)].filter(([name]) => !OVERRIDDEN_PARAMS.has(name) && !DROPPED_PARAMS.has(name))
      return datedUrl(path, normalized.kind === 'text-search' ? withExclusions(params, options.exclude) : params, from, page)
    }
  }
}

/** What {@link pageUrl} may add to a list's own query. */
export interface PageUrlOptions {
  /**
   * Tag names the archive should leave out of the page — the tag exclusions of
   * the list's view filter ({@link TrackedList.filter}), which a works search
   * can apply itself, so the review doesn't read pages of works only to throw
   * them away. Sent as `work_search[excluded_tag_names]`, merged into any the
   * query already names; never part of the stored URL or the key.
   *
   * Only a works search takes it: a `text-search` list, and a `tag-works` list
   * read through one. A listing's own filters are all in its URL already, and a
   * series or a scanned tag page has no field to put it in.
   */
  exclude?: readonly string[]
}

/**
 * The archive reads a `*_names` field as a list separated by commas — its tag
 * names can't contain one, nor the full-width and ideographic commas it also
 * forbids. A name that somehow does would be split into two names that aren't
 * it, so it isn't sent at all; whoever asked still has it to match on their side.
 */
const NAME_SEPARATORS = /[,，、]/

/**
 * `params` with `names` added to its `work_search[excluded_tag_names]`: appended
 * to the value the query already has (which is kept exactly as it was spelled),
 * less any name already in it, compared as the archive compares tag names — case
 * and spacing aside. The field goes where the query had it, or on the end.
 */
function withExclusions(params: [string, string][], names: readonly string[] = []): [string, string][] {
  const FIELD = 'work_search[excluded_tag_names]'
  const at = params.findIndex(([name]) => name === FIELD)
  // Normally once. Named twice, both are kept, as one list.
  const had = params.filter(([name]) => name === FIELD).map(([, value]) => value.trim()).filter(Boolean).join(',')
  const seen = new Set(had.split(NAME_SEPARATORS).map(tagNameKey).filter(Boolean))
  const added: string[] = []
  for (const name of names) {
    const tidy = collapseSpaces(name)
    const key = tagNameKey(tidy)
    if (!tidy || NAME_SEPARATORS.test(tidy) || seen.has(key))
      continue
    seen.add(key)
    added.push(tidy)
  }
  if (!added.length)
    return params
  const value = [...(had ? [had] : []), ...added].join(',')
  const out = params.filter(([name]) => name !== FIELD)
  out.splice(at === -1 ? out.length : at, 0, [FIELD, value])
  return out
}

/** A tag name as the archive tells two apart: trimmed, spaces collapsed, in any case. */
function tagNameKey(name: string): string {
  return collapseSpaces(name).toLowerCase()
}

/**
 * Page 1 of the works search a `tag-works` entry is read through, with **no date
 * bound at all** — so its heading count is every work the tag holds.
 *
 * That count is what a new entry is checked with: the archive's own tag page
 * lists the tag's works by work id, and if searching by the tag's name finds the
 * same number of works, the search can stand in for the page (which is the only
 * way to read the tag by date, and the only way to catch an *old* work that has
 * just been updated). If the two disagree, the search isn't the same list and the
 * entry is marked {@link TrackedList.scan} instead.
 *
 * Null for anything but a `tag-works` entry naming a tag page on the archive.
 */
export function tagSearchUrl(entry: Pick<TrackedList, 'kind' | 'url'>): string | null {
  const normalized = normalizeTrackedUrl(entry.url)
  if (entry.kind !== 'tag-works' || !normalized || normalized.kind !== 'tag-works')
    return null
  const at = normalized.url.indexOf('?')
  const path = at === -1 ? normalized.url : normalized.url.slice(0, at)
  return withQuery('/works/search', [serializeParam(['work_search[other_tag_names]', tagName(path)])])
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
  return unescapeTagName(decodeSegment(path.replace(/^\/tags\//, '')))
}

/** `Martin*s*West` → `Martin/West`: a tag's name with the archive's path escapes undone. */
function unescapeTagName(name: string): string {
  for (const [escape, char] of TAG_PATH_ESCAPES)
    name = name.replaceAll(escape, char)
  return name
}

/** A path segment decoded; itself when it doesn't decode. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  }
  catch {
    return segment
  }
}
