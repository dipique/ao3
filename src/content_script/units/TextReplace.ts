import type { TextSpan } from '#common'

import { replaceTextSegments, textReplacementActive } from '#common'
import { REPLACED_CLASS, REPLACED_RULE_ATTR } from '#content_script/textReplaceMarks.ts'
import { collectTextRuns, findWorkText } from '#content_script/textReplaceScope.ts'
import { Unit } from '#content_script/Unit.js'

/**
 * What we did to one text node, so a re-run (e.g. after the rules change in
 * options) can put the source text back before applying them again.
 *
 * The node itself is always kept as the anchor — it holds the leading run of
 * unchanged text, or nothing at all when a replacement starts the node — and
 * everything the rewrite added follows it as siblings. Reverting is therefore
 * "drop the siblings, restore the anchor's value", with no need to remember
 * where in the parent the node sat.
 */
interface Applied {
  original: string
  inserted: ChildNode[]
}

/** Lives for the page's lifetime; cleared by {@link TextReplace.clean}. */
const applied = new Map<Text, Applied>()

/**
 * Applies the user's find/replace rules to the displayed prose of a work — its
 * summary, notes and chapter text. Purely textual: it only edits text nodes
 * (never markup), so links, formatting and the rest of the page are untouched.
 *
 * The rules are matched a paragraph at a time rather than a text node at a time,
 * because markup splits a sentence into as many nodes as it has formatting
 * changes and a reader writes rules against the sentence. Which of those seams a
 * given rule may read across is the rule's own business — see
 * `TextReplacement.acrossFormatting` — but where the paragraphs are cut is not:
 * no rule reaches past the end of one.
 *
 * With the work-page tools switched on, each replaced run is wrapped in a span
 * carrying the index of the rule behind it, which is what gives
 * {@link file://./TextReplaceTools.tsx} something to underline and something to
 * open when the reader clicks it. The spans deliberately don't carry
 * `ADDON_CLASS`: the global clean-up sweep removes every `.AO3E` element
 * outright, and these hold the work's own words.
 */
export class TextReplace extends Unit {
  static override get name() { return 'TextReplace' }
  override get enabled() {
    return this.options.textReplacements.enabled
      && this.options.textReplacements.rules.some(textReplacementActive)
  }

  static override async clean(): Promise<void> {
    for (const [node, { original, inserted }] of applied) {
      for (const extra of inserted)
        extra.remove()
      // The node may have been detached since we recorded it; skip those.
      if (node.isConnected)
        node.nodeValue = original
    }
    applied.clear()
  }

  override async ready(): Promise<void> {
    const root = findWorkText()
    if (!root) {
      this.logger.debug('No work text on this page; skipping text replacement.')
      return
    }

    // The whole list, inert entries included: `TextSpan.rule` indexes it, and
    // that index is how a marked run leads back to the reader's own rule.
    const rules = this.options.textReplacements.rules
    if (!rules.some(textReplacementActive))
      return

    const mark = this.options.textReplacements.tools

    let count = 0
    // Collected up front: rewriting as we walk would put new nodes into the tree
    // the walk is still stepping through, and it would step into them.
    for (const nodes of collectTextRuns(root)) {
      const spans = replaceTextSegments(nodes.map(node => node.nodeValue ?? ''), rules)
      if (spans.every(span => span.rule === null))
        continue
      count += this.rewrite(nodes, spans, mark)
    }

    this.logger.debug(`Applied text replacements to ${count} text node(s).`)
  }

  /**
   * Write one run's spans back over the nodes they came from. Returns how many
   * nodes actually changed.
   *
   * A span says which node it belongs to, and they arrive in reading order, so
   * each node's share is a contiguous slice of the list — including the empty
   * slice, which is what a node whose every word was swallowed by a match that
   * began in the node before it gets.
   */
  private rewrite(nodes: Text[], spans: TextSpan[], mark: boolean): number {
    let changed = 0

    for (const [index, node] of nodes.entries()) {
      const original = node.nodeValue ?? ''
      const mine = spans.filter(span => span.segment === index)
      const next = mine.map(span => span.text).join('')
      // Untouched: the same words, and none of them written by a rule. (A node
      // can read the same and still have been rewritten — one rule undoing
      // another — and that still has to be recorded, so it can be reverted.)
      if (next === original && mine.every(span => span.rule === null))
        continue

      applied.set(node, { original, inserted: mark ? paint(node, mine) : [] })
      if (!mark)
        node.nodeValue = next
      changed++
    }

    return changed
  }
}

/**
 * Lay `spans` out as real nodes, keeping `anchor` as the first of them, and
 * return the siblings that were added after it.
 */
function paint(anchor: Text, spans: TextSpan[]): ChildNode[] {
  // A leading run of untouched text stays in the anchor. When the very first run
  // is a replacement — or there is nothing left for this node at all — the anchor
  // is emptied instead and anything else follows it. An empty text node in the
  // prose costs nothing and keeps the revert to one rule.
  const leading = spans[0]?.rule === null ? 1 : 0
  const rest = spans.slice(leading).map(span => nodeFor(span))
  anchor.nodeValue = leading ? spans[0]!.text : ''
  anchor.after(...rest)
  return rest
}

/** One run as a node: a plain text node, or a span naming the rule behind it. */
function nodeFor(span: TextSpan): ChildNode {
  if (span.rule === null)
    return document.createTextNode(span.text)

  const el = document.createElement('span')
  el.className = REPLACED_CLASS
  el.setAttribute(REPLACED_RULE_ATTR, String(span.rule))
  el.title = 'Replaced by AO3 Enhancements — click to edit this replacement'
  el.textContent = span.text
  return el
}
