import type { Options } from './options.ts'

import { canonicalStringify } from './syncCodec.ts'
import { countIds, localMarkIds, markItems } from './workMarks.ts'

/**
 * The deletion guard: whether an incoming sync update would take a large share
 * of what this browser holds away, in which case the engine holds it back and
 * asks instead of applying it.
 *
 * Sync replaces a whole option with whatever the newest writer had. That's right
 * for an edit and ruinous for a mistake: a browser that never received the rules
 * list, or restored an old backup, or ran a build with a bug, looks exactly like
 * a reader who deleted everything. No version number or key list can tell those
 * apart, so the lists that take months to build get a check of their own.
 *
 * Pure, so the thresholds are tested headlessly.
 */

/** An update must remove at least this many entries from a collection to be held… */
export const GUARD_MIN_REMOVED = 5
/** …and at least this share of what this browser holds. */
export const GUARD_MIN_SHARE = 0.25

export interface CollectionLoss {
  /** Entries this browser has that the update doesn't. */
  removed: number
  /** Entries this browser has. */
  of: number
}

export interface PullLoss {
  rules: CollectionLoss
  markedWorks: CollectionLoss
  textReplacements: CollectionLoss
  /**
   * Labels of marks that hold works here and don't exist in the update. A mark
   * is never deleted by the reader, so losing one is always suspect.
   */
  marks: string[]
}

/** What `incoming` would remove from `current`, or `null` when it's within bounds. */
export function assessPull(current: Options, incoming: Options): PullLoss | null {
  const loss: PullLoss = {
    rules: lossOf(ruleKeys(current), ruleKeys(incoming)),
    markedWorks: lossOf(markedWorkIds(current), markedWorkIds(incoming)),
    textReplacements: lossOf(replacementKeys(current), replacementKeys(incoming)),
    marks: lostMarks(current, incoming),
  }
  const tripped = [loss.rules, loss.markedWorks, loss.textReplacements].some(isLarge) || loss.marks.length > 0
  return tripped ? loss : null
}

function isLarge({ removed, of }: CollectionLoss): boolean {
  return removed >= GUARD_MIN_REMOVED && removed >= of * GUARD_MIN_SHARE
}

function lossOf(current: Set<string>, incoming: Set<string>): CollectionLoss {
  let removed = 0
  for (const key of current) {
    if (!incoming.has(key))
      removed++
  }
  return { removed, of: current.size }
}

/** A rule is what it matches; its behaviour, colour and priority are edits to it. */
function ruleKeys(options: Options): Set<string> {
  return new Set((options.rules?.filters ?? []).map(rule => canonicalStringify([rule.target, rule.value, rule.pseud ?? null, rule.matcher])))
}

/** A replacement is what it finds; what it replaces that with is an edit to it. */
function replacementKeys(options: Options): Set<string> {
  return new Set((options.textReplacements?.rules ?? []).map(rule => rule.find))
}

function markedWorkIds(options: Options): Set<string> {
  const marks = options.workMarks?.marks ?? {}
  const ids = new Set<string>()
  for (const mark of localMarkIds(marks)) {
    for (const id of markItems(marks, mark))
      ids.add(id)
  }
  return ids
}

function lostMarks(current: Options, incoming: Options): string[] {
  const marks = current.workMarks?.marks ?? {}
  const kept = incoming.workMarks?.marks ?? {}
  return localMarkIds(marks)
    .filter(id => !(id in kept) && countIds(marks[id]!.items ?? '') > 0)
    .map(id => marks[id]!.label)
}

/**
 * The loss in words, for the options page and the page notice: "348 of your
 * 348 rules and 267 of your 282 marked works". Collections the update leaves
 * alone aren't mentioned.
 */
export function describePullLoss(loss: PullLoss): string {
  const parts: string[] = []
  const count = ({ removed, of }: CollectionLoss, noun: string) => {
    if (removed > 0)
      parts.push(`${removed.toLocaleString()} of your ${of.toLocaleString()} ${noun}`)
  }
  count(loss.rules, 'rules')
  count(loss.markedWorks, 'marked works')
  count(loss.textReplacements, 'text replacements')
  if (loss.marks.length)
    parts.push(`${loss.marks.length === 1 ? 'the mark' : 'the marks'} ${loss.marks.map(label => `“${label}”`).join(', ')}`)
  if (parts.length <= 1)
    return parts[0] ?? 'nothing'
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}
