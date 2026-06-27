import { applyTextReplacements } from '#common'
import { Unit } from '#content_script/Unit.js'

/** Root of a work's chapter text on a work page. */
const CHAPTERS_SELECTOR = '#chapters'

/** Elements whose text is markup/controls, not prose — never rewrite inside these. */
const SKIP_PARENTS = /^(?:script|style|textarea)$/i

/**
 * Original values of the text nodes we changed, keyed by node, so a re-run (e.g.
 * after the rules change in options) can revert to the source text before
 * re-applying. Lives for the page's lifetime; cleared by {@link clean}.
 */
const originals = new Map<Text, string>()

/**
 * Applies the user's find/replace rules to the displayed prose of a work's
 * chapters. Purely textual: it only edits text nodes (never markup), so links,
 * formatting and the rest of the page are untouched.
 */
export class TextReplace extends Unit {
  static override get name() { return 'TextReplace' }
  override get enabled() {
    return this.options.textReplacements.enabled
      && this.options.textReplacements.rules.some(r => r.find)
  }

  static override async clean(): Promise<void> {
    for (const [node, value] of originals) {
      // The node may have been detached since we recorded it; skip those.
      if (node.isConnected)
        node.nodeValue = value
    }
    originals.clear()
  }

  override async ready(): Promise<void> {
    const root = document.querySelector(CHAPTERS_SELECTOR)
    if (!root) {
      this.logger.debug('No chapter content on this page; skipping text replacement.')
      return
    }

    const rules = this.options.textReplacements.rules.filter(r => r.find)
    if (rules.length === 0)
      return

    let count = 0
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text
      if (SKIP_PARENTS.test(text.parentElement?.tagName ?? ''))
        continue

      const original = text.nodeValue ?? ''
      if (!original.trim())
        continue

      const replaced = applyTextReplacements(original, rules)
      if (replaced !== original) {
        originals.set(text, original)
        text.nodeValue = replaced
        count++
      }
    }

    this.logger.debug(`Applied text replacements to ${count} text node(s).`)
  }
}
