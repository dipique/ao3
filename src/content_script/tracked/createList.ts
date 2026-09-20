import type { NormalizedTrackedUrl, TrackedList } from '#common'

import { getArchiveLink, newTrackedListId, normalizeTrackedUrl, PAGE_SIZE, tagNameFromURL, tagSearchUrl, utcToday } from '#common'
import { detectFoundCount, detectPageCount, fetchPageDoc } from '#content_script/searchView/scrape.ts'
import { tagPageName, uncommonTagPage } from '#content_script/tagPage.ts'

/**
 * Turning the page the reader is on into a tracked list: whether it can be one,
 * what to call it, and the one check a tag needs before it can be read by date.
 *
 * The rules about *what* a trackable query is, and how one is keyed, are pure and
 * live in {@link file://../../common/trackedLists.ts}. This is the half that has
 * to look at the page.
 */

/** A page the toolbar can offer to track. */
export interface TrackablePage {
  /** The query, as the stored entry will hold it. */
  normalized: NormalizedTrackedUrl
  /** The name the alias box starts out with — always something the reader has just seen. */
  alias: string
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
    return { normalized, alias: generatedAlias(normalized) }
  const tag = uncommonTagPage()
  return tag ? { normalized, alias: generatedAlias(normalized), listbox: tag.listbox } : null
}

/**
 * A name for a new list, taken from whatever the page itself says it is: the words
 * searched for, the tag, the series' title, or the listing's owner. It goes into
 * the alias box as a starting point, not a decision — the reader edits it there,
 * and can rename it later from the options page.
 */
function generatedAlias(normalized: NormalizedTrackedUrl): string {
  switch (normalized.kind) {
    case 'tag-works':
      return tagPageName()
    case 'series-works':
      return pageHeading() || 'Series'
    case 'text-search':
      return searchWords() || 'Works search'
    case 'works-filter':
      // The listing's own name plus a word for the rest of the query, since what
      // makes this list worth tracking is usually the filters, not the listing.
      return `${listingOwner(normalized) || pageHeading() || 'Works'}, filtered`
  }
}

/** The page's own title, as the archive prints it above the content. */
function pageHeading(): string {
  return document.querySelector('#main h2.heading')?.textContent?.trim().replace(/\s+/g, ' ') ?? ''
}

/** What a works search was asked for, when it was asked in words. */
function searchWords(): string {
  const params = new URLSearchParams(location.search)
  for (const field of ['query', 'title', 'creators']) {
    const value = params.get(`work_search[${field}]`)?.trim().replace(/\s+/g, ' ')
    if (value)
      return value
  }
  return ''
}

/**
 * Whose listing a `works-filter` page is — the tag, user, pseud or collection in
 * its path. Read from the **key**, not the address: a tag's listing reached by
 * submitting the Sort & Filter sidebar names its tag in the query string instead
 * of the path, and the key is where those two spellings have already been made
 * one ({@link normalizeTrackedUrl}).
 */
function listingOwner(normalized: NormalizedTrackedUrl): string {
  const path = normalized.key.replace(/^[^:]*:/, '').split('?')[0] ?? ''
  const tag = /^\/tags\/([^/]+)\/works$/.exec(path)
  if (tag)
    return tagNameFromURL(decodeSegment(tag[1]!))
  const owner = /^\/(?:users|collections)\/([^/]+)(?:\/pseuds\/([^/]+))?\/works$/.exec(path)
  return owner ? decodeSegment(owner[2] ?? owner[1]!) : ''
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  }
  catch {
    return segment
  }
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

/** A new entry for this page, tracked from today, with an id no sibling has. */
export function newEntry(page: TrackablePage, alias: string, existing: readonly TrackedList[], scan: boolean): TrackedList {
  return {
    id: newTrackedListId(existing),
    kind: page.normalized.kind,
    url: page.normalized.url,
    alias: alias.trim(),
    tracked: true,
    since: utcToday(),
    ...(scan ? { scan: true as const } : {}),
  }
}
