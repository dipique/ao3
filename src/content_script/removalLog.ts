/**
 * The debug-mode console line for a work taken off the page: which work, how it
 * went, and every reason that survived the hiding contest — the same reasons a
 * collapsed work's reason line shows, but said for a work that may have left no
 * trace on the page at all.
 *
 * Pure — no `#common`, no `browser`, no DOM — so it loads under a plain
 * `node --test`.
 */

/**
 * How a work left the page. `hide` and `collapse` happen to a blurb where it
 * stands; `drop` and `exclude` keep a work out of a search view's results, by
 * the rules directly or through the facet exclusion the rules were handed.
 */
export type Removal = 'hide' | 'collapse' | 'drop' | 'exclude'

interface Entity {
  id: string
  name: string
}

/** What a removed blurb is named by: its work, else the first of its series. */
export interface RemovedBlurb {
  work?: Entity
  series: Entity[]
}

/** One reason as the log gives it: the value that matched, and the rule that matched it. */
export interface RemovalReason {
  value: string
  rule: string
}

const OUTCOMES: Record<Removal, string> = {
  hide: 'hidden',
  collapse: 'collapsed',
  drop: 'left out of the results',
  exclude: 'excluded by the view\'s filter',
}

export function describeRemoval(removal: Removal, blurb: RemovedBlurb, reasons: Record<string, RemovalReason[]>): string {
  const groups = Object.entries(reasons)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => `${label}: ${items.map(describeReason).join(', ')}`)
  const why = groups.length > 0 ? groups.join(' | ') : 'no reason recorded'
  return `${describeBlurb(blurb)} ${OUTCOMES[removal]} — ${why}`
}

function describeBlurb({ work, series }: RemovedBlurb): string {
  if (work)
    return `Work ${work.id} "${work.name}"`
  const [first] = series
  if (first)
    return `Series ${first.id} "${first.name}"`
  return 'Unlinked blurb'
}

function describeReason({ value, rule }: RemovalReason): string {
  return `"${value}" (${rule.split(/\s*\n\s*/).join('; ')})`
}
