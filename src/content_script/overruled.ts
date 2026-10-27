import type { Rule } from '#common'

/**
 * The hide rules an "always show" outranked on each blurb, as HideWorks last
 * weighed it. Nothing on the page says a work is only there because a
 * force-show won, so this is how the menu on that force-show's link can name
 * what it is holding off, and offer to change those rules' priority.
 *
 * Kept per blurb node and replaced on every run, so it always describes the
 * verdict the page is showing.
 */

/** One hide that lost to a force-show on a blurb. */
export interface OverruledRule {
  rule: Rule
  /** What the rule matches, as a reason line names it: `Fandom "Some Fandom"`. */
  subject: string
  /** The rule's effective priority. */
  priority: number
}

let overruled = new WeakMap<Element, OverruledRule[]>()

/** Record what lost to a force-show on `blurb` this run. */
export function recordOverruled(blurb: Element, rules: OverruledRule[]): void {
  overruled.set(blurb, rules)
}

/** What lost to a force-show on `blurb` when it was last weighed; empty when nothing did. */
export function overruledOn(blurb: Element): OverruledRule[] {
  return overruled.get(blurb) ?? []
}

/** Drop every record, for a run starting over. */
export function forgetOverruled(): void {
  overruled = new WeakMap()
}
