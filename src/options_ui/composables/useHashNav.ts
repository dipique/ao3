import type { Ref } from 'vue'

import { resolveAnchor } from './useAnchors.ts'
import { expandCategory, expandSubsection } from './useCategoryCollapse.ts'
import { useOptionSearch } from './useOptionSearch.ts'

/**
 * Deep links into the options page: `options_ui.html#search` opens on the Search
 * category, `#work-text` on that sub-section, `#work-text-reader-mode` on the
 * setting itself. A hash may equally name the thing the way the page spells it —
 * `#Search`, `#Work text` — see {@link file://./useAnchors.ts}.
 *
 * Getting there is more than a scroll, because a target can be out of sight two
 * ways: folded away inside a collapsed category or sub-section, or filtered out
 * by a running settings search. Both are undone first — but the search only when
 * it is actually in the way, so following a header nav link mid-search doesn't
 * throw the query away.
 */

/** Class that flashes the jumped-to element, so it's obvious what was landed on. */
const FLASH_CLASS = 'ao3e-jump-flash'
const FLASH_MS = 1600

/** Give up waiting for the target to appear, and for the page to stop moving. */
const PRESENT_BUDGET_MS = 800
const SETTLE_BUDGET_MS = 1200

/**
 * Frames the layout has to hold still for before it counts as settled — enough
 * to sit out the gap between a section being told to open and its animation
 * actually starting, which two frames were not.
 */
const STEADY_FRAMES = 6

/** The element's top in *document* space — unaffected by a scroll in flight. */
function documentTop(el: HTMLElement): number {
  return el.getBoundingClientRect().top + window.scrollY
}

/**
 * Wait for the target to be in the document. Unfolding a section doesn't put its
 * contents back on the next tick: the collapsible measures the content to
 * animate to its height, which takes it a frame or two, so a jump into a folded
 * category asked for the element before there was one.
 */
function whenPresent(id: string): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const deadline = performance.now() + PRESENT_BUDGET_MS
    const check = (): void => {
      const el = document.getElementById(id)
      if (el)
        resolve(el)
      else if (performance.now() > deadline)
        resolve(null)
      else
        requestAnimationFrame(check)
    }
    check()
  })
}

/**
 * Wait until the target has stopped moving. A section that was just unfolded
 * grows for the length of the collapsible animation, and everything below it —
 * very often the target — slides down as it does. Scrolling to where it was at
 * the start of that lands somewhere else entirely; scrolling repeatedly on the
 * way fights the scroll already in flight. So: watch the target's position in
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

/** Jump to whatever `hash` names, unfolding and unfiltering the way to it. */
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

  if (anchor.category)
    expandCategory(anchor.category)
  if (anchor.subsection)
    expandSubsection(anchor.category, anchor.subsection)

  await nextTick()

  const el = await whenPresent(anchor.id)
  if (!el)
    return false

  // Marked first, so an unfold the reader is watching already says where it is
  // heading before the scroll starts.
  flash(el)
  await whenSettled(el)
  scrollToAnchor(el)
  return true
}

/**
 * Put `el` at the top of the window, clear of the sticky header and toolbar.
 *
 * Deliberately `window.scrollTo` rather than `el.scrollIntoView`, which scrolls
 * every scrollable ancestor it has — and each collapsible section is one, since the
 * fold animation needs `overflow-y: hidden`. Landing inside a section that was
 * mid-unfold had it scroll its own content up behind the clip and leave it
 * there. The offset is read back off the anchor's own `scroll-margin-top`, so
 * the sticky-header allowance stays stated once, in the CSS.
 */
function scrollToAnchor(el: HTMLElement): void {
  const margin = Number.parseFloat(getComputedStyle(el).scrollMarginTop) || 0
  window.scrollTo({ top: Math.max(0, documentTop(el) - margin) })
}

/**
 * Follow the address bar: the hash the page was opened with, and every one it is
 * given afterwards (the header nav sets them, and so can the reader).
 */
export function useHashNav(ready: Ref<boolean>): void {
  useEventListener(window, 'hashchange', () => void jumpToHash(location.hash))

  watch(ready, async (isReady) => {
    if (!isReady || !location.hash)
      return
    // The categories only render once the options have loaded, and they are what
    // register the anchors this reads.
    await nextTick()
    void jumpToHash(location.hash)
  }, { immediate: true })
}
