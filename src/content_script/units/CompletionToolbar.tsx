import MdiCheckCircleOutline from '~icons/mdi/check-circle-outline.jsx'
import MdiCloseCircleOutline from '~icons/mdi/close-circle-outline.jsx'
import MdiProgressClock from '~icons/mdi/progress-clock.jsx'

import type { Completion } from '#content_script/completionFilter.js'
import type { MenuItem } from '#content_script/contextMenu.js'

import { ADDON_CLASS } from '#common'
import { getCompletion, hasCompletionFields, setCompletion } from '#content_script/completionFilter.js'
import { attachMenuTrigger, clearMenuTriggers } from '#content_script/contextTrigger.js'
import { searchFilterChanged } from '#content_script/pendingSearch.js'
import { findFacetBridge } from '#content_script/searchView/facetBridge.ts'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

/**
 * Turns the chapter count in a work's stats line into a completion filter:
 * click (or right-click / long-press) the chapter total — the `5` of `1/5`, the
 * `?` of `1/?` — or the "Chapters:" label above it for a menu offering completed
 * works only or incomplete works only, plus a row clearing whichever is on.
 *
 * Where the pick lands follows {@link file://./WordCountToolbar.tsx}: inside one
 * of our in-memory search views it drives that view's Completion Status facet
 * (via {@link findFacetBridge}), filtering at once; on a native listing it ticks
 * AO3's own Completion Status radio and stops there, leaving the search to the
 * reader (the pending-search prompt offers to run it, see
 * {@link searchFilterChanged}).
 *
 * The left number is left alone: on a multi-chapter work it's AO3's link to the
 * latest chapter, and a menu there would take the link away. The total sits in
 * a bare text node after it, so it's wrapped in a span of our own to have
 * something to hang the menu on.
 */
const LABEL_SELECTOR = '.blurb dl.stats dt.chapters'
const COUNT_SELECTOR = '.blurb dl.stats dd.chapters'

/**
 * Marks the decorated stats entries, so CSS can hint that they're clickable.
 * Also the class of the span wrapping the chapter total, which is how
 * {@link CompletionToolbar.clean} (and the blurb store's `pristineBlurb`) find
 * it to unwrap.
 */
const COMPLETION_CLASS = `${ADDON_CLASS}--completion`

/** Where a picked choice should be written, for one particular blurb. */
interface CompletionTarget {
  current: () => Completion | null
  apply: (completion: Completion | null) => void
}

/** The two picks, in menu order. */
const CHOICES: Record<Completion, { label: string, icon: () => Node }> = {
  complete: { label: 'Completed works only', icon: () => <MdiCheckCircleOutline /> },
  incomplete: { label: 'Incomplete works only', icon: () => <MdiProgressClock /> },
}

/**
 * Resolve the target for `el`: the search view containing it, else the page's
 * own completion filter. Null when neither can filter by completion (e.g. a
 * listing with no Sort & Filter sidebar), in which case no menu is attached.
 */
function targetFor(el: Element): CompletionTarget | null {
  const bridge = findFacetBridge(el)
  if (bridge) {
    return {
      current: () => bridge.getCompletion(),
      apply: completion => bridge.setCompletion(completion),
    }
  }
  if (hasCompletionFields()) {
    return {
      current: () => getCompletion(),
      apply: (completion) => {
        if (!setCompletion(completion))
          return
        searchFilterChanged(completion
          ? `Completion filter set to ${CHOICES[completion].label.toLowerCase()}.`
          : 'Completion filter cleared.')
      },
    }
  }
  return null
}

/** Build the menu fresh at open time, so the "current choice" rows are accurate. */
function buildCompletionMenu(target: CompletionTarget): MenuItem[] {
  const current = target.current()
  const items: MenuItem[] = []

  if (current) {
    items.push({
      icon: () => <MdiCloseCircleOutline />,
      label: `Clear completion filter (${CHOICES[current].label.toLowerCase()})`,
      scope: 'search',
      onSelect: () => target.apply(null),
    })
  }

  for (const completion of Object.keys(CHOICES) as Completion[]) {
    const { label, icon } = CHOICES[completion]
    const active = current === completion
    items.push({
      icon,
      label,
      scope: 'search',
      active,
      // Re-applying the choice that's already on would just re-run the same
      // search, so the active row is inert.
      disabled: active,
      onSelect: () => target.apply(completion),
    })
  }

  return items
}

/**
 * The span around a `dd.chapters` cell's total, wrapping it first if this is
 * the cell's first visit. Null when the cell has no total to wrap.
 *
 *     <dd class="chapters"><a href="…">9</a>/23</dd>   →   …/<span>23</span>
 *     <dd class="chapters">1/?</dd>                    →   1/<span>?</span>
 *
 * Only the cell's own text nodes are searched, so the chapter link is never
 * split. A search view re-runs this over blurbs it already decorated, so an
 * existing span is reused rather than wrapped again.
 */
function chapterTotal(dd: HTMLElement): HTMLElement | null {
  const existing = dd.querySelector<HTMLElement>(`:scope > .${COMPLETION_CLASS}`)
  if (existing)
    return existing

  const text = [...dd.childNodes].findLast(
    (node): node is Text => node instanceof Text && node.data.includes('/'),
  )
  if (!text)
    return null
  const slash = text.data.lastIndexOf('/')
  const total = text.data.slice(slash + 1).trim()
  if (!total)
    return null

  // Keep any whitespace AO3 left around the total outside the span, so the
  // underline covers the number alone.
  const after = text.data.slice(slash + 1)
  const lead = after.slice(0, after.indexOf(total))
  const trail = after.slice(lead.length + total.length)
  text.data = text.data.slice(0, slash + 1) + lead
  const span = <span class={COMPLETION_CLASS}>{total}</span>
  text.after(span, ...(trail ? [trail] : []))
  return span
}

export class CompletionToolbar extends Unit {
  static override get name() { return 'CompletionToolbar' }
  override get enabled() { return this.options.completionToolbar }

  static override async clean(): Promise<void> {
    clearMenuTriggers()
    for (const el of document.querySelectorAll(`.${COMPLETION_CLASS}`)) {
      if (el.tagName === 'SPAN') {
        const parent = el.parentNode
        el.replaceWith(...el.childNodes)
        parent?.normalize()
      }
      else {
        el.classList.remove(COMPLETION_CLASS)
      }
    }
  }

  override async ready(): Promise<void> {
    let count = 0

    const attach = (el: HTMLElement, target: CompletionTarget): void => {
      el.classList.add(COMPLETION_CLASS)
      // Not a link, so a plain click always opens the menu (while the menus
      // are enabled at all), as on the word count.
      attachMenuTrigger(el, () => buildCompletionMenu(target), { clickToOpen: true })
      count++
    }

    for (const dd of this.root.querySelectorAll<HTMLElement>(COUNT_SELECTOR)) {
      const target = targetFor(dd)
      if (!target)
        continue
      const total = chapterTotal(dd)
      if (total)
        attach(total, target)
    }

    for (const dt of this.root.querySelectorAll<HTMLElement>(LABEL_SELECTOR)) {
      const target = targetFor(dt)
      if (target)
        attach(dt, target)
    }

    this.logger.debug(`Added completion menus to ${count} stats entries.`)
  }
}
