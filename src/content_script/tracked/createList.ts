import type { NormalizedTrackedUrl, TagType, TrackedFilter, TrackedList, TrackedMeta, TrackedType } from '#common'

import { canonicalFilter, getArchiveLink, newTrackedListId, normalizeTrackedUrl, PAGE_SIZE, tagSearchUrl, tagTypeFromProfile, trackedMeta, trackedRoot, utcToday } from '#common'
import { getBlurb } from '#content_script/blurb.ts'
import { checkboxTagName } from '#content_script/filterSidebar.tsx'
import { detectFoundCount, detectPageCount, fetchPageDoc } from '#content_script/searchView/scrape.ts'
import { uncommonTagPage } from '#content_script/tagPage.ts'

/**
 * Turning the page the reader is on into a tracked list: whether it can be one,
 * what it is (a tag's category, a series' title), what its Sort & Filter sidebar
 * calls the ids in its address, and the one check a tag needs before it can be
 * read by date.
 *
 * The rules about *what* a trackable query is, how one is keyed and how a list
 * is named, are pure and live in {@link file://../../common/trackedLists.ts}.
 * This is the half that has to look at the page.
 */

/** A page the toolbar can offer to track. */
export interface TrackablePage {
  /** The query, as the stored entry will hold it. */
  normalized: NormalizedTrackedUrl
  /**
   * What the page says the list would be. A tag's category is read off the page
   * where it can be; where it can't, this still says `tag`, and
   * {@link resolveMeta} can ask the tag's own page.
   */
  meta: TrackedMeta
  /**
   * An uncommon tag's works block, when that is what this page is. It carries the
   * page count {@link needsScan} compares a search against.
   */
  listbox?: HTMLElement
}

/**
 * The page the reader is on, if it is one that can be tracked; null otherwise.
 *
 * A bare `/tags/NAME` page has to pass one more test than its URL: the archive
 * only lists works on it while the tag is *uncommon*, so a canonical tag (which
 * the archive can already filter, and whose page lists nothing) and a tag nobody
 * has used are both out. That is the same test the "Search these works" offer
 * uses — {@link file://../tagPage.ts} — so the two can't disagree about which tag
 * pages are worth anything.
 */
export function trackablePage(): TrackablePage | null {
  const normalized = normalizeTrackedUrl(location.href)
  if (!normalized)
    return null
  if (normalized.kind !== 'tag-works')
    return { normalized, meta: pageMeta(normalized) }
  const tag = uncommonTagPage()
  return tag ? { normalized, meta: pageMeta(normalized), listbox: tag.listbox } : null
}

/**
 * What this page says the list would be: the URL's type and entity, with what
 * only the page can supply filled in — a tag's category and a series' title.
 * Nothing is fetched.
 *
 * - An uncommon tag's page states its own category.
 * - A tag's filtered listing doesn't, but every blurb on it files the tag under
 *   its category — in its characters, its relationships, its fandom heading, its
 *   required tags — and the blurb parser the rules use already reads which. The
 *   first blurb that carries the tag by name settles it. One that carries only a
 *   synonym of it doesn't, which is when {@link resolveMeta} is needed.
 * - A series' page is headed by its title.
 */
function pageMeta(normalized: NormalizedTrackedUrl): TrackedMeta {
  const derived = trackedMeta({ url: normalized.url })!
  if (derived.type === 'tag') {
    const type = normalized.kind === 'tag-works' ? profileCategory(document) : blurbCategory(derived.entity)
    return type ? { type, entity: derived.entity } : derived
  }
  if (derived.type === 'series') {
    const title = pageHeading()
    return title ? { type: 'series', entity: title } : derived
  }
  return derived
}

/** Each of the rules' tag types as the list type it is. */
const TAG_TYPE_OF: Readonly<Record<TagType, TrackedType>> = {
  r: 'rating',
  w: 'warning',
  c: 'category',
  f: 'fandom',
  R: 'relationship',
  C: 'character',
  F: 'freeform',
}

/** How two tag names are compared: case and spacing aside. */
function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** The category of the tag named `name`, from the first blurb on the page that carries it. */
function blurbCategory(name: string): TrackedType | null {
  const wanted = nameKey(name)
  for (const blurb of document.querySelectorAll('#main li.blurb')) {
    const tag = getBlurb(blurb).tags.find(one => one.type && nameKey(one.name) === wanted)
    if (tag?.type)
      return TAG_TYPE_OF[tag.type]
  }
  return null
}

/** The category a tag's own page states, in its profile block. */
function profileCategory(doc: Document): TrackedType | null {
  const profile = doc.querySelector('#main div.tag.profile') ?? doc.querySelector('#main')
  return tagTypeFromProfile(profile?.textContent ?? '')
}

/** The page's own title, as the archive prints it above the content. */
function pageHeading(): string {
  return document.querySelector('#main h2.heading')?.textContent?.trim().replace(/\s+/g, ' ') ?? ''
}

/**
 * What a tag's category turned out to be, by the tag's own page — asked at most
 * once per page load, whoever asks.
 */
const categoryRequests = new Map<string, Promise<TrackedType | null>>()

/**
 * {@link TrackablePage.meta}, with a tag's category settled: when no blurb on a
 * tag's filtered listing names the tag, this asks the tag's own page, once. Asked
 * only when a list is about to be named or written — never just because a page
 * was opened — and never again on this page, whatever the answer.
 *
 * Any failure leaves the category unknown (`tag`), which is only a less helpful
 * name, not a wrong one.
 */
export async function resolveMeta(page: TrackablePage): Promise<TrackedMeta> {
  const path = tagPagePath(page)
  if (!path)
    return page.meta
  let request = categoryRequests.get(path)
  if (!request) {
    request = fetchPageDoc(getArchiveLink(path)).then(profileCategory, () => null)
    categoryRequests.set(path, request)
  }
  const type = await request
  return type ? { type, entity: page.meta.entity } : page.meta
}

/** Whether {@link resolveMeta} would have to ask the archive. */
export function metaUnsettled(page: TrackablePage): boolean {
  return tagPagePath(page) !== null
}

/** The tag's own page, for a tag's filtered listing whose category the page left unknown. */
function tagPagePath(page: TrackablePage): string | null {
  if (page.meta.type !== 'tag' || page.normalized.kind !== 'works-filter')
    return null
  const listing = trackedRoot({ url: page.normalized.url })?.replace(/^works-filter:/, '') ?? ''
  return /^\/tags\/[^/]+\/works$/.test(listing) ? listing.replace(/\/works$/, '') : null
}

/**
 * The label the page's Sort & Filter sidebar gives the checkbox (or radio) with
 * this `name` and `value` — "Draco Malfoy" for `exclude_work_search[character_ids][]`
 * and its tag id — without the archive's work count. Null when the sidebar
 * doesn't list it, so a change to it can only be counted.
 */
export function sidebarNameId(param: string, id: string): string | null {
  const form = document.querySelector('form#work-filters') ?? document
  for (const input of form.querySelectorAll<HTMLInputElement>('input[name][value]')) {
    if (input.name === param && input.value === id)
      return checkboxTagName(input) || null
  }
  return null
}

/**
 * Whether a new `tag-works` entry has to be read from the tag's own page rather
 * than through a search by the tag's name.
 *
 * Reading the tag's page is the poor option: the archive lists it by work id, so
 * an old work that has just been updated stays buried where it always was, and
 * only *new* works are ever noticed. Searching by the tag's name can be read by
 * date and catches both — but only if it finds the same works, and the archive's
 * name matching isn't guaranteed to agree with the tag itself.
 *
 * So it asks once, here, at creation: the search's own count against the number
 * of pages the tag's page has. Costs one request, and settles the entry for good.
 *
 * A check that couldn't be made answers **yes**. Reading the page always returns
 * the tag's works, if not its updates, while trusting a search that may match
 * something else entirely could quietly hand the reader a list of nothing.
 */
export async function needsScan(page: TrackablePage, signal?: AbortSignal): Promise<boolean> {
  if (page.normalized.kind !== 'tag-works' || !page.listbox)
    return false
  const url = tagSearchUrl({ kind: 'tag-works', url: page.normalized.url })
  if (!url)
    return true
  try {
    const found = detectFoundCount(await fetchPageDoc(getArchiveLink(url), signal))
    if (found === null)
      return true
    return Math.ceil(found / PAGE_SIZE) !== detectPageCount(page.listbox)
  }
  catch {
    return true
  }
}

/**
 * A new entry for this page, tracked from today, with an id no sibling has, the
 * title given, what the page says it is, and the filter its custom search view
 * was set to, if any.
 */
export function newEntry(page: TrackablePage, title: string, existing: readonly TrackedList[], scan: boolean, meta: TrackedMeta = page.meta, filter?: TrackedFilter): TrackedList {
  const view = canonicalFilter(filter)
  return {
    id: newTrackedListId(existing),
    kind: page.normalized.kind,
    url: page.normalized.url,
    alias: title.trim(),
    type: meta.type,
    ...(meta.entity ? { entity: meta.entity } : {}),
    ...(view ? { filter: view } : {}),
    tracked: true,
    since: utcToday(),
    ...(scan ? { scan: true as const } : {}),
  }
}
