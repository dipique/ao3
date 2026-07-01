import type { FacetKey } from './engine.ts'

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
 */
export interface FacetBridge {
  isSelected: (key: FacetKey, dir: 'include' | 'exclude', value: string) => boolean
  toggle: (key: FacetKey, dir: 'include' | 'exclude', value: string) => void
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
