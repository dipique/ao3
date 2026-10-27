import type { FilterBehavior, Rule, RuleKey, Tag, TagType } from '#common'

import { findExactRule, options, ruleHasKey, setExactRulePriority, toggleExactRule } from '#common'

import { extensionAlive } from './extensionAlive.ts'

/**
 * Toggle and read the *persistent* extension rules — the saved `rules` list (as
 * opposed to the ephemeral AO3 sidebar filters handled by `filterSidebar.tsx`).
 *
 * Every menu that sets a hide/collapse/always-show/highlight state or a rule's
 * priority goes through here, so the read-freshest → change → `options.set`
 * pattern lives in one place; what each change does to the list is decided by
 * the pure exact-rule helpers in `data.ts` (`toggleExactRule` and friends).
 *
 * The behaviours map onto {@link FilterBehavior}: `hide` takes the work away,
 * `collapse` squeezes it down to a reason line, `invert` force-shows it ("always
 * show"), `highlight` only highlights it, and `hideFilter` hides the tag itself.
 */

/** The key for a tag/fandom link: its type when known, else "any tag". */
export function tagKey(tag: Tag): RuleKey {
  return { target: (tag.type ?? 'tag') as TagType | 'tag', value: tag.name }
}

/** The key for an author byline (optionally narrowed to one pseud). */
export function authorKey(userId: string, pseud?: string): RuleKey {
  return { target: 'author', value: userId, pseud }
}

/** The key for a work or series, by its numeric AO3 id. */
export function entityKey(kind: 'work' | 'series', id: string): RuleKey {
  return { target: kind, value: id }
}

/** The behaviour currently applied to this exact key, or `null` if no rule matches it. */
export function ruleBehavior(rules: Rule[], key: RuleKey): FilterBehavior | null {
  return behaviorOf(findExactRule(rules, key))
}

/** What a rule does, or `null` for no rule at all. */
export function behaviorOf(rule: Rule | undefined): FilterBehavior | null {
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
export async function toggleRuleBehavior(key: RuleKey, behavior: FilterBehavior): Promise<void> {
  // Every one of these is the reader choosing something from a menu, so an
  // orphaned page says so rather than reading defaults and dropping the write
  // (see {@link file://./extensionAlive.ts}).
  if (!extensionAlive())
    return

  const rules = await options.get('rules')
  await options.set({ rules: { ...rules, enabled: true, filters: toggleExactRule(rules.filters, key, behavior) } })
}

/** Set the priority of the exact rule on this key; nothing happens when it has none. */
export async function setRulePriority(key: RuleKey, priority: number): Promise<void> {
  if (!extensionAlive())
    return

  const rules = await options.get('rules')
  await options.set({ rules: { ...rules, filters: setExactRulePriority(rules.filters, key, priority) } })
}

/** Remove any exact rule on this key (back to no rule at all). */
export async function clearRule(key: RuleKey): Promise<void> {
  if (!extensionAlive())
    return

  const rules = await options.get('rules')
  const filters = rules.filters.filter(r => !ruleHasKey(r, key))
  await options.set({ rules: { ...rules, filters } })
}
