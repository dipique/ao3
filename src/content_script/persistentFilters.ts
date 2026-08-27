import type { FilterBehavior, Rule, RuleTarget, Tag, TagType } from '#common'

import { options } from '#common'

/**
 * Toggle and read the *persistent* extension rules — the saved `rules` list (as
 * opposed to the ephemeral AO3 sidebar filters handled by `filterSidebar.tsx`).
 *
 * Every menu that sets a hide/always-show/highlight state goes through here so
 * the read-freshest → find-exact → toggle → `options.set` pattern (previously
 * duplicated across the toolbars and background menus) lives in one place.
 * Choosing the behaviour an item already has clears it; choosing a different one
 * replaces it.
 *
 * The behaviours map onto {@link FilterBehavior}: `hide` hides the item,
 * `invert` force-shows it ("always show"), `highlight` only highlights it, and
 * `hideFilter` hides the tag itself. Priority is left off entirely — a rule with
 * no `priority` takes its behaviour's default (see `rulePriority`), which is
 * what these menus mean.
 */

/**
 * The single exact-match rule a menu targets: what it points at, plus the value
 * (and, for authors, the optional pseud). Everything a menu can act on reduces
 * to one of these.
 */
export interface RuleTargetKey {
  target: RuleTarget
  value: string
  /** Author rules only — a rule for one pseud is distinct from one for the account. */
  pseud?: string
}

/** The key for a tag/fandom link: its type when known, else "any tag". */
export function tagKey(tag: Tag): RuleTargetKey {
  return { target: (tag.type ?? 'tag') as TagType | 'tag', value: tag.name }
}

/** The key for an author byline (optionally narrowed to one pseud). */
export function authorKey(userId: string, pseud?: string): RuleTargetKey {
  return { target: 'author', value: userId, pseud }
}

/** The key for a work or series, by its numeric AO3 id. */
export function entityKey(kind: 'work' | 'series', id: string): RuleTargetKey {
  return { target: kind, value: id }
}

function matches(rule: Rule, key: RuleTargetKey): boolean {
  return rule.matcher === 'exact'
    && rule.target === key.target
    && rule.value === key.value
    && (rule.pseud ?? undefined) === (key.pseud ?? undefined)
}

/** The behaviour currently applied to this exact key, or `null` if no rule matches it. */
export function ruleBehavior(rules: Rule[], key: RuleTargetKey): FilterBehavior | null {
  const rule = rules.find(r => matches(r, key))
  return rule ? (rule.behavior ?? 'hide') : null
}

/**
 * The behaviour an on-page indicator should draw for a rule, or `null` for
 * nothing. Everything {@link ruleBehavior} returns except `'none'`: a disabled
 * rule is meant to be invisible, and a badge for a rule that does nothing would
 * be a badge for nothing. (The menu still offers "Clear", so the rule is
 * reachable from the page once you open it.)
 */
export function ruleIndicatorBehavior(behavior: FilterBehavior | null): Exclude<FilterBehavior, 'none'> | null {
  return behavior && behavior !== 'none' ? behavior : null
}

/** Toggle `behavior` for an exact key in the rules list (re-selecting clears it). */
export async function toggleRuleBehavior(key: RuleTargetKey, behavior: FilterBehavior): Promise<void> {
  const rules = await options.get('rules')
  const filters = rules.filters
  const index = filters.findIndex(r => matches(r, key))
  const current = index !== -1 ? (filters[index]!.behavior ?? 'hide') : null
  if (index !== -1)
    filters.splice(index, 1)
  if (current !== behavior) {
    filters.push({
      target: key.target,
      value: key.value,
      ...(key.pseud !== undefined ? { pseud: key.pseud } : {}),
      matcher: 'exact',
      behavior,
    })
  }

  await options.set({ rules: { ...rules, enabled: true, filters } })
}

/** Remove any exact rule on this key (back to no rule at all). */
export async function clearRule(key: RuleTargetKey): Promise<void> {
  const rules = await options.get('rules')
  const filters = rules.filters.filter(r => !matches(r, key))
  await options.set({ rules: { ...rules, filters } })
}
