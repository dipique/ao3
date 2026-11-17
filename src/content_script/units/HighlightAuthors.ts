import { ADDON_CLASS, authorFromURL, highlightingRules, ruleMatchesAuthor } from '#common'
import { isOrphanAccount } from '#content_script/authorPage.js'
import { Unit } from '#content_script/Unit.js'

const HIGHLIGHT_CLASS = `${ADDON_CLASS}--highlight-author`
const COLOR_PROP = '--ao3e-highlight-color'

/** Author byline links AO3 marks with rel="author" (blurbs, work pages, etc.). */
const AUTHOR_LINK_SELECTOR = 'a[rel=author]'

/**
 * Highlights bylines of "favourite" authors: any author link matching an author
 * rule that highlights — a `'highlight'` rule, or an `'invert'` rule that
 * hasn't opted out — gets a coloured background wherever it appears.
 * Purely visual: it never hides or force-shows a work (that's HideWorks' job).
 * The author analogue of {@link HighlightTags}.
 */
export class HighlightAuthors extends Unit {
  static override get name() { return 'HighlightAuthors' }
  override get enabled() { return this.options.rules.enabled }

  static override async clean(): Promise<void> {
    // The highlight class sits on native page elements (not our own nodes), so
    // the generic ADDON_CLASS cleanup won't catch it — undo it by hand.
    for (const el of document.querySelectorAll(`.${HIGHLIGHT_CLASS}`)) {
      el.classList.remove(HIGHLIGHT_CLASS)
      if (el instanceof HTMLElement)
        el.style.removeProperty(COLOR_PROP)
    }
  }

  override async ready(): Promise<void> {
    const { filters, colors } = this.options.rules
    const highlights = highlightingRules(filters, colors)
    if (highlights.length === 0)
      return

    let count = 0
    for (const el of this.root.querySelectorAll(AUTHOR_LINK_SELECTOR)) {
      if (!(el instanceof HTMLAnchorElement))
        continue
      const author = authorFromURL(el.href)
      // The orphan account isn't a real user; nothing to favourite there.
      if (!author || isOrphanAccount(author.userId))
        continue
      const match = highlights.find(h => ruleMatchesAuthor(h.rule, author))
      if (!match)
        continue
      el.classList.add(HIGHLIGHT_CLASS)
      el.style.setProperty(COLOR_PROP, match.color)
      count++
    }

    this.logger.debug(`Highlighted ${count} author bylines.`)
  }
}
