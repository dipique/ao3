import type { AuthorFilter } from '#common'

import { ADDON_CLASS, authorFilterMatchesAuthor, DEFAULT_AUTHOR_HIGHLIGHT_COLOR, filterHighlightColor } from '#common'
import { isOrphanAccount } from '#content_script/authorPage.js'
import { Unit } from '#content_script/Unit.js'

const HIGHLIGHT_CLASS = `${ADDON_CLASS}--highlight-author`
const COLOR_PROP = '--ao3e-highlight-color'

/** Author byline links AO3 marks with rel="author" (blurbs, work pages, etc.). */
const AUTHOR_LINK_SELECTOR = 'a[rel=author]'

/** Pull the userId (and pseud, if present) out of a `/users/:id/pseuds/:pseud` link. */
function parseAuthorLink(link: HTMLAnchorElement): { userId: string, pseud?: string } | null {
  const parts = new URL(link.href).pathname.split('/').filter(Boolean)
  if (parts[0] !== 'users' || !parts[1])
    return null
  return { userId: parts[1], pseud: parts[2] === 'pseuds' ? parts[3] : undefined }
}

/**
 * Highlights bylines of "favourite" authors: any author link matching a
 * hideAuthors filter that highlights — a `'highlight'` filter, or an `'invert'`
 * filter that hasn't opted out — gets a coloured background wherever it appears.
 * Purely visual: it never hides or force-shows a work (that's HideWorks' job).
 * The author analogue of {@link HighlightTags}.
 */
export class HighlightAuthors extends Unit {
  static override get name() { return 'HighlightAuthors' }
  override get enabled() { return this.options.hideAuthors.enabled }

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
    const { filters, defaultHighlightColor } = this.options.hideAuthors
    const defaultColor = defaultHighlightColor || DEFAULT_AUTHOR_HIGHLIGHT_COLOR
    const highlights: { filter: AuthorFilter, color: string }[] = []
    for (const filter of filters) {
      const color = filterHighlightColor(filter, defaultColor)
      if (color !== null)
        highlights.push({ filter, color })
    }
    if (highlights.length === 0)
      return

    let count = 0
    for (const el of document.querySelectorAll(AUTHOR_LINK_SELECTOR)) {
      if (!(el instanceof HTMLAnchorElement))
        continue
      const author = parseAuthorLink(el)
      // The orphan account isn't a real user; nothing to favourite there.
      if (!author || isOrphanAccount(author.userId))
        continue
      const match = highlights.find(h => authorFilterMatchesAuthor(h.filter, author))
      if (!match)
        continue
      el.classList.add(HIGHLIGHT_CLASS)
      el.style.setProperty(COLOR_PROP, match.color)
      count++
    }

    this.logger.debug(`Highlighted ${count} author bylines.`)
  }
}
