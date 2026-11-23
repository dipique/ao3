/**
 * Links that name a list: the open URL, which is a list's own page on the
 * archive with `#ao3e-open=<ref>` on the end, and the reference it carries. A
 * saved list is named by its permanent id. The lists that have no record —
 * Marked for Later, the works the reader has read, and the review — are named
 * by words of their own, and live on the reader's readings.
 *
 * Import-free but for the tracked-lists module, so it loads under a plain
 * `node --test`.
 */

import type { SnapshotDescriptor } from './cache.ts'
import type { SavedList } from './savedLists.ts'
import type { TrackedKind, TrackedList } from './trackedLists.ts'

import { defaultTitle, fragmentParam, fragmentText, isListId, listPage, normalizeTrackedUrl, onListPage, parseArchiveUrl, sourceLabel, trackedMeta } from './trackedLists.ts'

/** What an open URL names: a saved list, by its id, or a list that has no record. */
export type ListRef = { kind: 'list', id: string } | { kind: 'marked-for-later' | 'read-works' | 'review' }

/** A list without a record. */
export type BuiltinKind = Exclude<ListRef['kind'], 'list'>

/** The fragment parameter an open URL carries its reference in: `#ao3e-open=<ref>`. */
const OPEN_FRAGMENT = 'ao3e-open'

/** The review's own link, which opens it as `#ao3e-open=…` does. */
const REVIEW_FRAGMENT = 'ao3e-tracked'

/**
 * The word a link names each list without a record by: the source id its copy
 * is stored under. Each holds a hyphen, which no id can ({@link isListId}), so
 * no saved list is ever read as one of them, nor one of them as a saved list.
 */
const BUILTIN_NAMES: Readonly<Record<BuiltinKind, string>> = {
  'marked-for-later': 'marked-for-later',
  'read-works': 'read-works',
  'review': 'tracked-review',
}

/** What each list without a record is called where a link names it. */
export const BUILTIN_TITLES: Readonly<Record<BuiltinKind, string>> = {
  'marked-for-later': 'Marked for Later',
  'read-works': 'Read works',
  'review': 'the review',
}

/** Where each list without a record is, under the reader's `/users/<id>`. */
const READINGS_PAGES: Readonly<Record<BuiltinKind, string>> = {
  'marked-for-later': '/readings?show=to-read',
  'read-works': '/readings',
  'review': '/readings',
}

/**
 * The page on the archive a list opens on, as a path, for the caller to make
 * absolute: a saved list's own page ({@link listPage}), `list` being the record
 * `ref` names; Marked for Later's own page; and the reader's readings for the
 * works they have read and the review, which have no page of their own on the
 * archive. Null for a saved list with no page, or with an id no link can carry,
 * and, without the reader's account, for the rest.
 */
export function hostPage(ref: ListRef, list: SavedList | null, userId?: string): string | null {
  if (ref.kind === 'list')
    return list && list.id === ref.id && isListId(ref.id) ? listPage(list) : null
  return userId ? `/users/${encodeURIComponent(userId)}${READINGS_PAGES[ref.kind]}` : null
}

/**
 * The open URL: `page`, the list's {@link hostPage}, with `#ao3e-open=<ref>` in
 * place of any fragment it had. Read back by {@link openTarget}. The fragment
 * never reaches the archive.
 */
export function openLink(ref: ListRef, page: string): string {
  const name = ref.kind === 'list' ? ref.id : BUILTIN_NAMES[ref.kind]
  return `${page.split('#')[0]}#${OPEN_FRAGMENT}=${name}`
}

/**
 * The list an open URL names, read from the page's fragment (`location.hash`,
 * with or without its `#`), or from the review's own `#ao3e-tracked`. Null for
 * any other fragment. Whether an id still names a list is for the caller to
 * check.
 */
export function openTarget(hash: string): ListRef | null {
  if (fragmentText(hash) === REVIEW_FRAGMENT)
    return { kind: 'review' }
  const name = fragmentParam(hash, OPEN_FRAGMENT)
  const builtin = (Object.keys(BUILTIN_NAMES) as BuiltinKind[]).find(kind => BUILTIN_NAMES[kind] === name)
  if (builtin)
    return { kind: builtin }
  return isListId(name) ? { kind: 'list', id: name } : null
}

/**
 * The search view a list opens in: a saved list's kind's, or the view of a
 * list without a record.
 */
export type ListHost = TrackedKind | BuiltinKind

/** What an open URL asks of the page it opens: the list, and the view to open it in. */
export interface OpenAsk {
  ref: ListRef
  host: ListHost
  /** The saved list `ref` names; null for a list without a record. */
  list: SavedList | null
}

/**
 * What the open URL `ref` was read from asks of its page, `href`: the saved list
 * of `lists` it names, on that list's own page ({@link onListPage}); Marked for
 * Later on a reader's to-read list; or the works read or the review on either
 * half of a reader's readings, where their views open. Null when the ref names
 * no list this page opens: an id none of `lists` has, or a list whose page this
 * isn't. Whose readings they are, and whether the reader is signed in, is the
 * page's to say.
 *
 * `lists` is every saved list, an entry the planner has yet to file included,
 * so that a list tracked on another browser opens here as soon as it is pulled.
 */
export function openAsk(ref: ListRef, lists: readonly SavedList[], href: string): OpenAsk | null {
  if (ref.kind === 'list') {
    const list = lists.find(one => one.id === ref.id)
    return list && onListPage(list, href) ? { ref, host: list.kind, list } : null
  }
  const half = readingsHalf(href)
  const here = ref.kind === 'marked-for-later' ? half === 'to-read' : half !== null
  return here ? { ref, host: ref.kind, list: null } : null
}

/** The reader's settings that decide whether a list without a record has anything to open. */
export interface BuiltinSettings {
  trackedLists: { lists: readonly Pick<TrackedList, 'tracked'>[] }
  workMarks: { enabled: boolean }
}

/**
 * Whether the view of a list without a record opens on its page, by the
 * reader's settings: the review only with a list tracked, which it gathers
 * from; the works read only with work marks on, since the marks say which
 * works they are; Marked for Later always. Where it doesn't, its open URL
 * opens nothing, and says nothing.
 */
export function builtinOpens(kind: BuiltinKind, settings: BuiltinSettings): boolean {
  switch (kind) {
    case 'review':
      return settings.trackedLists.lists.some(list => list.tracked)
    case 'read-works':
      return settings.workMarks.enabled
    case 'marked-for-later':
      return true
  }
}

/** The reader's settings a link to a list's own page depends on. */
export interface LinkSettings extends BuiltinSettings {
  /** The reader's account, whose readings the lists without a record are on. */
  user: { userId?: string }
}

/** A link to a list's own page, named for the list. */
export interface OwnPageLink {
  label: string
  /** The list's open URL there ({@link openLink}), as a path for the page to resolve. */
  href: string
}

/**
 * Where to point the reader of an open URL that its page doesn't open
 * ({@link openAsk}), when the ref names a list known here: the list's open URL
 * on its own page ({@link hostPage}). That is a saved list of `lists` with an
 * address on the archive, an open URL kept from before the list was saved
 * back to another search among them; or, with the reader's account known, a
 * list without a record, on their readings, where its view opens
 * ({@link builtinOpens}). Null for an id none of `lists` has, for a list with
 * no page to point to, and for one whose view would open nothing there.
 */
export function ownPageLink(ref: ListRef, lists: readonly SavedList[], settings: LinkSettings): OwnPageLink | null {
  if (ref.kind !== 'list' && !builtinOpens(ref.kind, settings))
    return null
  const list = ref.kind === 'list' ? lists.find(one => one.id === ref.id) ?? null : null
  const page = hostPage(ref, list, settings.user.userId)
  const name = ref.kind !== 'list' ? BUILTIN_TITLES[ref.kind] : list && `“${sourceLabel({ id: list.id, alias: list.title, url: list.url })}”`
  return page && name ? { label: `Open ${name}`, href: openLink(ref, page) } : null
}

/** Which of a reader's two readings pages `href` is, or null for any other page. */
function readingsHalf(href: string): 'to-read' | 'history' | null {
  const url = parseArchiveUrl(href)
  if (!url || !/^\/users\/[^/]+\/readings\/?$/.test(url.pathname))
    return null
  return url.searchParams.get('show') === 'to-read' ? 'to-read' : 'history'
}

/**
 * Where a stored list lives on the archive: its descriptor's own address, or,
 * failing that, a page rebuilt from its key, as a path for the caller to make
 * absolute.
 *
 * The fallback is the point rather than a nicety. A snapshot written before
 * descriptors existed has no address, and it is exactly the row that needs one:
 * the only way to make it refreshable again is to open the list on AO3 and press
 * its search button. What makes rebuilding honest is that every `SearchSource`
 * keys its snapshot on precisely the part of the address that identifies the
 * list — a username, a tag's path segment, a series' id, a search's own query —
 * so those shapes invert cleanly, and a key that fits none of them gets no page.
 * Nor do the works read and the review, which have no page of their own:
 * {@link hostPage} hosts them on the reader's readings.
 */
export function listUrlFor(key: string, descriptor?: Pick<SnapshotDescriptor, 'listUrl'>): string | undefined {
  if (descriptor?.listUrl)
    return descriptor.listUrl

  const split = key.indexOf(':')
  const rest = split < 0 ? '' : key.slice(split + 1)
  if (!rest)
    return undefined

  switch (key.slice(0, split)) {
    case 'marked-for-later':
      return `/users/${rest}${READINGS_PAGES['marked-for-later']}`
    // Already escaped the way AO3 escapes a tag in a path, which is why the key
    // holds the raw segment rather than the tag's name.
    case 'tag-works':
      return `/tags/${rest}`
    case 'series-works':
      return `/series/${rest}`
    // The search's own query string, minus the page it was read from.
    case 'text-search':
      return `/works/search?${rest}`
    default:
      return undefined
  }
}

/**
 * The key a works search's copy is stored under, from the page's query string
 * (`location.search`, with or without its `?`): its fields in one order, less
 * the page, the flag that re-renders the form, and the *Date Updated* bounds,
 * so the same search on any page, between any dates, is one copy, and two
 * searches never share one. Its sort stays, as another sort reaches other
 * works under the works ceiling.
 */
export function textSearchKey(search: string): string {
  const params = new URLSearchParams(search)
  for (const name of ['page', 'edit_search', 'work_search[date_from]', 'work_search[date_to]'])
    params.delete(name)
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
  return `text-search:${new URLSearchParams(entries).toString()}`
}

/** The key an uncommon tag's copy is stored under, from its page's path: the tag's segment, as the path spells it. */
export function tagWorksKey(pathname: string): string {
  return `tag-works:${pathname.replace(/^\/tags\/|\/$/g, '')}`
}

/**
 * The key a saved list's copy is stored under: the one its search view keys
 * the copy of the list's own page by, so a copy kept from here and one kept
 * on the page are the same copy. {@link listUrlFor} rebuilds the page from it.
 * Null for a list whose address isn't an archive page of its kind.
 */
export function copyKeyOf(list: Pick<SavedList, 'kind' | 'url'>): string | null {
  const normalized = normalizeTrackedUrl(list.url)
  const url = parseArchiveUrl(list.url)
  if (!normalized || normalized.kind !== list.kind || !url)
    return null
  switch (normalized.kind) {
    case 'works-filter':
      return normalized.key
    case 'text-search':
      return textSearchKey(url.search)
    case 'tag-works':
      return tagWorksKey(url.pathname)
    case 'series-works':
      return `series-works:${/^\/series\/(\d+)/.exec(url.pathname)?.[1]}`
  }
}

/** What a tracked list's copy is labelled with when it is first kept: the list's default title, or its own where it has none. */
export function copyLabel(list: TrackedList): string {
  const meta = trackedMeta(list)
  return meta ? defaultTitle(meta) : list.alias
}

/** The tracked lists of `entries` whose offline copy is the one stored under `key`. */
export function listsAtCopy(entries: readonly TrackedList[], key: string): TrackedList[] {
  return entries.filter(list => list.tracked && copyKeyOf(list) === key)
}
