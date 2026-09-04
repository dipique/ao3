import type { TextPart } from '#common'

import { replaceTextParts, textReplacementActive } from '#common'
import { REPLACED_CLASS, REPLACED_RULE_ATTR } from '#content_script/textReplaceMarks.ts'
import { findWorkText, isReplaceableParent } from '#content_script/textReplaceScope.ts'
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

    // The whole list, inert entries included: `TextPart.rule` indexes it, and
    // that index is how a marked run leads back to the reader's own rule.
    const rules = this.options.textReplacements.rules
    if (!rules.some(textReplacementActive))
      return

    const mark = this.options.textReplacements.tools

    let count = 0
    // Collected first: rewriting as we walk would insert nodes into the tree the
    // walker is still stepping through, and it would step into them.
    const nodes: Text[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text
      if (!isReplaceableParent(text.parentElement))
        continue
      if (!(text.nodeValue ?? '').trim())
        continue
      nodes.push(text)
    }

    for (const text of nodes) {
      const original = text.nodeValue ?? ''
      const parts = replaceTextParts(original, rules)
      if (parts.every(part => part.rule === null))
        continue

      applied.set(text, { original, inserted: mark ? this.paint(text, parts) : [] })
      if (!mark)
        text.nodeValue = parts.map(part => part.text).join('')
      count++
    }

    this.logger.debug(`Applied text replacements to ${count} text node(s).`)
  }

  /**
   * Lay `parts` out as real nodes, keeping `anchor` as the first of them, and
   * return the siblings that were added after it.
   */
  private paint(anchor: Text, parts: TextPart[]): ChildNode[] {
    // A leading run of untouched text stays in the anchor. When the very first
    // run is a replacement the anchor is emptied instead and everything follows
    // it — an empty text node in the prose costs nothing and keeps the revert
    // to one rule.
    const leading = parts[0]!.rule === null ? 1 : 0
    const rest = parts.slice(leading).map(part => nodeFor(part))
    anchor.nodeValue = leading ? parts[0]!.text : ''
    anchor.after(...rest)
    return rest
  }
}

/** One run as a node: a plain text node, or a span naming the rule behind it. */
function nodeFor(part: TextPart): ChildNode {
  if (part.rule === null)
    return document.createTextNode(part.text)

  const span = document.createElement('span')
  span.className = REPLACED_CLASS
  span.setAttribute(REPLACED_RULE_ATTR, String(part.rule))
  span.title = 'Replaced by AO3 Enhancements — click to edit this replacement'
  span.textContent = part.text
  return span
}
