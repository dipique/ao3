import { cache, copyLabel, getArchiveLink, LIST_VERSION, options, planRecordMigration, READ_RECORD_PREFIX, readRecordKey } from '#common'

/**
 * The read records an older build kept for the tracked review, one per list,
 * are moved onto the lists' offline copies at start-up
 * ({@link planRecordMigration}), so the review goes on where it was, and
 * then removed. With the records gone, running it again finds nothing.
 */

/** The records stored: every one, where the browser can list its keys, else those of the lists named. */
async function recordKeys(listIds: readonly string[]): Promise<string[]> {
  const local = browser.storage.local as typeof browser.storage.local & { getKeys?: () => Promise<string[]> }
  if (typeof local.getKeys === 'function')
    return (await local.getKeys()).filter(key => key.startsWith(READ_RECORD_PREFIX))
  return listIds.map(readRecordKey)
}

/** At start: move the tracked lists' read records onto their copies, then remove them, and the review's old gathering claim. */
export async function migrateReadRecords(): Promise<void> {
  await browser.storage.local.remove('cache.trackedReviewClaim')
  const option = await options.get('trackedLists')
  const keys = await recordKeys(option.lists.map(list => list.id))
  if (!keys.length)
    return
  const raw = await browser.storage.local.get(keys)
  const records = new Map(Object.entries(raw).map(([key, value]) => [key.slice(READ_RECORD_PREFIX.length), value]))
  if (!records.size)
    return
  const stored = await cache.get('searchLists')
  // A tag's or a series' page lists its works where only the content script
  // knows to look, so a copy of one isn't made here: its list is read again by
  // date instead, which for a series is one read anyway.
  const plan = planRecordMigration(records, option.lists, stored, list => (list.kind === 'tag-works' || list.kind === 'series-works'
    ? null
    : { v: LIST_VERSION, scrapedAt: 0, ids: '', descriptor: { sourceId: list.kind, label: copyLabel(list), listUrl: getArchiveLink(list.url) } }))
  if (Object.keys(plan.writes).length)
    await cache.set({ searchLists: { ...stored, ...plan.writes } })
  await browser.storage.local.remove(plan.drop)
}
