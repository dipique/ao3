import type { SettingsRow } from './settingsSearch.ts'

import { entryMatches, searchTerms } from './settingsSearch.ts'

/**
 * The rail: the page's categories, each with its sub-sections, and how many
 * settings each holds and how many of those a query keeps. Categories and
 * sub-sections are known by their keys, as the rows record them, which are
 * also the anchor ids a link to them uses; their titles are only what the
 * rail calls them. As the page scrolls, the rail marks the current category's
 * sub-section being read ({@link markedSubsection}). The rows the reader
 * bookmarked are listed under the category and sub-section holding them.
 */

/** A category in the rail's order: its key, and what the rail calls it. */
export interface NamedCategory {
  id: string
  name: string
}

/** A bookmarked row: its anchor id, its title, and the key of its sub-section. */
export interface RailBookmark {
  id: string
  name: string
  subsection: string | null
}

export interface RailSubsection {
  id: string
  name: string
  count: number
  /** Rows the query keeps; all of them when there is no query. */
  hits: number
  /** Whether the rail lists it: always with no query, and with a hit while there is one. */
  visible: boolean
  /** Its bookmarked rows that the query keeps, in the order the rows come. */
  bookmarks: RailBookmark[]
}

export interface RailCategory extends RailSubsection {
  current: boolean
  /** Whether the pane shows it: the current category alone with no query, and every one with a hit while there is one. */
  inPane: boolean
  subsections: RailSubsection[]
}

/** A sub-section the page draws: its key and title, under the key of the category it is drawn in. */
export interface DrawnSubsection {
  category: string | null
  id: string
  title: string
}

/**
 * `order` is the categories in rail order; a category with rows that it
 * leaves out comes after them, named by its key, so no setting is left
 * unreachable. A sub-section is named by the title it is drawn with. `current` is
 * the current category's id. `subsections` is the sub-sections the page draws,
 * in the order it draws them. They are listed even with no rows, as a list
 * with nothing in it yet draws its empty state, and in that order, which a
 * sub-section whose rows are all drawn late (a list's, once it has been read)
 * would otherwise lose. A sub-section with rows that it leaves out comes after
 * the rest of its category's, in the order its rows come. `bookmarks` is the
 * anchor ids of the bookmarked rows; one naming no row is left out.
 */
export function buildRail(rows: readonly SettingsRow[], order: readonly NamedCategory[], query: string, current: string, subsections: readonly DrawnSubsection[] = [], bookmarks: readonly string[] = []): RailCategory[] {
  const terms = searchTerms(query)
  const names = new Map(order.map(category => [category.id, category.name]))
  for (const row of rows) {
    if (row.category !== null && !names.has(row.category))
      names.set(row.category, row.category)
  }
  const bookmarked = new Set(bookmarks)
  const bookmarksOf = (inside: readonly SettingsRow[]): RailBookmark[] => inside
    .filter(row => bookmarked.has(row.id) && entryMatches(row, terms))
    .map(row => ({ id: row.id, name: row.title, subsection: row.subsection }))

  return [...names].map(([id, name]) => {
    const own = rows.filter(row => row.category === id)
    const hits = own.filter(row => entryMatches(row, terms)).length
    const titles = new Map(subsections.filter(subsection => subsection.category === id).map(subsection => [subsection.id, subsection.title]))
    for (const row of own) {
      if (row.subsection !== null && !titles.has(row.subsection))
        titles.set(row.subsection, row.subsection)
    }
    const ownSubsections = [...titles]
      .map(([subsection, title]) => {
        const inside = own.filter(row => row.subsection === subsection)
        const subsectionHits = inside.filter(row => entryMatches(row, terms)).length
        return {
          id: subsection,
          name: title,
          count: inside.length,
          hits: subsectionHits,
          visible: !terms.length || subsectionHits > 0,
          bookmarks: bookmarksOf(inside),
        }
      })
    return {
      id,
      name,
      count: own.length,
      hits,
      visible: !terms.length || hits > 0,
      current: id === current,
      inPane: terms.length ? hits > 0 : id === current,
      subsections: ownSubsections,
      bookmarks: bookmarksOf(own),
    }
  })
}

/** `bookmarks` with `id` taken out if it is in them, or added after them if not. */
export function toggleBookmark(bookmarks: readonly string[], id: string): string[] {
  return bookmarks.includes(id) ? bookmarks.filter(bookmark => bookmark !== id) : [...bookmarks, id]
}

/**
 * The category the page opens on for `hash`: the one holding what the hash
 * names, or the first when it names nothing.
 */
export function landingCategory(hash: string, anchorCategory: (hash: string) => string | null, first: string): string {
  if (!hash.replace(/^#/, ''))
    return first
  return anchorCategory(hash) ?? first
}

/** A sub-section by its anchor id, and the top of its section against the top of the window. */
export interface SectionTop {
  id: string
  top: number
}

/** The window over the page. */
export interface ReadingView {
  /** How far down the window the reading line runs: just under the top bar, where a jump puts what it lands on. */
  line: number
  /** How far the page is scrolled. */
  scrollTop: number
  /** The window's height. */
  height: number
  /** The page's whole height. */
  scrollHeight: number
}

/** How far apart two positions can be and still be one: a scroll position is rounded to the screen's pixels. */
const ROUNDING = 1

/**
 * The sub-section being read, of `sections` (the current category's, in the
 * order they are drawn): the last whose top is at the reading line or above
 * it, or the first while the line is above them all. At the foot of the page
 * it is the last, since a short last section never reaches the line, but is
 * read all the same.
 */
export function subsectionInView(sections: readonly SectionTop[], view: ReadingView): string | null {
  if (!sections.length)
    return null
  const atFoot = view.scrollTop > 0 && view.scrollTop + view.height >= view.scrollHeight - ROUNDING
  if (atFoot)
    return sections.at(-1)!.id
  const above = sections.filter(section => section.top <= view.line + ROUNDING)
  return (above.at(-1) ?? sections[0]!).id
}

/** What a jump went to, as the page's anchors record it. */
export interface JumpTo {
  kind: 'category' | 'subsection' | 'row'
  id: string
  /** The key of the sub-section it is in, or is. */
  subsection: string | null
}

/**
 * A jump's hold on the mark. A jump marks the sub-section it goes to at once,
 * not each one it scrolls past on the way, and keeps it marked where it lands,
 * which can be short of the reading line: near the foot of the page, a short
 * section can't be scrolled up to it. The hold lasts until the page is
 * scrolled from where the jump left it.
 */
export interface JumpHold {
  /** The sub-section's id, or null for the category's first: a jump to a category lands above it. */
  target: string | null
  /** Where the jump left the page's scroll; null while it is under way. */
  landedAt: number | null
}

/**
 * What moves a hold: a jump beginning, to what a hash names or, where it names
 * nothing, to nothing; the jump landing, so that it scrolls the page no
 * further; and the page scrolling.
 */
export type HoldEvent
  = | { kind: 'jump', to: JumpTo | null }
    | { kind: 'landed', scrollTop: number }
    | { kind: 'scrolled', scrollTop: number }

export function nextHold(hold: JumpHold | null, event: HoldEvent): JumpHold | null {
  switch (event.kind) {
    case 'jump':
      if (!event.to)
        return null
      return {
        target: event.to.kind === 'subsection'
          ? event.to.id
          : event.to.kind === 'row' ? event.to.subsection : null,
        landedAt: null,
      }
    case 'landed':
      return hold && { ...hold, landedAt: event.scrollTop }
    case 'scrolled':
      return hold && (hold.landedAt === null || Math.abs(event.scrollTop - hold.landedAt) <= ROUNDING) ? hold : null
  }
}

/**
 * The sub-section the rail marks: the one a jump holds, while `sections`
 * holds it, else the one in view.
 */
export function markedSubsection(hold: JumpHold | null, sections: readonly SectionTop[], view: ReadingView): string | null {
  const held = hold && (hold.target ?? sections[0]?.id)
  if (held && sections.some(section => section.id === held))
    return held
  return subsectionInView(sections, view)
}
