/**
 * The fewest moves that turn one list of children into another, for a parent
 * whose children are re-ordered often but mostly stay put — a facet group's
 * rows, as their counts shift under a filter. Re-inserting every child would
 * make the browser restyle each one, however few changed place; this keeps the
 * longest run already in order where it is and moves only the rest.
 */
export interface ChildPlan<T> {
  /** Current children that aren't wanted any more. */
  remove: T[]
  /** Carried out in this order after the removals: put `node` before `before`, or last for `null`. */
  insert: { node: T, before: T | null }[]
}

export function planChildren<T>(current: readonly T[], desired: readonly T[]): ChildPlan<T> {
  const wanted = new Set(desired)
  const remove = current.filter(node => !wanted.has(node))
  const at = new Map<T, number>()
  for (const [i, node] of current.entries())
    at.set(node, i)
  const stay = inOrder(desired, at)
  const insert: ChildPlan<T>['insert'] = []
  let before: T | null = null
  for (let i = desired.length - 1; i >= 0; i--) {
    const node = desired[i]!
    if (!stay.has(node))
      insert.push({ node, before })
    before = node
  }
  return { remove, insert }
}

/**
 * The longest subsequence of `desired` whose places in the current list (`at`)
 * rise — the children that are already in the right order among themselves.
 */
function inOrder<T>(desired: readonly T[], at: ReadonlyMap<T, number>): Set<T> {
  // Patience sorting: tails[k] is the index into `desired` of the smallest
  // current place that ends a rising run of length k + 1.
  const tails: number[] = []
  const prev = Array.from<number>({ length: desired.length }).fill(-1)
  for (const [i, node] of desired.entries()) {
    const place = at.get(node)
    if (place === undefined)
      continue
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (at.get(desired[tails[mid]!]!)! < place)
        lo = mid + 1
      else
        hi = mid
    }
    if (lo > 0)
      prev[i] = tails[lo - 1]!
    tails[lo] = i
  }
  const stay = new Set<T>()
  for (let i = tails.at(-1) ?? -1; i !== -1; i = prev[i]!)
    stay.add(desired[i]!)
  return stay
}
