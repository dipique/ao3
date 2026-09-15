import type { BlurbSource, Tag, TagType } from '#common'

import { getTagFromElement } from '#content_script/utils.js'

/** A blurb tag, plus the fandom link href (needed to resolve a fandom's id). */
export type BlurbTag = Tag & { href?: string }

/** A work or series referenced by a blurb: the id parsed from its link, plus its display name. */
export interface BlurbEntity {
  id: string
  name: string
}

/** The two numbers in a `dd.chapters` cell: chapters posted, and the author's target. */
export interface ChapterCounts {
  /** Chapters actually published — the left number, the only one that counts anything real. */
  written: number
  /** The author's stated total, or null for the `?` of an open-ended work. */
  total: number | null
}

export interface Blurb {
  language?: string | null
  fandoms: string[]
  authors: { userId: string, pseud?: string }[]
  tags: BlurbTag[]
  /** The work this blurb is for, parsed from its title link (absent on non-work blurbs). */
  work?: BlurbEntity
  /** Series the blurb belongs to (the "Part N of …" links), plus any series-listing title. */
  series: BlurbEntity[]
  /** The blurb's chapter counts, or null when it has no `dd.chapters` at all. */
  chapters: ChapterCounts | null
}

/**
 * Parse a `dd.chapters` cell into its two numbers. Null when there's no such
 * cell — series and user blurbs have none — so every caller fails open rather
 * than guessing at a count.
 *
 * Reads the **text**, `\D`-stripping each half, and deliberately not the
 * `data-ao3e-original` attribute Stats stashes: on a multi-chapter work Stats
 * reassigns to the inner `<a>` before stashing, and AO3 renders the total
 * outside that anchor, so the attribute holds only the left number. It's also
 * stale-prone, since `Stats.clean()` reads the attribute off the `dd` and never
 * restores an anchor-stashed one. Stripping non-digits sidesteps all of it: the
 * thin spaces Stats inserts as thousands separators aren't digits either.
 *
 *     <dd class="chapters"><a href="…" data-ao3e-original="9">9</a>/23</dd>
 *     <dd class="chapters">1/1</dd>
 */
export function readChapterCounts(el: Element | null | undefined): ChapterCounts | null {
  const text = el?.textContent?.trim()
  if (!text)
    return null
  const [writtenRaw, totalRaw] = text.split('/')
  const written = Number((writtenRaw ?? '').replace(/\D/g, '')) || 0
  const total = totalRaw && /\d/.test(totalRaw) ? Number(totalRaw.replace(/\D/g, '')) : null
  return { written, total }
}

/** Parse the `:id` from a `/works/:id` or `/series/:id` link, ignoring any trailing path. */
function parseEntityId(href: string, kind: 'works' | 'series'): string | undefined {
  try {
    return new URL(href).pathname.match(new RegExp(`^/${kind}/(\\d+)(?:/|$)`))?.[1]
  }
  catch {
    return undefined
  }
}

/**
 * Parse a work blurb (`li.blurb`) into the structured shape HideWorks uses for
 * its hide decision. Shared so the Marked-for-Later search view (see
 * {@link parseWork}) and HideWorks read blurbs through one parser.
 */
export function getBlurb(blurbElement: Element): Blurb {
  const language = blurbElement.querySelector('dd.language')?.textContent

  const fandoms = Array.from(blurbElement.querySelectorAll('.fandoms a')).map(
    fandom => fandom.textContent!,
  )

  const authors = Array.from(
    blurbElement.querySelectorAll('.heading a[rel=author]'),
  ).map((author) => {
    const parts = new URL((author as HTMLAnchorElement).href).pathname.split('/')
    return {
      userId: parts[2]!,
      pseud: parts[4],
    }
  })

  const tags: BlurbTag[] = [
    ...Array.from(blurbElement.querySelector('.required-tags .rating')?.textContent?.split(',') || []).map(name => ({
      name: name.trim(),
      type: 'r' as TagType,
    })),
    ...Array.from(blurbElement.querySelector('.required-tags .category')?.textContent?.split(',') || []).map(name => ({
      name: name.trim(),
      type: 'c' as TagType,
    })),
    ...Array.from(blurbElement.querySelectorAll('.fandoms .tag')).map(tag => ({
      name: tag.textContent!,
      type: 'f' as TagType,
      href: tag instanceof HTMLAnchorElement ? tag.href : undefined,
    })),
    ...Array.from(
      blurbElement.querySelectorAll(':not(.own) > ul.tags .tag'),
    ).map((tag) => {
      return getTagFromElement(tag)
    }),
  ]

  // The work this blurb is for, from its title link (absent on e.g. series-listing blurbs).
  const titleLink = blurbElement.querySelector<HTMLAnchorElement>('.header h4.heading a[href*="/works/"]')
  const workId = titleLink ? parseEntityId(titleLink.href, 'works') : undefined
  const work: BlurbEntity | undefined = titleLink && workId
    ? { id: workId, name: titleLink.textContent!.trim() }
    : undefined

  // Series the blurb references: the "Part N of …" links, and (on series
  // listings) the blurb's own series title link. Deduped by id.
  const series: BlurbEntity[] = []
  const seenSeries = new Set<string>()
  for (const link of blurbElement.querySelectorAll<HTMLAnchorElement>('a[href*="/series/"]')) {
    const id = parseEntityId(link.href, 'series')
    if (!id || seenSeries.has(id))
      continue
    seenSeries.add(id)
    series.push({ id, name: link.textContent!.trim() })
  }

  return {
    language,
    fandoms,
    authors,
    tags,
    work,
    series,
    // Carried on the blurb so the hide pass — which decides per work whether an
    // ongoing one is worth showing — needn't go back to the DOM for it.
    chapters: readChapterCounts(blurbElement.querySelector('dd.chapters')),
  }
}

// ===========================================================================
// Richer work model for the Marked-for-Later search view. Carries every field
// the in-memory facet/filter/sort engine needs, plus a reference to the live
// blurb node so the view can mount the real AO3 markup (keeping skin styling).
// ===========================================================================

export interface WorkAuthor {
  userId: string
  pseud?: string
  /** Byline display text, e.g. "Alsike". */
  text: string
}

export interface Work {
  /** The live `<li class="blurb">` node — mounted as-is, never cloned. */
  el: HTMLLIElement
  workId: string
  title: string
  /** Empty when the work is posted anonymously. */
  authors: WorkAuthor[]
  summaryText: string
  language: string | null
  words: number
  chapters: ChapterCounts
  complete: boolean
  kudos: number
  hits: number
  comments: number
  bookmarks: number
  /** Epoch seconds from the blurb's `<!-- updated_at=N -->` comment, or 0. */
  dateUpdated: number
  /** Display-only date string (`p.datetime`), e.g. "19 Jun 2012". */
  dateText: string
  /** Position in the marked-for-later list (0 = most recently marked). */
  markedOrder: number
  fandoms: string[]
  rating: string | null
  warnings: string[]
  categories: string[]
  relationships: string[]
  characters: string[]
  freeforms: string[]
  restricted: boolean
  /**
   * What the reader has done with this work — the Status facet's values: the
   * marks it carries, whether it's unread, how ready a progress-marked work is
   * to be read on, and whether it's on the Marked for Later list. Deliberately
   * never set by {@link parseWork}: they depend on the mark table, the Marked
   * for Later index and today's date, none of which the parser can see, and the
   * snapshot cache rehydrates through this same parser (so values baked in here
   * would be a day stale on the next visit). The host fills them in a post-pass
   * before handing the works to the view.
   */
  statuses?: string[]
  /**
   * The reader's rules take this work out of the listing outright (as opposed to
   * collapsing it, which the view leaves to HideWorks to draw on the blurb). Such
   * a work is dropped from the results altogether — out of the facet counts, the
   * total and the paging — so a page still fills with the number of works asked
   * for. Stamped by the host for the same reasons as {@link Work.statuses}: it
   * depends on the options and on today's date, neither of which
   * {@link parseWork} can see, and the snapshot cache re-parses stored HTML.
   */
  hidden?: boolean
  /**
   * A work of this kind is on screen only because the reader lifted the facet
   * exclusion their rules implied — stamped by the host's hide pass, and put on
   * the node as `data-ao3e-filtered` (see `handedToFilter` in HideWorks). Kept on
   * the work as well, because its node may not have been built yet.
   */
  filtered?: boolean
  /**
   * The blurb as HideWorks reads it ({@link getBlurb}), when it is known without
   * going back to the node — stored with the blurb, or worked out once already.
   */
  blurb?: Blurb
  /**
   * Epoch ms this blurb was read off AO3 — set by whatever fetched it, and by
   * the store for one it read back. What decides, between two copies of a
   * work's blurb, which is newer.
   */
  seenAt?: number
  /** Where the markup came from; a listing unless said otherwise. */
  src?: BlurbSource
}

/**
 * Works whose node hasn't been built yet. A work read back from the store has
 * everything the view facets, sorts and hides by without one, so its node is
 * only built from the stored markup when something first asks for `el` — which,
 * in a view that mounts only the page on screen, is when its page is shown.
 */
const unbuilt = new WeakSet<Work>()

/**
 * Give `work` an `el` that is built on first access. The builder runs at most
 * once; assigning `el` replaces the node outright.
 */
export function defineLazyNode(work: Omit<Work, 'el'>, build: () => HTMLLIElement): Work {
  let node: HTMLLIElement | undefined
  const lazy = work as Work
  Object.defineProperty(lazy, 'el', {
    configurable: true,
    enumerable: true,
    get: () => {
      if (!node) {
        node = build()
        unbuilt.delete(lazy)
      }
      return node
    },
    set: (value: HTMLLIElement) => {
      node = value
      unbuilt.delete(lazy)
    },
  })
  unbuilt.add(lazy)
  return lazy
}

/** Whether `work.el` is a node already, rather than one reading it would build. */
export function hasNode(work: Work): boolean {
  return !unbuilt.has(work)
}

/**
 * Parsed blurbs by node, for the per-blurb units that are handed a node and
 * would otherwise parse it again ({@link knownBlurb}).
 */
const parsedBlurbs = new WeakMap<Element, Blurb>()

/** Record that `el` parses to `blurb`, so HideWorks can skip parsing it. */
export function rememberBlurb(el: Element, blurb: Blurb): void {
  parsedBlurbs.set(el, blurb)
}

/**
 * The blurb `el` was recorded as ({@link rememberBlurb}), or undefined. Only
 * ever recorded for a pristine node whose markup the record was parsed from —
 * what the units add to a blurb afterwards changes nothing {@link getBlurb}
 * reads.
 */
export function knownBlurb(el: Element): Blurb | undefined {
  return parsedBlurbs.get(el)
}

/**
 * A work's blurb as HideWorks reads it — the one it carries when there is one,
 * else parsed off its node once and kept.
 */
export function blurbOf(work: Work): Blurb {
  if (!work.blurb) {
    work.blurb = getBlurb(work.el)
    rememberBlurb(work.el, work.blurb)
  }
  return work.blurb
}

/** Digits-only parse of a stat cell ("1,101" -> 1101); missing/blank -> 0. */
function statNumber(el: Element | null): number {
  const digits = el?.textContent?.replace(/\D/g, '')
  return digits ? Number(digits) : 0
}

/** The epoch in the blurb's `<!-- updated_at=N -->` comment (the only reliable per-work timestamp), or 0. */
function parseUpdatedAt(el: Element): number {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_COMMENT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const match = node.textContent?.match(/updated_at=(\d+)/)
    if (match)
      return Number(match[1])
  }
  return 0
}

/** Trimmed text of each `a.tag` in the blurb's primary tag list of a given type. */
function tagTexts(el: Element, typeClass: string): string[] {
  return Array.from(el.querySelectorAll(`:not(.own) > ul.tags li.${typeClass} a.tag`))
    .map(a => a.textContent!.trim())
    .filter(Boolean)
}

/** Split a required-tags symbol's text ("F/F" / "F/F, M/M") into trimmed values. */
function splitRequired(el: Element | null): string[] {
  return (el?.textContent ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

/**
 * Parse a work blurb into the full {@link Work} model. `markedOrder` is the
 * work's position across the aggregated list (0 = most recently marked).
 */
export function parseWork(el: HTMLLIElement, markedOrder: number): Work {
  // Matched anywhere in the href, not at its start: a blurb on AO3 links to
  // `/works/123`, but a blurb stored in an export has been made absolute so its
  // links still go somewhere off the archive. `getBlurb` already reads the same
  // link the same way.
  const titleLink = el.querySelector<HTMLAnchorElement>('.header h4.heading a[href*="/works/"]')
  const workId = el.id.match(/work_(\d+)/)?.[1]
    ?? (titleLink ? new URL(titleLink.href).pathname.match(/^\/works\/(\d+)/)?.[1] : undefined)
    ?? ''
  const title = titleLink?.textContent?.trim() ?? '(untitled)'

  const authors: WorkAuthor[] = Array.from(
    el.querySelectorAll<HTMLAnchorElement>('.heading a[rel=author]'),
  ).map((a) => {
    const parts = new URL(a.href).pathname.split('/')
    return { userId: parts[2] ?? '', pseud: parts[4], text: a.textContent!.trim() }
  })

  const chapters = readChapterCounts(el.querySelector('dd.chapters')) ?? { written: 0, total: null }
  const { written, total } = chapters
  const complete = !!el.querySelector('.required-tags .complete-yes')
    || (total !== null && total > 0 && written >= total)

  // Warnings show both as a required-tags symbol and (usually) as tags; dedupe.
  const warnings = Array.from(new Set([
    ...splitRequired(el.querySelector('.required-tags .warnings')),
    ...tagTexts(el, 'warnings'),
  ]))

  return {
    el,
    workId,
    title,
    authors,
    summaryText: el.querySelector('blockquote.userstuff.summary')?.textContent?.trim() ?? '',
    language: el.querySelector('dd.language')?.textContent?.trim() || null,
    words: statNumber(el.querySelector('dd.words')),
    chapters,
    complete,
    kudos: statNumber(el.querySelector('dd.kudos')),
    hits: statNumber(el.querySelector('dd.hits')),
    comments: statNumber(el.querySelector('dd.comments')),
    bookmarks: statNumber(el.querySelector('dd.bookmarks')),
    dateUpdated: parseUpdatedAt(el),
    dateText: el.querySelector('p.datetime')?.textContent?.trim() ?? '',
    markedOrder,
    fandoms: Array.from(el.querySelectorAll('.fandoms a.tag')).map(a => a.textContent!.trim()).filter(Boolean),
    rating: el.querySelector('.required-tags .rating')?.textContent?.trim() || null,
    warnings,
    categories: splitRequired(el.querySelector('.required-tags .category')),
    relationships: tagTexts(el, 'relationships'),
    characters: tagTexts(el, 'characters'),
    freeforms: tagTexts(el, 'freeforms'),
    restricted: !!el.querySelector('img[title="Restricted"]'),
  }
}
