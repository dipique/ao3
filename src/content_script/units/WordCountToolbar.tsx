import MdiArrowExpandHorizontal from '~icons/mdi/arrow-expand-horizontal.jsx'
import MdiCloseCircleOutline from '~icons/mdi/close-circle-outline.jsx'

import type { WordCountRange } from '#common'
import type { MenuItem } from '#content_script/contextMenu.js'

import { ADDON_CLASS, formatWordCountRange, isValidRange, sameRange } from '#common'
import { attachMenuTrigger, clearMenuTriggers } from '#content_script/contextTrigger.js'
import { findFacetBridge } from '#content_script/searchView/facetBridge.ts'
import { Unit } from '#content_script/Unit.js'
import { applyWordCountRange, getWordCountRange, hasWordCountFields } from '#content_script/wordCountFilter.js'
import React from '#dom'

/**
 * Turns the word count in a work's stats line into a length filter: click (or
 * right-click / long-press) it for a menu of the quick ranges from the options,
 * plus a row clearing whatever range is currently applied.
 *
 * Where the pick lands depends on where the blurb is. Inside one of our
 * in-memory search views it drives that view's own word-count filter (via
 * {@link findFacetBridge}); on a native listing it fills AO3's Word Count filter
 * and submits, so the results change straight away — the sidebar's own submit
 * button is a long scroll away from the stats line the reader just clicked.
 *
 * Both the "Words:" label and the number are wired, since either is a natural
 * thing to aim at.
 */
const WORD_COUNT_SELECTOR = '.blurb dl.stats dt.words, .blurb dl.stats dd.words'

/** Marks the decorated stats entries, so CSS can hint that they're clickable. */
const WORD_COUNT_CLASS = `${ADDON_CLASS}--word-count`

/** Where a picked range should be written, for one particular blurb. */
interface WordCountTarget {
  current: () => WordCountRange | null
  apply: (range: WordCountRange | null) => void
}

/**
 * Resolve the target for `el`: the search view containing it, else the page's
 * own word-count filter. Null when neither can filter by length (e.g. a listing
 * with no Sort & Filter sidebar), in which case no menu is attached at all.
 */
function targetFor(el: Element): WordCountTarget | null {
  const bridge = findFacetBridge(el)
  if (bridge) {
    return {
      current: () => bridge.getWordCount(),
      apply: range => bridge.setWordCount(range),
    }
  }
  if (hasWordCountFields()) {
    return {
      current: () => getWordCountRange(),
      apply: range => void applyWordCountRange(range),
    }
  }
  return null
}

/** Build the menu fresh at open time, so the "current range" rows are accurate. */
function buildWordCountMenu(target: WordCountTarget, ranges: WordCountRange[]): MenuItem[] {
  const items: MenuItem[] = []
  const current = target.current()

  if (current) {
    items.push({
      icon: () => <MdiCloseCircleOutline />,
      label: `Clear word count filter (${formatWordCountRange(current)})`,
      scope: 'search',
      onSelect: () => target.apply(null),
    })
  }

  for (const range of ranges) {
    // A range saved before a validation rule tightened (or hand-edited in
    // storage) would filter to nothing — leave it out rather than offer it.
    if (!isValidRange(range))
      continue
    const active = current !== null && sameRange(current, range)
    items.push({
      icon: () => <MdiArrowExpandHorizontal />,
      label: `${formatWordCountRange(range)} words`,
      scope: 'search',
      active,
      // Re-applying the range that's already on would just re-run the same
      // search, so the active row is inert.
      disabled: active,
      onSelect: () => target.apply(range),
    })
  }

  return items
}

export class WordCountToolbar extends Unit {
  static override get name() { return 'WordCountToolbar' }
  override get enabled() { return this.options.wordCountToolbar.enabled }

  static override async clean(): Promise<void> {
    clearMenuTriggers()
    for (const el of document.querySelectorAll(`.${WORD_COUNT_CLASS}`))
      el.classList.remove(WORD_COUNT_CLASS)
  }

  override async ready(): Promise<void> {
    const ranges = this.options.wordCountToolbar.ranges
    let count = 0

    for (const el of this.root.querySelectorAll<HTMLElement>(WORD_COUNT_SELECTOR)) {
      const target = targetFor(el)
      if (!target)
        continue
      // Unlike the tag/fandom links this isn't a link, so there's no navigation
      // to weigh against: a plain click always opens the menu (while the menus
      // are enabled at all).
      el.classList.add(WORD_COUNT_CLASS)
      attachMenuTrigger(el, () => buildWordCountMenu(target, ranges), { clickToOpen: true })
      count++
    }

    this.logger.debug(`Added word-count menus to ${count} stats entries.`)
  }
}
