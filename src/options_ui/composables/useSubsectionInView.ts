import type { Ref } from 'vue'

import type { JumpHold, SectionTop } from '../model/rail.ts'

import { markedSubsection, nextHold } from '../model/rail.ts'
import { resolveAnchor } from './useAnchors.ts'

/**
 * The sub-section the rail marks as the page scrolls. Which one that is, and
 * how a jump holds the mark, is {@link file://../model/rail.ts}; this reads
 * the page for it, at most once a frame, and only once something has moved:
 * the page scrolled or resized, a jump began, or the sub-sections changed.
 *
 * A jump holds the mark from the moment it begins, whatever starts it: the
 * hash changing (see {@link file://./useHashNav.ts}), and before that, a
 * rail link's click, which the browser follows with a scroll of its own.
 */

const hold = shallowRef<JumpHold | null>(null)

function page(): Element {
  return document.scrollingElement ?? document.documentElement
}

/** A jump to what `hash` names begins. */
export function holdForJump(hash: string): void {
  hold.value = nextHold(hold.value, { kind: 'jump', to: resolveAnchor(hash) })
}

/** The jump has landed: it scrolls the page no further. */
export function jumpLanded(): void {
  hold.value = nextHold(hold.value, { kind: 'landed', scrollTop: page().scrollTop })
}

/**
 * A rail link to `hash` was clicked. A click with a modifier key opens the
 * link elsewhere, and leaves this page where it is. A link to the hash the
 * page is on already changes no hash, so the browser's scroll to it is the
 * whole jump, and it has landed by the next frame.
 */
export function holdForLink(event: MouseEvent, hash: string): void {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
    return
  holdForJump(hash)
  if (location.hash === hash)
    requestAnimationFrame(jumpLanded)
}

/**
 * The id of the sub-section to mark, of those with these `ids` (the current
 * category's that the rail lists, in order), or null. None is marked while
 * `enabled` is off.
 */
export function useSubsectionInView(ids: Ref<readonly string[]>, enabled: Ref<boolean>): Readonly<Ref<string | null>> {
  const marked = ref<string | null>(null)
  let frame = 0
  let scrolled = false

  function read(): void {
    frame = 0
    const scroller = page()
    if (scrolled) {
      scrolled = false
      hold.value = nextHold(hold.value, { kind: 'scrolled', scrollTop: scroller.scrollTop })
    }
    if (!enabled.value) {
      marked.value = null
      return
    }
    const sections = ids.value
      .map(id => document.getElementById(id))
      .filter((el): el is HTMLElement => !!el?.getClientRects().length)
    const tops: SectionTop[] = sections.map(el => ({ id: el.id, top: el.getBoundingClientRect().top }))
    // Where a jump puts what it lands on: clear of the top bar, by the margin
    // the sections keep from it.
    const line = sections[0] ? Number.parseFloat(getComputedStyle(sections[0]).scrollMarginTop) || 0 : 0
    marked.value = markedSubsection(hold.value, tops, {
      line,
      scrollTop: scroller.scrollTop,
      height: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
    })
  }

  function schedule(): void {
    frame ||= requestAnimationFrame(read)
  }

  useEventListener(window, 'scroll', () => {
    scrolled = true
    schedule()
  }, { passive: true })
  useEventListener(window, 'resize', schedule, { passive: true })
  // The page grows and shrinks under a still window as its lists are read and
  // its rows reveal more.
  useResizeObserver(document.body, schedule)
  watch([ids, enabled, hold], schedule, { immediate: true })
  onScopeDispose(() => cancelAnimationFrame(frame))

  return readonly(marked)
}
