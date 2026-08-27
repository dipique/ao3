import type { WordCountRange } from '#common'

import type { FacetDir, FacetKey } from './engine.ts'

/**
 * Lets the shared context-menu decorators (e.g. the required-tags 2×2 square)
 * drive the *in-memory* search-view engine when they act on a blurb inside a
 * live search view, instead of the page's native filter sidebar.
 *
 * The search view registers a bridge for its results container; a decorator walks
 * up from the element it's acting on to find the nearest registered container. If
 * one is found the blurb lives in a search view and include/exclude should toggle
 * that view's facets; otherwise there is no bridge and the decorator falls back to
 * the native sidebar.
 *
 * Unlike the native sidebar the engine also understands `require` (AND within a
 * group), so a bridged decorator can offer all three directions — see
 * {@link file://../filterTarget.ts}, which is what the decorators actually call.
 */
export interface FacetBridge {
  isSelected: (key: FacetKey, dir: FacetDir, value: string) => boolean
  toggle: (key: FacetKey, dir: FacetDir, value: string) => void
  /** The view's current word-count bounds, or null when it isn't filtering by length. */
  getWordCount: () => WordCountRange | null
  /** Replace those bounds (null clears them) and re-run the filter. */
  setWordCount: (range: WordCountRange | null) => void
}

/** Results container → its bridge. At most a handful of entries (one per open view). */
const bridges = new Map<HTMLElement, FacetBridge>()

/**
 * Register `container`'s bridge; returns an unregister fn. First drops any
 * previously-registered container that has left the DOM, so a torn-down view
 * never leaves a stale bridge behind. The new container is registered *after*
 * that sweep, so it survives even though it's briefly detached while the view is
 * still being assembled (the decorators run before it's mounted).
 */
export function registerFacetBridge(container: HTMLElement, bridge: FacetBridge): () => void {
  for (const prev of bridges.keys()) {
    if (!prev.isConnected)
      bridges.delete(prev)
  }
  bridges.set(container, bridge)
  return () => {
    if (bridges.get(container) === bridge)
      bridges.delete(container)
  }
}

/**
 * Find the bridge for the search view containing `el`, or null if `el` isn't in
 * one. A plain `contains` match, so it works even while the container is detached
 * mid-assembly (its blurbs are still its descendants).
 */
export function findFacetBridge(el: Element | null): FacetBridge | null {
  if (!el)
    return null
  for (const [container, bridge] of bridges) {
    if (container.contains(el))
      return bridge
  }
  return null
}

// ---------------------------------------------------------------------------
// Change notification. The search view's own facet UI and the blurb decorators
// are two views of one filter, so whichever moves must tell the other: the
// sidebar mirror of `notifyFilterChange` in `filterSidebar.tsx`. Consumers
// normally subscribe through `onFilterTargetChange`, which covers both.
// ---------------------------------------------------------------------------

const changeListeners = new Set<() => void>()

export function onFacetChange(fn: () => void): void {
  changeListeners.add(fn)
}

export function notifyFacetChange(): void {
  for (const fn of changeListeners)
    fn()
}
