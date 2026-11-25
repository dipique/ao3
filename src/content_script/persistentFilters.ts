import type { FilterBehavior, Rule, RuleKey, RulePriorityDefaults } from '#common'

import { options, replaceExactRule, ruleHasKey, setExactRulePriority, setRulePriorityOf, toggleExactRule } from '#common'

import { extensionAlive } from './extensionAlive.ts'

/**
 * Change the *persistent* extension rules — the saved `rules` list (as
 * opposed to the ephemeral AO3 sidebar filters handled by `filterSidebar.tsx`).
 *
 * Every menu that sets a hide/collapse/always-show/highlight state or a rule's
 * priority goes through here, so the read-freshest → change → `options.set`
 * pattern lives in one place; what each change does to the list is decided by
 * the pure exact-rule helpers in `rules.ts` (`toggleExactRule` and friends).
 *
 * The behaviours map onto {@link FilterBehavior}: `hide` takes the work away,
 * `collapse` squeezes it down to a reason line, `invert` force-shows it ("always
 * show"), `highlight` only highlights it, and `hideFilter` hides the tag itself.
 */

/**
 * Read the freshest rules, change them, and store the result. Every one of these
 * is the reader choosing something from a menu, so an orphaned page says so
 * rather than reading defaults and dropping the write (see
 * {@link file://./extensionAlive.ts}). `enable` switches the rules on as well,
 * for a change that adds a rule the reader means to see work.
 */
async function changeRules(change: (filters: Rule[], defaults: RulePriorityDefaults) => Rule[], enable = false): Promise<void> {
  if (!extensionAlive())
    return

  const rules = await options.get('rules')
  await options.set({ rules: { ...rules, ...enable ? { enabled: true } : {}, filters: change(rules.filters, rules) } })
}

/** Toggle `behavior` for an exact key in the rules list (re-selecting clears it). */
export function toggleRuleBehavior(key: RuleKey, behavior: FilterBehavior): Promise<void> {
  return changeRules((filters, defaults) => toggleExactRule(filters, key, behavior, defaults), true)
}

/** Give an exact key `behavior` at `priority`, in place of any rule it has. */
export function setRuleBehavior(key: RuleKey, behavior: FilterBehavior, priority: number): Promise<void> {
  return changeRules((filters, defaults) => replaceExactRule(filters, key, behavior, defaults, priority), true)
}

/** Set the priority of the exact rule on this key; nothing happens when it has none. */
export function setRulePriority(key: RuleKey, priority: number): Promise<void> {
  return changeRules((filters, defaults) => setExactRulePriority(filters, key, priority, defaults))
}

/** Set the priority of the stored rule equal to `rule`; nothing happens when there is none. */
export function setPriorityOf(rule: Rule, priority: number): Promise<void> {
  return changeRules((filters, defaults) => setRulePriorityOf(filters, rule, priority, defaults))
}

/** Remove any exact rule on this key (back to no rule at all). */
export function clearRule(key: RuleKey): Promise<void> {
  return changeRules(filters => filters.filter(r => !ruleHasKey(r, key)))
}
