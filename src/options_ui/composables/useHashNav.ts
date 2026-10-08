import type { Ref } from 'vue'

import { landingCategory } from '../model/rail.ts'
import { anchorCategory, resolveAnchor } from './useAnchors.ts'
import { useCurrentCategory } from './useCurrentCategory.ts'
import { useNav } from './useNav.ts'
import { useOptionSearch } from './useOptionSearch.ts'
import { holdForJump, jumpLanded } from './useSubsectionInView.ts'

/**
 * Deep links into the options page: `options_ui.html#search` opens on the Search
 * category, `#work-text` on that sub-section, `#work-text-reader-mode` on the
 * setting itself. A hash may equally name the thing the way the page spells it —
 * `#Search`, `#Work text` — see {@link file://./useAnchors.ts}. The rail's links
 * are hashes too, so picking a category there is a jump like any other.
 *
 * Getting there is more than a scroll, because a target can be out of sight two
 * ways: in a category the pane isn't showing, or filtered out by a running
 * settings search. Its category is made current, and the search is cleared only
 * when it is actually in the way, so following a rail link mid-search doesn't
 * throw the query away.
 */

/** Class that flashes the jumped-to element, so it's obvious what was landed on. */
const FLASH_CLASS = 'ao3e-jump-flash'
const FLASH_MS = 1600

/** Give up waiting for the page to stop moving. */
const SETTLE_BUDGET_MS = 1200

/** Frames the layout has to hold still for before it counts as settled. */
const STEADY_FRAMES = 6

/** The element's top in *document* space — unaffected by a scroll in flight. */
function documentTop(el: HTMLElement): number {
  return el.getBoundingClientRect().top + window.scrollY
}

/**
 * Wait until the target has stopped moving. Some of the page draws only once
 * its data has been read — the stored lists, the cache figures — and when that
 * lands above the target, the target slides down. Scrolling to where it was at
 * the start lands somewhere else entirely; scrolling repeatedly on the way
 * fights the scroll already in flight. So: watch the target's position in
 * document space (which a scroll doesn't change) along with the page's own
 * height, and go once both have held still.
 */
function whenSettled(el: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const deadline = performance.now() + SETTLE_BUDGET_MS
    let last = ''
    let steady = 0
    const check = (): void => {
      const now = `${documentTop(el)}:${document.documentElement.scrollHeight}`
      steady = now === last ? steady + 1 : 0
      last = now
      if (steady >= STEADY_FRAMES || performance.now() > deadline)
        resolve()
      else
        requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  })
}

function flash(el: HTMLElement): void {
  el.classList.remove(FLASH_CLASS)
  // Force a reflow, so re-adding the class restarts the animation when the same
  // target is jumped to twice.
  void el.offsetWidth
  el.classList.add(FLASH_CLASS)
  setTimeout(() => el.classList.remove(FLASH_CLASS), FLASH_MS)
}

/** Jump to whatever `hash` names, showing its category and unfiltering the way to it. */
export async function jumpToHash(hash: string): Promise<boolean> {
  const anchor = resolveAnchor(hash)
  if (!anchor)
    return false

  const { searching, rowMatches, categoryMatches, subsectionMatches, clear } = useOptionSearch()
  const survivesSearch = anchor.kind === 'category'
    ? categoryMatches(anchor.name)
    : anchor.kind === 'subsection'
      ? subsectionMatches(anchor.category, anchor.name)
      : rowMatches(anchor.id)
  if (searching.value && !survivesSearch)
    clear()

  const category = anchorCategory(hash)
  if (category)
    useCurrentCategory().show(category)

  await nextTick()

  const el = document.getElementById(anchor.id)
  if (!el)
    return false

  flash(el)
  await whenSettled(el)
  scrollToAnchor(el)
  return true
}

/**
 * Put `el` at the top of the window, clear of the sticky top bar.
 *
 * Deliberately `window.scrollTo` rather than `el.scrollIntoView`, which scrolls
 * every scrollable ancestor it has — and an `overflow: hidden` box is one, such
 * as what a switch reveals while it animates open — leaving content scrolled up
 * behind the clip. The offset is read back off the anchor's own
 * `scroll-margin-top`, so the sticky-header allowance stays stated once, in the
 * CSS.
 */
function scrollToAnchor(el: HTMLElement): void {
  const margin = Number.parseFloat(getComputedStyle(el).scrollMarginTop) || 0
  window.scrollTo({ top: Math.max(0, documentTop(el) - margin) })
}

/**
 * Show the category `hash` lands on, and jump to what it names. A hash that
 * names nothing, the empty one included, lands on the first category, so going
 * Back to the address the page opened with shows what the page opened on.
 * Settles once the jump has scrolled.
 */
async function followHash(hash: string): Promise<void> {
  const first = useNav().categories.value[0]?.id ?? ''
  useCurrentCategory().show(landingCategory(hash, anchorCategory, first))
  if (hash)
    await jumpToHash(hash)
}

/**
 * Follow the address bar: the hash the page was opened with, and every one it is
 * given afterwards (the rail sets them, and so can the reader, or Back).
 *
 * Once the page has opened on what its address names, the body's `data-landed`
 * names the hash it landed on. Each later jump takes it away until that jump
 * has landed in turn, or leaves it to a jump that overtook it: until then the
 * page may still scroll under whatever is pointing at it, which is what
 * anything driving the page waits out. The rail marks the sub-section a jump
 * goes to from when it begins (see {@link file://./useSubsectionInView.ts}).
 */
export function useHashNav(ready: Ref<boolean>): void {
  async function land(hash: string): Promise<void> {
    delete document.body.dataset.landed
    holdForJump(hash)
    await followHash(hash)
    if (location.hash !== hash)
      return
    jumpLanded()
    if (ready.value)
      document.body.dataset.landed = hash
  }

  useEventListener(window, 'hashchange', () => void land(location.hash))

  watch(ready, async (isReady) => {
    if (!isReady)
      return
    // The categories only render once the options have loaded, and they are what
    // register the categories and anchors this reads.
    await nextTick()
    await land(location.hash)
  }, { immediate: true })
}
