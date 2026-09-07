import MdiArrowCollapseVertical from '~icons/mdi/arrow-collapse-vertical.jsx'
import MdiCloseCircleOutline from '~icons/mdi/close-circle-outline.jsx'
import MdiEyeCheck from '~icons/mdi/eye-check.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiStar from '~icons/mdi/star.jsx'
import MdiTagOff from '~icons/mdi/tag-off.jsx'

import type { FilterBehavior } from '#common'

import { isTagTarget } from '#common'
import React from '#dom'

import type { MenuItem } from './contextMenu.tsx'
import type { RuleTargetKey } from './persistentFilters.js'

import { clearRule, toggleRuleBehavior } from './persistentFilters.js'

/**
 * The rows every menu that can write a rule offers — hide, collapse, always
 * show, highlight, and (for tags) hide the tag itself, plus the "Clear" row that
 * appears once one of them is in force.
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
  icon: () => Node
  /** `noun` is the thing the rule points at — "tag", "author", "work". */
  label: (noun: string) => string
  /** Rendered in the destructive accent. */
  danger?: boolean
  /** Left out for targets the behaviour means nothing for. Always offered when absent. */
  applies?: (key: RuleTargetKey) => boolean
}

const BEHAVIOR_ROWS: BehaviorRow[] = [
  { behavior: 'hide', icon: () => <MdiEyeOff />, label: noun => `Hide ${noun}`, danger: true },
  { behavior: 'collapse', icon: () => <MdiArrowCollapseVertical />, label: noun => `Collapse ${noun}` },
  { behavior: 'invert', icon: () => <MdiEyeCheck />, label: () => 'Always show' },
  { behavior: 'highlight', icon: () => <MdiStar />, label: () => 'Highlight' },
  {
    // Hides the tag itself wherever it's listed, leaving the work alone. Once
    // applied the tag is gone from the page, so undoing it is a settings job.
    // Offered for tag targets only — there is no author or work link to take out
    // of a tag list — which is the same test the options editor's rule dialog
    // gates its `hideFilter` option on.
    behavior: 'hideFilter',
    icon: () => <MdiTagOff />,
    label: () => 'Remove tag from results',
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
}

/**
 * The rule rows for one target. `behavior` is what the key currently carries
 * (see `ruleBehavior`) — the caller reads it, since a menu that offers more than
 * these rows usually needs the rules list anyway, and reading it twice on one
 * menu open could show two different answers.
 *
 * The active behaviour is shown disabled (it's the current state, not an action);
 * "Clear" is how you get back to no rule at all.
 */
export function ruleBehaviorItems(
  key: RuleTargetKey,
  behavior: FilterBehavior | null,
  { noun, icons }: RuleMenuOptions,
): MenuItem[] {
  const items: MenuItem[] = []
  for (const row of BEHAVIOR_ROWS) {
    if (row.applies && !row.applies(key))
      continue
    items.push({
      icon: icons?.[row.behavior] ?? row.icon,
      label: row.label(noun),
      scope: 'settings',
      danger: row.danger,
      active: behavior === row.behavior,
      disabled: behavior === row.behavior,
      onSelect: () => toggleRuleBehavior(key, row.behavior),
    })
  }
  if (behavior) {
    items.push({
      icon: () => <MdiCloseCircleOutline />,
      label: 'Clear',
      scope: 'settings',
      onSelect: () => clearRule(key),
    })
  }
  return items
}
