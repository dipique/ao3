import type { EntityFilter } from '#common'

import { ADDON_CLASS, DEFAULT_SERIES_HIGHLIGHT_COLOR, DEFAULT_WORK_HIGHLIGHT_COLOR, entityFilterMatches, filterHighlightColor } from '#common'
import { Unit } from '#content_script/Unit.js'

const COLOR_PROP = '--ao3e-highlight-color'

/**
 * Highlights links to "favourite" works or series: any `/works/:id` (or
 * `/series/:id`) link matching a hideWorks/hideSeries filter that highlights — a
 * `'highlight'` filter, or an `'invert'` filter that hasn't opted out — gets a
 * coloured background wherever it appears. Purely visual: it never hides or
 * force-shows a work (that's HideWorks' job). The work/series analogue of
 * HighlightTags / HighlightAuthors.
 *
 * Subclasses supply the link kind (and its option/default colour); everything
 * else is shared, since works and series highlight identically.
 */
abstract class HighlightEntities extends Unit {
  /** `'works'` or `'series'` — the path segment its links use. */
  protected abstract get kind(): 'works' | 'series'
  /** The option list ({@link Unit.options} key) holding this kind's filters. */
  protected abstract get filters(): EntityFilter[]
  /** Highlight colour used by filters that don't set their own. */
  protected abstract get defaultColor(): string
  /** CSS class applied to highlighted links (its own default colour lives in CSS). */
  protected abstract get highlightClass(): string

  override async ready(): Promise<void> {
    const highlights: { filter: EntityFilter, color: string }[] = []
    for (const filter of this.filters) {
      const color = filterHighlightColor(filter, this.defaultColor)
      if (color !== null)
        highlights.push({ filter, color })
    }
    if (highlights.length === 0)
      return

    const idRe = new RegExp(`^/${this.kind}/(\\d+)(?:/|$)`)
    let count = 0
    for (const el of document.querySelectorAll<HTMLAnchorElement>(`a[href*="/${this.kind}/"]`)) {
      let id: string | undefined
      try {
        id = new URL(el.href).pathname.match(idRe)?.[1]
      }
      catch {
        continue
      }
      if (!id)
        continue
      const entity = { id, name: el.textContent!.trim() }
      const match = highlights.find(h => entityFilterMatches(h.filter, entity))
      if (!match)
        continue
      el.classList.add(this.highlightClass)
      el.style.setProperty(COLOR_PROP, match.color)
      count++
    }

    this.logger.debug(`Highlighted ${count} ${this.kind} links.`)
  }
}

/** Removes a highlight class added by a {@link HighlightEntities} unit. */
async function cleanHighlightClass(className: string): Promise<void> {
  // The highlight class sits on native page elements (not our own nodes), so the
  // generic ADDON_CLASS cleanup won't catch it — undo it by hand.
  for (const el of document.querySelectorAll(`.${className}`)) {
    el.classList.remove(className)
    if (el instanceof HTMLElement)
      el.style.removeProperty(COLOR_PROP)
  }
}

const HIGHLIGHT_WORK_CLASS = `${ADDON_CLASS}--highlight-work`
const HIGHLIGHT_SERIES_CLASS = `${ADDON_CLASS}--highlight-series`

export class HighlightWorks extends HighlightEntities {
  static override get name() { return 'HighlightWorks' }
  override get enabled() { return this.options.hideWorks.enabled }
  protected override get kind() { return 'works' as const }
  protected override get filters() { return this.options.hideWorks.filters }
  protected override get defaultColor() { return this.options.hideWorks.defaultHighlightColor || DEFAULT_WORK_HIGHLIGHT_COLOR }
  protected override get highlightClass() { return HIGHLIGHT_WORK_CLASS }

  static override async clean(): Promise<void> {
    await cleanHighlightClass(HIGHLIGHT_WORK_CLASS)
  }
}

export class HighlightSeries extends HighlightEntities {
  static override get name() { return 'HighlightSeries' }
  override get enabled() { return this.options.hideSeries.enabled }
  protected override get kind() { return 'series' as const }
  protected override get filters() { return this.options.hideSeries.filters }
  protected override get defaultColor() { return this.options.hideSeries.defaultHighlightColor || DEFAULT_SERIES_HIGHLIGHT_COLOR }
  protected override get highlightClass() { return HIGHLIGHT_SERIES_CLASS }

  static override async clean(): Promise<void> {
    await cleanHighlightClass(HIGHLIGHT_SERIES_CLASS)
  }
}
