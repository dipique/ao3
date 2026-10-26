import type { TrackedListsOption } from '#common'

import { cache, createLogger, options, packIds, READ_RECORD_PREFIX, readRecordKey, recordedWorkIds, strayRecordKeys, unpackIds } from '#common'

const logger = createLogger('TrackedRecords')

/**
 * The tracked lists' read records outlive nothing they belong to: a list no
 * longer tracked has its record dropped, and the works it held are retired the
 * way a reviewed window's are — queued in the stored review's `retired`, which
 * the review discards on its next write, sparing any work another list or
 * record holds, that carries a mark, or that is saved for later.
 */

/** Drop these records, and retire the works they held. */
async function dropRecords(keys: readonly string[]): Promise<void> {
  if (!keys.length)
    return
  const stored = await browser.storage.local.get([...keys])
  const ids = recordedWorkIds(Object.values(stored))
  await browser.storage.local.remove([...keys])
  if (!ids.size)
    return
  const review = await cache.get('trackedReview')
  const retired = unpackIds(review.retired)
  for (const id of ids)
    retired.add(id)
  await cache.set({ trackedReview: { ...review, retired: packIds(retired) } })
}

/** The ids of the lists `option` tracks. */
function trackedIds(option: Partial<TrackedListsOption> | undefined): string[] {
  return (option?.lists ?? []).filter(list => list.tracked).map(list => list.id)
}

/**
 * At start: drop every record whose list isn't tracked any more, and the
 * review's old gathering claim, which nothing reads.
 *
 * Finding the records means listing the store's keys. A browser that can list
 * them without their values does; one that can't is left to the watch below,
 * rather than read every value in storage at every start.
 */
export async function cleanReadRecords(): Promise<void> {
  await browser.storage.local.remove('cache.trackedReviewClaim')
  const local = browser.storage.local as typeof browser.storage.local & { getKeys?: () => Promise<string[]> }
  if (typeof local.getKeys !== 'function')
    return
  const keys = (await local.getKeys()).filter(key => key.startsWith(READ_RECORD_PREFIX))
  await dropRecords(strayRecordKeys(keys, trackedIds(await options.get('trackedLists'))))
}

/**
 * Drop a list's record when it stops being tracked — untracked or deleted,
 * from whichever page did it, or by a sync — once `ready` says this
 * background is the build on disk.
 *
 * Which lists were tracked before comes from the change, or failing that from
 * what this background last saw.
 */
export function watchReadRecords(ready: Promise<boolean>): void {
  let known: Set<string> | null = null
  void ready.then(async (isCurrent) => {
    if (isCurrent)
      known ??= new Set(trackedIds(await options.get('trackedLists')))
  }).catch(error => logger.error('Could not read the tracked lists.', error))

  browser.storage.onChanged.addListener((changes, areaName) => {
    const change = changes['option.trackedLists']
    if (areaName !== 'local' || !change)
      return
    const before = change.oldValue ? new Set(trackedIds(change.oldValue as TrackedListsOption)) : known
    const after = new Set(trackedIds(change.newValue as TrackedListsOption | undefined))
    known = after
    if (!before)
      return
    const gone = [...before].filter(id => !after.has(id)).map(readRecordKey)
    void ready
      .then(isCurrent => (isCurrent ? dropRecords(gone) : undefined))
      .catch(error => logger.error('Could not drop the records of lists no longer tracked.', error))
  })
}
