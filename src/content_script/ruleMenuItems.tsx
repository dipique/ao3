import MdiArrowCollapseVertical from '~icons/mdi/arrow-collapse-vertical.jsx'
import MdiCloseCircleOutline from '~icons/mdi/close-circle-outline.jsx'
import MdiEyeCheck from '~icons/mdi/eye-check.jsx'
import MdiEyeOffOutline from '~icons/mdi/eye-off-outline.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiStar from '~icons/mdi/star.jsx'
import MdiTagOff from '~icons/mdi/tag-off.jsx'

import type { FilterBehavior, Rule, RuleKey, RulePriorityDefaults } from '#common'

import { behaviorOf, defaultRulePriority, isTagTarget, MAX_PRIORITY, MIN_PRIORITY, ruleAffectsWorks, rulePriority, ruleSubject } from '#common'
import React from '#dom'

import type { MenuItem } from './contextMenu.tsx'

import { FILTER_LABELS } from './contextTrigger.tsx'
import { overruledOn } from './overruled.ts'
import { clearRule, setPriorityOf, setRuleBehavior, setRulePriority, toggleRuleBehavior } from './persistentFilters.js'

/**
 * The rows every menu that can write a rule offers — hide, collapse, always
 * show, highlight, and (for tags) hide the tag itself, the first three with a
 * submenu of priorities — and on an "always show" a row for each hide it is
 * holding off on the work at hand.
 *
 * The companion to `persistentFilters.ts`, which owns the other half of the same
 * concern: that module reads and writes the rule, this one draws it. Every
 * toolbar that decorates something a rule can point at — tags, fandoms, authors,
 * works, series — builds its block from here, so the labels, icons and
 * active/disabled states can't drift apart between them, and a behaviour added
 * to {@link FilterBehavior} is offered everywhere by adding one row below.
 */

/** One offered behaviour, and how it presents itself. */
interface BehaviorRow {
  behavior: Exclude<FilterBehavior, 'none'>
  /** The row's `data-ao3e-action`. */
  action: string
  icon: () => Node
  /** `noun` is the thing the rule points at — "tag", "author", "work". */
  label: (noun: string) => string
  /** Rendered in the destructive accent. */
  danger?: boolean
  /** Left out for targets the behaviour means nothing for. Always offered when absent. */
  applies?: (key: RuleKey) => boolean
}

const BEHAVIOR_ROWS: BehaviorRow[] = [
  { behavior: 'hide', action: 'hide', icon: () => <MdiEyeOff />, label: noun => `Hide works with ${noun}`, danger: true },
  { behavior: 'collapse', action: 'collapse', icon: () => <MdiArrowCollapseVertical />, label: noun => `Collapse works with ${noun}` },
  { behavior: 'invert', action: 'always-show', icon: () => <MdiEyeCheck />, label: noun => `Always show works with ${noun}` },
  { behavior: 'highlight', action: 'highlight', icon: () => <MdiStar />, label: noun => `Highlight ${noun}` },
  {
    // Hides the tag itself wherever it's listed, leaving the work alone. Once
    // applied the tag is gone from the page, so undoing it is a settings job.
    // Offered for tag targets only — there is no author or work link to take out
    // of a tag list — which is the same test the options editor's rule dialog
    // gates its `hideFilter` option on.
    behavior: 'hideFilter',
    action: 'hide-tag',
    icon: () => <MdiTagOff />,
    label: () => 'Hide useless tag',
    applies: key => isTagTarget(key.target),
  },
]

/** Options for {@link ruleBehaviorItems}. */
export interface RuleMenuOptions {
  /** Names the target in the labels that take one: "Hide tag", "Collapse author". */
  noun: string
  /**
   * Per-behaviour icon overrides, for a target whose rows read better with its
   * own iconography (an author byline hides behind a person, not an eye).
   */
  icons?: Partial<Record<FilterBehavior, () => Node>>
  /**
   * The link the menu was opened on. Inside a blurb, an "always show" lists the
   * hide rules it outranks there (see `overruledOn`), each with a submenu to
   * change that rule's priority.
   */
  at?: Element
  /** The rules settings, for the priority a rule takes when it sets none of its own. */
  defaults: RulePriorityDefaults
}

/**
 * The rule rows for one target. `rule` is the key's exact rule, if it has one
 * (see `findExactRule`) — the caller reads it, since a menu that offers more
 * than these rows usually needs the rules list anyway, and reading it twice on
 * one menu open could show two different answers.
 *
 * The behaviour the rule has is marked. Hide, collapse and always show each open
 * a submenu of priorities: on the rule's own behaviour it changes the rule's
 * priority, which the row shows, and offers "Clear"; on any other it gives the
 * key that behaviour at the priority picked, replacing the rule. Highlighting
 * and hiding the tag have no priority, so their rows toggle the behaviour. A
 * disabled rule has no row of its own, so it gets a "Clear" in the menu itself.
 */
export function ruleBehaviorItems(
  key: RuleKey,
  rule: Rule | undefined,
  { noun, icons, at, defaults }: RuleMenuOptions,
): MenuItem[] {
  const behavior = behaviorOf(rule)
  /** The rule's priority, when it has one that decides anything. */
  const current = rule && ruleAffectsWorks(rule) ? rulePriority(rule, defaults) : undefined
  const items: MenuItem[] = []
  for (const row of BEHAVIOR_ROWS) {
    if (row.applies && !row.applies(key))
      continue
    const own = behavior === row.behavior
    const label = row.label(noun)
    const item: MenuItem = {
      icon: icons?.[row.behavior] ?? row.icon,
      label,
      action: row.action,
      scope: 'settings',
      danger: row.danger,
      active: own,
    }
    if (!ruleAffectsWorks({ behavior: row.behavior }))
      items.push({ ...item, onSelect: () => toggleRuleBehavior(key, row.behavior) })
    else if (own && current !== undefined)
      items.push({ ...item, label: `${label} (${current})`, submenu: [...priorityRows(current, priority => setRulePriority(key, priority)), clearRow(key)] })
    else
      items.push({ ...item, submenu: newRulePriorityRows(defaultRulePriority(row.behavior, defaults), current, priority => setRuleBehavior(key, row.behavior, priority)) })
  }
  if (rule?.behavior === 'invert' && at && current !== undefined)
    items.push(...overridingItems(current, at))
  if (behavior === 'none')
    items.push(clearRow(key))
  return items
}

function clearRow(key: RuleKey): MenuItem {
  return {
    icon: () => <MdiCloseCircleOutline />,
    label: 'Clear',
    action: 'clear',
    scope: 'settings',
    onSelect: () => clearRule(key),
  }
}

/** The submenu row choosing `priority`. */
function priorityRow(priority: number, pick: (priority: number) => Promise<void>, marks: Pick<MenuItem, 'active' | 'disabled'> & { note?: string }): MenuItem {
  return {
    label: marks.note ? `Priority ${priority} (${marks.note})` : `Priority ${priority}`,
    action: 'set-priority',
    value: String(priority),
    scope: 'settings',
    active: marks.active,
    disabled: marks.disabled,
    onSelect: () => pick(priority),
  }
}

function everyPriority(): number[] {
  return Array.from({ length: MAX_PRIORITY - MIN_PRIORITY + 1 }, (_, i) => MIN_PRIORITY + i)
}

/** A submenu of every priority, the current one marked and not offered. */
function priorityRows(current: number, pick: (priority: number) => Promise<void>): MenuItem[] {
  return everyPriority().map(priority => priorityRow(priority, pick, { active: priority === current, disabled: priority === current }))
}

/**
 * A submenu of every priority for a rule not yet made, each offered: the new
 * behaviour's default marked, and so is the `current` priority of the rule it
 * would replace.
 */
function newRulePriorityRows(byDefault: number, current: number | undefined, pick: (priority: number) => Promise<void>): MenuItem[] {
  return everyPriority().map((priority) => {
    const note = priority === current ? 'current' : priority === byDefault ? 'default' : undefined
    return priorityRow(priority, pick, { active: note !== undefined, note })
  })
}

/** A row naming another rule, which opens that rule's priorities. */
function otherRuleRow(rule: Rule, priority: number, row: { icon: () => Node, label: string, action: string }): MenuItem {
  return {
    icon: row.icon,
    label: `${row.label} (priority ${priority})`,
    action: row.action,
    value: rule.value,
    scope: 'settings',
    submenu: priorityRows(priority, next => setPriorityOf(rule, next)),
  }
}

/**
 * A row for each hide rule a force-show at `strength` outranks on the blurb `at`
 * sits in — by itself, so a hide that only a stronger force-show holds off is
 * left to that one's menu. Each opens the hide rule's own priorities.
 */
function overridingItems(strength: number, at: Element): MenuItem[] {
  const blurb = at.closest('.blurb')
  if (!blurb)
    return []
  return overruledOn(blurb)
    .filter(({ priority }) => priority <= strength)
    .map(({ rule, subject, priority }) => otherRuleRow(rule, priority, {
      icon: () => <MdiEyeOffOutline />,
      label: `Overriding ${subject}`,
      action: 'overriding',
    }))
}

/**
 * A row for each rule that weighs in on a work through the item without being
 * its exact rule (see `matchedTagRules`), saying what the rule does and naming
 * it, as the item's indicator does. Each opens the rule's own priorities.
 */
export function matchedRuleItems(rules: Rule[], defaults: RulePriorityDefaults): MenuItem[] {
  return rules.flatMap((rule) => {
    const row = BEHAVIOR_ROWS.find(row => row.behavior === behaviorOf(rule))
    return row
      ? [otherRuleRow(rule, rulePriority(rule, defaults), {
          icon: row.icon,
          label: `${FILTER_LABELS[row.behavior]}: ${ruleSubject(rule)}`,
          action: 'matched-rule',
        })]
      : []
  })
}
