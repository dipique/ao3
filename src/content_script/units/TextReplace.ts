import { applyTextReplacements } from '#common'
import { Unit } from '#content_script/Unit.js'

/**
 * Root of a work's own text. `#workskin` rather than `#chapters` because the
 * summary and the notes live in `.preface.group`, a *sibling* of `#chapters` —
 * walking only the chapters left the two blocks readers most often want rewritten
 * untouched. `#chapters` is the fallback for a page that renders it without the
 * skin wrapper.
 */
const WORK_TEXT_SELECTORS = ['#workskin', '#chapters']

/**
 * Subtrees inside the root that carry the work's *identity* rather than its
 * prose. The title and byline are what the work menu reads to name a work, and
 * what a work rule stores as its matched value — rewriting them would feed the
 * reader's replacements back into the extension's own data.
 */
const SKIP_SUBTREES = '.preface.group > h2.title.heading, .preface.group > h3.byline.heading'

/** Elements whose text is markup/controls, not prose — never rewrite inside these. */
const SKIP_PARENTS = /^(?:script|style|textarea)$/i

/**
 * Original values of the text nodes we changed, keyed by node, so a re-run (e.g.
 * after the rules change in options) can revert to the source text before
 * re-applying. Lives for the page's lifetime; cleared by {@link clean}.
 */
const originals = new Map<Text, string>()

/**
 * Applies the user's find/replace rules to the displayed prose of a work — its
 * summary, notes and chapter text. Purely textual: it only edits text nodes
 * (never markup), so links, formatting and the rest of the page are untouched.
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
    const root = WORK_TEXT_SELECTORS.reduce<Element | null>(
      (found, selector) => found ?? document.querySelector(selector),
      null,
    )
    if (!root) {
      this.logger.debug('No work text on this page; skipping text replacement.')
      return
    }

    const rules = this.options.textReplacements.rules.filter(r => r.find)
    if (rules.length === 0)
      return

    let count = 0
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text
      const parent = text.parentElement
      if (SKIP_PARENTS.test(parent?.tagName ?? ''))
        continue
      if (parent?.closest(SKIP_SUBTREES))
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
