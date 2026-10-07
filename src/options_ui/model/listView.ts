import type { Rule } from '../../common/data.ts'
import type { SavedListRow } from './savedListRows.ts'

import { DEFAULT_BEHAVIOR_PRIORITY, rulePriority, ruleTargetLabel } from '../../common/data.ts'
import { searchTerms, textMatches } from './settingsSearch.ts'

/**
 * What a list frame shows of its rows: which a filter keeps, the order a sort
 * puts them in, and how many it shows before it scrolls. All of it is display
 * only, so nothing here writes to a stored list.
 */

/**
 * The rows that every term of `query` appears in, in their own order. A row's
 * text is whatever `text` gives for it, and a term may be found in any one of
 * those strings. Terms are read as the settings search reads them:
 * whitespace-separated, all required, ignoring case and accents.
 */
export function filterRows<T>(rows: readonly T[], query: string, text: (row: T) => readonly string[]): T[] {
  const terms = searchTerms(query)
  // Joined with a space, which no term contains, so a term can't run from the
  // end of one string into the start of the next.
  return rows.filter(row => textMatches(text(row).join(' '), terms))
}

export type SortDirection = 'asc' | 'desc'
export type Compare<T> = (a: T, b: T) => number

/**
 * The rows in a new array, ordered by `by`, reversed for `desc`. Ties go to
 * `then`, which stays ascending whichever way `by` points, so the rows inside a
 * group don't shuffle when the sort is reversed. Rows still tied keep the
 * order they were given in.
 */
export function sortRows<T>(
  rows: readonly T[],
  by: Compare<T>,
  { direction = 'asc', then }: { direction?: SortDirection, then?: Compare<T> } = {},
): T[] {
  const sign = direction === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => sign * by(a, b) || (then?.(a, b) ?? 0))
}

/**
 * A sort by one of a list's keys, pointing either way, or by none of them,
 * which leaves the list in its own order.
 */
export interface KeySort<K extends string> {
  key: K | null
  direction: SortDirection
}

export const UNSORTED: KeySort<never> = { key: null, direction: 'asc' }

/**
 * The sort after `key` is pressed: ascending, then descending, then off. A key
 * other than the one sorted by starts ascending. Off matters, since a list's
 * own order can be one worth getting back to without reloading the page.
 */
export function cycleSort<K extends string>(sort: KeySort<K>, key: K): KeySort<K> {
  if (sort.key !== key)
    return { key, direction: 'asc' }
  if (sort.direction === 'asc')
    return { key, direction: 'desc' }
  return UNSORTED
}

/** Where a key is in its cycle, in `aria-sort`'s terms. */
export function sortState<K extends string>(sort: KeySort<K>, key: K): 'ascending' | 'descending' | 'none' {
  if (sort.key !== key)
    return 'none'
  return sort.direction === 'asc' ? 'ascending' : 'descending'
}

/** What pressing a key next does, spelled out, since a three-way cycle isn't guessable. */
export function sortHint<K extends string>(sort: KeySort<K>, key: K): string {
  return ({ none: 'Sort ascending', ascending: 'Sort descending', descending: 'Clear sort' })[sortState(sort, key)]
}

/** What the rules list sorts by: what a rule does, its priority, its text, what it applies to. */
export type RuleSortKey = 'behavior' | 'priority' | 'value' | 'target'

export const RULE_SORTS: readonly { value: RuleSortKey, label: string }[] = [
  { value: 'behavior', label: 'Action' },
  { value: 'priority', label: 'Priority' },
  { value: 'value', label: 'Rule' },
  { value: 'target', label: 'Applies to' },
]

/**
 * The order the actions sort in: strongest effect first, the order the rules'
 * help introduces them. Alphabetical would interleave the hiding actions with
 * those that hide nothing, and this puts the disabled rules last, together.
 * Keyed by string, since an imported rule can carry an action this build
 * doesn't know.
 */
const BEHAVIOR_RANK: Record<string, number> = { hide: 0, collapse: 1, invert: 2, highlight: 3, hideFilter: 4, none: 5 }

const byText: Compare<Rule> = (a, b) => a.value.localeCompare(b.value, undefined, { sensitivity: 'base' })

const RULE_COMPARE: Record<RuleSortKey, Compare<Rule>> = {
  behavior: (a, b) => (BEHAVIOR_RANK[a.behavior ?? 'hide'] ?? 0) - (BEHAVIOR_RANK[b.behavior ?? 'hide'] ?? 0),
  priority: (a, b) => rulePriority(a) - rulePriority(b),
  value: byText,
  // By the name shown, so the order matches what the reader sees. A target
  // this build doesn't know, which an old export or a hand-edited import can
  // carry, has no name, and must not be what takes the list down.
  target: (a, b) => (ruleTargetLabel(a.target) ?? '').localeCompare(ruleTargetLabel(b.target) ?? ''),
}

/**
 * Which rules the rules list shows, and in what order, as their places in the
 * stored list, which is what a row is known by.
 *
 * The filter keeps the rules whose text holds the query, trimmed, ignoring
 * case. It is one piece of text rather than words to find, with no wildcards,
 * so a typed `*` or `.` finds a rule that has one. Only the text is searched:
 * a long list is searched for the tag half-remembered, and matching what a
 * rule applies to, or an author's pseud, would turn up rules whose text has
 * nothing to do with what was typed.
 *
 * Unsorted, the rules are grouped by their stored target, then by text, which
 * puts like rules together. Sorted, ties go to the text, ascending whichever
 * way the key points.
 */
export function shownRules(rules: readonly Rule[], query: string, sort: KeySort<RuleSortKey>): number[] {
  const needle = query.trim().toLowerCase()
  const kept = [...rules.keys()].filter(at => rules[at]!.value.toLowerCase().includes(needle))
  const rule = (compare: Compare<Rule>): Compare<number> => (a, b) => compare(rules[a]!, rules[b]!)
  if (!sort.key)
    return sortRows(kept, rule((a, b) => a.target.localeCompare(b.target) || a.value.localeCompare(b.value)))
  return sortRows(kept, rule(RULE_COMPARE[sort.key]), { direction: sort.direction, then: rule(byText) })
}

/**
 * A rule's priority as its row shows it: the number, and whether the rule set
 * it rather than taking its action's default. Highlight and hide-tag rules
 * show none, since they never take part in deciding whether a work is shown.
 */
export function rulePriorityCell(rule: Pick<Rule, 'behavior' | 'priority'>): { text: string, title: string, custom: boolean } {
  const behavior = rule.behavior ?? 'hide'
  if (behavior === 'highlight' || behavior === 'hideFilter') {
    const kind = behavior === 'highlight' ? 'Highlight' : 'Hide-tag'
    return { text: '–', title: `${kind} rules have no priority: they never conflict with other rules`, custom: false }
  }
  const priority = rulePriority(rule)
  const custom = priority !== DEFAULT_BEHAVIOR_PRIORITY[behavior]
  const title = behavior === 'none'
    ? `Priority ${priority}, kept while the rule is disabled`
    : custom
      ? `Priority ${priority}: beats lower-priority rules that match the same work`
      : `Priority ${priority} (default)`
  return { text: String(priority), title, custom }
}

/**
 * How the work-marks list can be shown: in the reader's own order, which is
 * where it starts, by name, or by how many works carry each mark.
 */
export type MarkSort = 'order' | 'name' | 'works'

export const MARK_SORTS: readonly { value: MarkSort, label: string }[] = [
  { value: 'order', label: 'Your order' },
  { value: 'name', label: 'Name' },
  { value: 'works', label: 'Works' },
]

/**
 * The marks in a new array, given in the reader's order, shown by `sort`:
 * as given, A to Z by label (ignoring case and accents), or most works first.
 * Marks that tie keep the reader's order.
 */
export function sortMarks<T extends { label: string, count: number }>(rows: readonly T[], sort: MarkSort): T[] {
  if (sort === 'name')
    return sortRows(rows, (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }))
  if (sort === 'works')
    return sortRows(rows, (a, b) => a.count - b.count, { direction: 'desc' })
  return [...rows]
}

export const MARK_ORDER_OFF = 'Sort by your order to rearrange'

/**
 * Why the marks' order buttons are inert, or null while they are live. A sort
 * only changes how the list is shown, so moving a mark one place in it would
 * say nothing about where the mark sits in the order that is stored.
 */
export function markOrderOff(sort: MarkSort): string | null {
  return sort === 'order' ? null : MARK_ORDER_OFF
}

/** How the saved lists can be shown: by name, which is where they start, by status, or by how recently their offline copy was read. */
export type SavedListSort = 'name' | 'status' | 'refreshed'

export const SAVED_LIST_SORTS: readonly { value: SavedListSort, label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'status', label: 'Status' },
  { value: 'refreshed', label: 'Last refreshed' },
]

/** What of a saved list's row the frame reads. */
type ShownSavedList = Pick<SavedListRow, 'id' | 'title' | 'placeholder' | 'type' | 'typeTip' | 'kind' | 'status' | 'pending' | 'caching'>

/** What a saved list is called on screen: its title, or what its emptied field shows in its place. */
function savedListName(row: ShownSavedList): string {
  return row.title || row.placeholder
}

/**
 * The saved lists that every term of `query` appears in: in what a list is
 * called, what it is of, what kind of search it is, or the tag or name it
 * searches (`typeTip`, "Character: Draco Malfoy"). Read as the settings search
 * reads a query.
 */
export function filterSavedLists<T extends ShownSavedList>(rows: readonly T[], query: string): T[] {
  return filterRows(rows, query, row => [savedListName(row), row.type ?? '', row.typeTip ?? '', row.kind ?? ''])
}

const bySavedListName: Compare<ShownSavedList> = (a, b) => savedListName(a).localeCompare(savedListName(b), undefined, { sensitivity: 'base', numeric: true })

/** Tracked, then saved, then whatever is waiting on the reader, tracked or not. */
function statusRank(row: ShownSavedList): number {
  if (row.pending)
    return 2
  return row.status === 'tracked' ? 0 : 1
}

/** When a list's offline copy was read, or null with none. */
function refreshedAt(row: ShownSavedList): number | null {
  return row.caching.kind === 'copy' ? row.caching.scrapedAt : null
}

/**
 * The saved lists in a new array, by `sort`: A to Z by name, ignoring case and
 * accents; by status, by name within each; or the newest offline copy first,
 * the lists with none last, by name.
 */
export function sortSavedLists<T extends ShownSavedList>(rows: readonly T[], sort: SavedListSort): T[] {
  if (sort === 'status')
    return sortRows(rows, (a, b) => statusRank(a) - statusRank(b), { then: bySavedListName })
  if (sort === 'refreshed') {
    return sortRows(rows, (a, b) => {
      const [at, bt] = [refreshedAt(a), refreshedAt(b)]
      if (at === null || bt === null)
        return Number(at === null) - Number(bt === null)
      return bt - at
    }, { then: bySavedListName })
  }
  return sortRows(rows, bySavedListName)
}

/**
 * The order the rows had when a title took focus, and whose title it is. A
 * title is typed in place, and a row that moved or vanished under the reader's
 * typing would take the field with it, so the rows hold still until focus
 * leaves the titles.
 */
export interface SavedListHold {
  order: readonly string[]
  focused: string
}

/**
 * The saved lists the frame shows, in the order it shows them: the ones the
 * filter keeps, by the sort. While `hold` holds, they keep the order they had,
 * any list that arrived since after them, and the list being retitled stays
 * whatever the filter says.
 */
export function shownSavedLists<T extends ShownSavedList>(rows: readonly T[], { query, sort, hold }: { query: string, sort: SavedListSort, hold: SavedListHold | null }): T[] {
  const kept = new Set(filterSavedLists(rows, query))
  const sorted = sortSavedLists(rows.filter(row => kept.has(row) || row.id === hold?.focused), sort)
  if (!hold)
    return sorted
  const at = (row: T): number => {
    const index = hold.order.indexOf(row.id)
    return index === -1 ? hold.order.length : index
  }
  return sortRows(sorted, (a, b) => at(a) - at(b))
}

/**
 * Which row focus goes to when the row it was in, `gone`, leaves: the one now
 * where it stood (the next, or what replaced it), else the new last row; null
 * with none left. `before` is the order the rows had, by id.
 */
export function focusSuccessor(before: readonly string[] | undefined, after: readonly string[], gone: string): string | null {
  if (!after.length)
    return null
  const at = Math.max(0, before?.indexOf(gone) ?? 0)
  return after[Math.min(at, after.length - 1)]!
}

/**
 * The saved lists' header: how many there are, how many are tracked and how
 * many have an offline copy (or just how many, where the header is narrow);
 * while the filter holds a query, how many of them it shows; and the filter's
 * placeholder.
 */
export function savedListsHead(rows: readonly ShownSavedList[], shown: readonly ShownSavedList[], query: string): { count: string, shortCount: string, placeholder: string } {
  const total = rows.length
  if (!total)
    return { count: 'none yet', shortCount: 'none yet', placeholder: 'Filter lists' }
  const lists = `${total.toLocaleString()} ${total === 1 ? 'list' : 'lists'}`
  const placeholder = `Filter ${lists}`
  if (searchTerms(query).length) {
    const of = `${shown.length.toLocaleString()} of ${total.toLocaleString()}`
    return { count: of, shortCount: of, placeholder }
  }
  const tracked = rows.filter(row => row.status === 'tracked').length
  const cached = rows.filter(row => row.caching.kind === 'copy').length
  return { count: `${lists} · ${tracked.toLocaleString()} tracked · ${cached.toLocaleString()} cached`, shortCount: total.toLocaleString(), placeholder }
}

/**
 * How many rows a list shows before it scrolls: about seven for a list inside
 * a setting, about twelve for a list that is the point of its section.
 */
export const LIST_CAPS = { setting: 7, section: 12 } as const

export type ListCap = keyof typeof LIST_CAPS

/**
 * The height to hold a list's body to, given its rows' heights in order: that
 * of its first rows up to the cap, so it shows that many rows however tall a
 * row is, and scrolls the rest. Null while the rows fit, so the body is
 * exactly as tall as its rows.
 */
export function capFor(cap: ListCap, heights: readonly number[]): number | null {
  const shown = LIST_CAPS[cap]
  if (heights.length <= shown)
    return null
  return heights.slice(0, shown).reduce((sum, height) => sum + height, 0)
}
