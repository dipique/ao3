import type { SettingsRow } from './settingsSearch.ts'

import { anchorSlug, categoryId } from './anchors.ts'
import { entryMatches, searchTerms } from './settingsSearch.ts'

/**
 * The rail: the page's categories, each with its sub-sections, and how many
 * settings each holds and how many of those a query keeps. Categories and
 * sub-sections are named by their titles, as the rows record them, and carry
 * the anchor id a link to them uses.
 */

export interface RailSubsection {
  id: string
  name: string
  count: number
  /** Rows the query keeps; all of them when there is no query. */
  hits: number
}

export interface RailCategory extends RailSubsection {
  /** Whether the rail lists it: always with no query, and with a hit while there is one. */
  visible: boolean
  current: boolean
  /** Whether the pane shows it: the current category alone with no query, and every one with a hit while there is one. */
  inPane: boolean
  subsections: RailSubsection[]
}

/**
 * `order` is the category titles in rail order; a category with rows that it
 * leaves out comes after them, so no setting is left unreachable. `current` is
 * the current category's id.
 */
export function buildRail(rows: readonly SettingsRow[], order: readonly string[], query: string, current: string): RailCategory[] {
  const terms = searchTerms(query)
  const titles = new Set(order)
  for (const row of rows) {
    if (row.category !== null)
      titles.add(row.category)
  }

  return [...titles].map((title) => {
    const own = rows.filter(row => row.category === title)
    const hits = own.filter(row => entryMatches(row, terms)).length
    const subsections = [...new Set(own.map(row => row.subsection))]
      .filter(subsection => subsection !== null)
      .map((subsection) => {
        const inside = own.filter(row => row.subsection === subsection)
        return {
          id: anchorSlug(subsection),
          name: subsection,
          count: inside.length,
          hits: inside.filter(row => entryMatches(row, terms)).length,
        }
      })
    const id = categoryId(title)
    return {
      id,
      name: title,
      count: own.length,
      hits,
      visible: !terms.length || hits > 0,
      current: id === current,
      inPane: terms.length ? hits > 0 : id === current,
      subsections,
    }
  })
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
