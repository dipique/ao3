import type { TagFilter } from '#common'

import { ADDON_CLASS, filterHighlightColor, tagFilterMatchesTag } from '#common'
import { Unit } from '#content_script/Unit.js'
import { getTagFromElement } from '#content_script/utils.js'

const HIGHLIGHT_CLASS = `${ADDON_CLASS}--highlight-tag`
const COLOR_PROP = '--ao3e-highlight-color'

/** Tag links, as they appear in blurbs and on work pages. */
const TAG_SELECTOR = 'a.tag'

/**
 * Highlights "favourite" tags: any tag matching a hideTags filter that
 * highlights — a `'highlight'` filter, or an `'invert'` filter that hasn't
 * opted out — gets a coloured background wherever it appears. Purely visual:
 * it never hides or force-shows a work (that's HideWorks' job).
 */
export class HighlightTags extends Unit {
  static override get name() { return 'HighlightTags' }
  override get enabled() { return this.options.hideTags.enabled }

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
    const { filters, defaultHighlightColor } = this.options.hideTags
    const highlights: { filter: TagFilter, color: string }[] = []
    for (const filter of filters) {
      const color = filterHighlightColor(filter, defaultHighlightColor)
      if (color !== null)
        highlights.push({ filter, color })
    }
    if (highlights.length === 0)
      return

    let count = 0
    for (const el of this.root.querySelectorAll(TAG_SELECTOR)) {
      const tag = getTagFromElement(el)
      const match = highlights.find(h => tagFilterMatchesTag(h.filter, tag))
      if (!match)
        continue
      el.classList.add(HIGHLIGHT_CLASS)
      if (el instanceof HTMLElement)
        el.style.setProperty(COLOR_PROP, match.color)
      count++
    }

    this.logger.debug(`Highlighted ${count} tags.`)
  }
}
