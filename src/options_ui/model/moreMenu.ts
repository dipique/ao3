import type { CachingBuckets } from '../../content_script/siteExport/workText.ts'

import { sentence } from './phrases.ts'

/**
 * A stored list's More menu: what its offline copy offers beyond the buttons
 * beside it. A profile list's tile offers the list refreshed first, a retry of
 * the works that failed, a download without refreshing, and its removal. This
 * review offers only the two that work from what its window holds: no one
 * listing is behind it to refresh, and opening the review is what replaces it.
 */

/** What More can hold, in the order it holds them. */
export type MoreItemKind = 'refresh-first' | 'retry' | 'download-cached' | 'remove'

/**
 * What More offers for a copy: the works a retry asks for again, a cached one
 * whose refetch failed included; and the cached works, which a download
 * without refreshing packages. With none of either, that item isn't offered:
 * there is nothing to retry, and a download would hand over an empty site.
 */
export interface MoreCounts {
  retry: number
  cached: number
}

export function moreCounts(buckets: CachingBuckets): MoreCounts {
  return { retry: buckets.failed + buckets.staleFailures, cached: buckets.cached }
}

export interface MoreMenuInput extends MoreCounts {
  /** Whether the list is read from one listing, so can be refreshed before it is cached. */
  refresh: boolean
  /** Whether its copy can be removed from here. */
  remove: boolean
  /** Why what would start a job is off: another list's job. */
  off: string | null
}

export interface MoreItem {
  kind: MoreItemKind
  off: string | null
}

export interface MoreMenu {
  /** The trigger's tooltip: what the menu is for, whatever it holds now. */
  title: string
  items: MoreItem[]
}

/** The menu, or null with nothing in it to offer. Removing a copy starts no job, so another's never turns it off. */
export function moreMenu({ refresh, remove, retry, cached, off }: MoreMenuInput): MoreMenu | null {
  const items: MoreItem[] = []
  if (refresh)
    items.push({ kind: 'refresh-first', off })
  if (retry)
    items.push({ kind: 'retry', off })
  if (cached)
    items.push({ kind: 'download-cached', off })
  if (remove)
    items.push({ kind: 'remove', off: null })
  if (!items.length)
    return null

  const purposes = [refresh && 'refresh the list first', 'retry failed works', 'download without refreshing', remove && 'remove']
  return { title: sentence(purposes.filter(Boolean).join(', ')), items }
}
