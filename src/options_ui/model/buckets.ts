import type { CachingBuckets } from '../../content_script/siteExport/workText.ts'

/**
 * A list's caching figures as the page draws them: a bar of what is cached
 * and what failed against the whole list, and the figures beside it. Every
 * work is in exactly one bucket, so the bar's parts never overlap.
 */

/** Bytes at a readable scale — the cache runs to tens of megabytes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`
  const units = ['kB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

export interface BucketBar {
  /** How much of the bar the cached works take, in percent. A cached work whose refetch failed is cached: its text is here. */
  cached: number
  /** How much of it the failed works take, after the cached ones. The rest is the new works. */
  failed: number
  /** Its accessible name: "205 of 240 works cached, 6 failed, 29 new". */
  label: string
  /** Its tooltip, one bucket a line. */
  tip: string
}

export function bucketBar({ total, cached, failed, unfetched }: CachingBuckets): BucketBar {
  const share = (n: number): number => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0)
  const n = (count: number): string => count.toLocaleString()
  return {
    cached: share(cached),
    failed: share(failed),
    label: `${n(cached)} of ${n(total)} ${total === 1 ? 'work' : 'works'} cached, ${n(failed)} failed, ${n(unfetched)} new`,
    tip: [`cached: ${n(cached)}`, `failed: ${n(failed)}`, `new: ${n(unfetched)}`, `total: ${n(total)}`].join('\n'),
  }
}

/** The figures beside the bar: what is cached and its size, and what isn't, with the failures among it. */
export interface BucketFigures {
  cached: string
  size: string
  /** Null with everything cached. */
  uncached: string | null
  /** Null with nothing failed. */
  failed: string | null
}

export function bucketFigures({ cached, failed, unfetched, bytes }: CachingBuckets): BucketFigures {
  const uncached = failed + unfetched
  return {
    cached: cached.toLocaleString(),
    size: formatBytes(bytes),
    uncached: uncached ? uncached.toLocaleString() : null,
    failed: failed ? failed.toLocaleString() : null,
  }
}
