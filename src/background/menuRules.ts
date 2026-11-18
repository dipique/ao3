import type { FilterBehavior, Rule, RuleKey, RulePriorityDefaults } from '../common/rules.ts'

import { behaviorOf, findExactRule, toggleExactRule } from '../common/rules.ts'

/**
 * What the browser's own menu on a tag or author link does with the link's
 * exact rule. Its two items each stand for one behaviour, and choose it the way
 * the in-page menus do (`toggleExactRule`): the behaviour the rule already has
 * removes the rule, and any other replaces it.
 */

/** One of the two items the browser's menu offers on a link. */
export type MenuChoice = 'hide' | 'show'

const CHOICES = {
  hide: { behavior: 'hide', verb: 'hidden', undoVerb: 'unhidden' },
  show: { behavior: 'invert', verb: 'shown', undoVerb: 'unshown' },
} as const satisfies Record<MenuChoice, { behavior: FilterBehavior, verb: string, undoVerb: string }>

/** What the toast says a click did to the link. */
export type MenuVerb = typeof CHOICES[MenuChoice]['verb' | 'undoVerb']

/** Which of the link's items show a checkmark: the one whose behaviour the key's exact rule has. */
export function menuChecks(rules: Rule[], key: RuleKey): Record<MenuChoice, boolean> {
  const behavior = behaviorOf(findExactRule(rules, key))
  return { hide: behavior === CHOICES.hide.behavior, show: behavior === CHOICES.show.behavior }
}

/** A click on one of the items: the rules it leaves, and whether it removed the rule the item stands for. */
export function menuClick(rules: Rule[], key: RuleKey, choice: MenuChoice, defaults: RulePriorityDefaults): { filters: Rule[], undone: boolean } {
  return {
    filters: toggleExactRule(rules, key, CHOICES[choice].behavior, defaults),
    undone: menuChecks(rules, key)[choice],
  }
}

/** What the toast says a click did to the link. */
export function menuVerb(choice: MenuChoice, undone: boolean): MenuVerb {
  const { verb, undoVerb } = CHOICES[choice]
  return undone ? undoVerb : verb
}
