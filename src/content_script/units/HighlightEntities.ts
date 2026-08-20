import type { Rule } from '#common'

import { ADDON_CLASS, ruleHighlightColor, ruleMatchesEntity } from '#common'
import { Unit } from '#content_script/Unit.js'

const COLOR_PROP = '--ao3e-highlight-color'

/**
 * Highlights links to "favourite" works or series: any `/works/:id` (or
 * `/series/:id`) link matching a rule that highlights — a `'highlight'` rule, or
 * an `'invert'` rule that hasn't opted out — gets a coloured background wherever
 * it appears. Purely visual: it never hides or force-shows a work (that's
 * HideWorks' job). The work/series analogue of HighlightTags / HighlightAuthors.
 *
 * Subclasses supply the link kind; everything else is shared, since works and
 * series highlight identically (and their default colours come from the rule
 * target, not from here).
 */
abstract class HighlightEntities extends Unit {
  /** `'work'` or `'series'` — the rule target its links carry. */
  protected abstract get target(): 'work' | 'series'
  /** CSS class applied to highlighted links (its own default colour lives in CSS). */
  protected abstract get highlightClass(): string

  override get enabled() { return this.options.rules.enabled }

  /** The path segment this kind's links use. */
  private get kind(): string {
    return this.target === 'work' ? 'works' : 'series'
  }

  override async ready(): Promise<void> {
    const { filters, colors } = this.options.rules
    const highlights: { filter: Rule, color: string }[] = []
    for (const filter of filters) {
      if (filter.target !== this.target)
        continue
      const color = ruleHighlightColor(filter, colors)
      if (color !== null)
        highlights.push({ filter, color })
    }
    if (highlights.length === 0)
      return

    const idRe = new RegExp(`^/${this.kind}/(\\d+)(?:/|$)`)
    let count = 0
    for (const el of this.root.querySelectorAll<HTMLAnchorElement>(`a[href*="/${this.kind}/"]`)) {
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
      const match = highlights.find(h => ruleMatchesEntity(h.filter, this.target, entity))
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
  protected override get target() { return 'work' as const }
  protected override get highlightClass() { return HIGHLIGHT_WORK_CLASS }

  static override async clean(): Promise<void> {
    await cleanHighlightClass(HIGHLIGHT_WORK_CLASS)
  }
}

export class HighlightSeries extends HighlightEntities {
  static override get name() { return 'HighlightSeries' }
  protected override get target() { return 'series' as const }
  protected override get highlightClass() { return HIGHLIGHT_SERIES_CLASS }

  static override async clean(): Promise<void> {
    await cleanHighlightClass(HIGHLIGHT_SERIES_CLASS)
  }
}
