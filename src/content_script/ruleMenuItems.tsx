import MdiArrowCollapseVertical from '~icons/mdi/arrow-collapse-vertical.jsx'
import MdiCloseCircleOutline from '~icons/mdi/close-circle-outline.jsx'
import MdiEyeCheck from '~icons/mdi/eye-check.jsx'
import MdiEyeOffOutline from '~icons/mdi/eye-off-outline.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiFormatListNumbered from '~icons/mdi/format-list-numbered.jsx'
import MdiStar from '~icons/mdi/star.jsx'
import MdiTagOff from '~icons/mdi/tag-off.jsx'

import type { FilterBehavior, Rule, RuleKey } from '#common'

import { isTagTarget, MAX_PRIORITY, MIN_PRIORITY, ruleAffectsWorks, rulePriority } from '#common'
import React from '#dom'

import type { MenuItem } from './contextMenu.tsx'

import { overruledOn } from './overruled.ts'
import { behaviorOf, clearRule, setPriorityOf, setRulePriority, toggleRuleBehavior } from './persistentFilters.js'

/**
 * The rows every menu that can write a rule offers — hide, collapse, always
 * show, highlight, and (for tags) hide the tag itself, plus the "Update
 * Priority" and "Clear" rows that appear once one of them is in force, and on
 * an "always show" a row for each hide it is holding off on the work at hand.
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
}

/**
 * The rule rows for one target. `rule` is the key's exact rule, if it has one
 * (see `findExactRule`) — the caller reads it, since a menu that offers more
 * than these rows usually needs the rules list anyway, and reading it twice on
 * one menu open could show two different answers.
 *
 * The active behaviour is shown disabled (it's the current state, not an action);
 * "Clear" is how you get back to no rule at all.
 */
export function ruleBehaviorItems(
  key: RuleKey,
  rule: Rule | undefined,
  { noun, icons, at }: RuleMenuOptions,
): MenuItem[] {
  const behavior = behaviorOf(rule)
  const items: MenuItem[] = []
  for (const row of BEHAVIOR_ROWS) {
    if (row.applies && !row.applies(key))
      continue
    items.push({
      icon: icons?.[row.behavior] ?? row.icon,
      label: row.label(noun),
      action: row.action,
      scope: 'settings',
      danger: row.danger,
      active: behavior === row.behavior,
      disabled: behavior === row.behavior,
      onSelect: () => toggleRuleBehavior(key, row.behavior),
    })
  }
  // Priority only weighs in the contest over whether a work shows, which
  // highlighting, hiding the tag and a disabled rule never enter.
  if (rule && ruleAffectsWorks(rule)) {
    items.push({
      icon: () => <MdiFormatListNumbered />,
      label: 'Update Priority',
      action: 'priority',
      scope: 'settings',
      submenu: priorityRows(rulePriority(rule), priority => setRulePriority(key, priority)),
    })
  }
  if (rule?.behavior === 'invert' && at)
    items.push(...overridingItems(rulePriority(rule), at))
  if (behavior) {
    items.push({
      icon: () => <MdiCloseCircleOutline />,
      label: 'Clear',
      action: 'clear',
      scope: 'settings',
      onSelect: () => clearRule(key),
    })
  }
  return items
}

/** A submenu of every priority, the current one marked and not offered. */
function priorityRows(current: number, pick: (priority: number) => Promise<void>): MenuItem[] {
  const rows: MenuItem[] = []
  for (let priority = MIN_PRIORITY; priority <= MAX_PRIORITY; priority++) {
    rows.push({
      label: `Priority ${priority}`,
      action: 'set-priority',
      value: String(priority),
      scope: 'settings',
      active: priority === current,
      disabled: priority === current,
      onSelect: () => pick(priority),
    })
  }
  return rows
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
    .map(({ rule, subject, priority }) => ({
      icon: () => <MdiEyeOffOutline />,
      label: `Overriding ${subject} (priority ${priority})`,
      action: 'overriding',
      value: rule.value,
      scope: 'settings',
      submenu: priorityRows(priority, next => setPriorityOf(rule, next)),
    }))
}
