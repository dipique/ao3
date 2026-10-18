import type { FacetDir, FacetSelection } from './engine.ts'

/**
 * Which of a facet group's value rows the sidebar shows, and in what order.
 * Pure, so the view only has to put the rows it is handed where they go.
 */

/** What the layout needs to know about one value row. */
export interface FacetRowFacts {
  value: string
  /** The value lowercased, for the group's "contains" filter. */
  lower: string
  /** Drill-down count: results you'd get if you also included this value. */
  count: number
  /** Results remaining if you additionally required this value. */
  resultCount: number
  /** The value's place in the group sorted by name, from {@link nameRanks}. */
  nameRank: number
}

/**
 * The most unselected rows a group shows. A reader's list can hold thousands of
 * distinct tags, and every row in the page costs each redraw; the group's
 * filter box still searches all of them.
 */
export const FACET_ROW_CAP = 100

export type ValueSort = 'count' | 'result' | 'name'

export interface FacetRowView {
  /** The group's value-filter text, as typed. */
  query: string
  sort: ValueSort
  dir: 'asc' | 'desc'
}

export interface FacetRowLayout<R> {
  /** The selected rows shown, in their direction's section, in display order. */
  sections: Record<FacetDir, R[]>
  /** The unselected rows shown below the sections, in display order: the first {@link FACET_ROW_CAP}. */
  rest: R[]
  /** How many rows show, sections included. */
  shown: number
  /** How many rows pass the value filter, shown or not: the group's count. */
  matching: number
  /** How many of those the cap left out of {@link rest}. */
  leftOut: number
  /**
   * How many rows have works left or are selected, whatever the value filter
   * says. None, and the group hides; a filter that matches nothing must not
   * hide it, or its box would go with it and trap the reader.
   */
  relevant: number
}

/**
 * Each value's place in the list sorted by `compare`, values it calls equal
 * keeping the order they came in. Worked out once per group, so the layout
 * sorts by name with integer comparisons on every render.
 */
export function nameRanks(values: readonly string[], compare: (a: string, b: string) => number): number[] {
  const order = values.map((_, i) => i).sort((a, b) => compare(values[a]!, values[b]!) || a - b)
  const ranks = Array.from<number>({ length: values.length })
  for (const [rank, i] of order.entries())
    ranks[i] = rank
  return ranks
}

/**
 * Lay a group's rows out: a row shows while it has works left or is selected
 * (so it can be turned off), and contains the value filter's text. Shown rows
 * are ordered by the chosen count, ties by name A to Z, or by name, either way
 * round; a selected one goes in its direction's section, and the first
 * {@link FACET_ROW_CAP} of the rest below.
 */
export function layoutFacetRows<R extends FacetRowFacts>(rows: readonly R[], sel: FacetSelection, view: FacetRowView): FacetRowLayout<R> {
  const q = view.query.trim().toLowerCase()
  const sign = view.dir === 'asc' ? 1 : -1
  let relevant = 0
  const visible: R[] = []
  for (const row of rows) {
    if (row.count === 0 && !isSelected(sel, row.value))
      continue
    relevant++
    if (q === '' || row.lower.includes(q))
      visible.push(row)
  }
  const num = (r: R): number => view.sort === 'result' ? r.resultCount : r.count
  visible.sort(view.sort === 'name'
    ? (a, b) => sign * (a.nameRank - b.nameRank)
    : (a, b) => sign * (num(a) - num(b)) || a.nameRank - b.nameRank)

  const sections: Record<FacetDir, R[]> = { require: [], include: [], exclude: [] }
  const rest: R[] = []
  let leftOut = 0
  for (const row of visible) {
    const dir = selectedDir(sel, row.value)
    if (dir)
      sections[dir].push(row)
    else if (rest.length < FACET_ROW_CAP)
      rest.push(row)
    else
      leftOut++
  }
  const matching = visible.length
  return { sections, rest, shown: matching - leftOut, matching, leftOut, relevant }
}

/** A group's count as its heading shows it, digits grouped like {@link leftOutNote}'s. */
export function groupCountText(count: number): string {
  return count.toLocaleString()
}

/** The line under a group the cap shortened, or `null` when it left nothing out. */
export function leftOutNote({ shown, matching, leftOut }: Pick<FacetRowLayout<unknown>, 'shown' | 'matching' | 'leftOut'>): string | null {
  if (leftOut === 0)
    return null
  return `Showing ${groupCountText(shown)} of ${groupCountText(matching)} — type in the filter box to find the rest`
}

function isSelected(sel: FacetSelection, value: string): boolean {
  return sel.include.has(value) || sel.exclude.has(value) || sel.require.has(value)
}

/** The one direction a value is selected in, if any: the three are exclusive. */
function selectedDir(sel: FacetSelection, value: string): FacetDir | null {
  if (sel.require.has(value))
    return 'require'
  if (sel.include.has(value))
    return 'include'
  if (sel.exclude.has(value))
    return 'exclude'
  return null
}
