import type { Work } from '#content_script/blurb.js'

/**
 * What a listing load can put on screen before it has every page: the pages
 * landed so far from page 1 on, and, for a refresh, those pages over the stored
 * copy they are on their way to replacing.
 *
 * Pure, so it loads under a plain `node --test`.
 */

/**
 * The pages from the first up to the first one not landed: a pool fetches pages
 * out of order, and a listing shown with a gap in it would put page 3's works
 * where page 2's belong.
 */
export function contiguousPrefix<T>(pages: readonly (T | undefined)[]): T[] {
  const prefix: T[] = []
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    if (page === undefined)
      break
    prefix.push(page)
  }
  return prefix
}

/**
 * A refresh part-way through: the works it has read so far, in listing order,
 * then every stored work it hasn't reached yet, in stored order. A work in both
 * is the fresh one, at its fresh place, and a work the listing moved from one
 * page to the next while it was read is listed once, where it was first seen.
 * A work with no id is never taken for another.
 */
export function mergeRefresh(fresh: readonly Work[], stored: readonly Work[]): Work[] {
  const seen = new Set<string>()
  const merged: Work[] = []
  for (const work of [...fresh, ...stored]) {
    if (work.workId) {
      if (seen.has(work.workId))
        continue
      seen.add(work.workId)
    }
    merged.push(work)
  }
  return merged
}
