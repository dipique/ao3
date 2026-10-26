import { isContextInvalidatedError, isExtensionContextValid, READ_RECORD_PREFIX, readRecordKey, recordedWorkIds } from '#common'
import { localGet, localRemove, localSet } from '#content_script/searchView/blurbStore.ts'

/**
 * Where the tracked lists' read records are kept: one `storage.local` key per
 * list ({@link readRecordKey}), so a page read rewrites one small value and not
 * every list's. What a record is and how one is read further is
 * {@link file://../../common/trackedReads.ts}; this is the half that touches
 * storage.
 *
 * **Import discipline.** Like the blurb store beside it, this imports nothing
 * from the host or the units, so the options page can read and write records.
 */

/** The records stored for these lists, by list id, as stored: `recordFor` reads them. Lists with none are left out. */
export async function readStoredRecords(listIds: readonly string[]): Promise<Map<string, unknown>> {
  if (!listIds.length)
    return new Map()
  const raw = await localGet(listIds.map(readRecordKey))
  const out = new Map<string, unknown>()
  for (const id of listIds) {
    const value = raw[readRecordKey(id)]
    if (value !== undefined)
      out.set(id, value)
  }
  return out
}

/** Write one list's record. */
export async function writeReadRecord(listId: string, record: unknown): Promise<void> {
  await localSet({ [readRecordKey(listId)]: record })
}

/** Write several lists' records at once. */
export async function writeReadRecords(records: ReadonlyMap<string, unknown>): Promise<void> {
  if (records.size)
    await localSet(Object.fromEntries([...records].map(([id, record]) => [readRecordKey(id), record])))
}

/** Forget these lists' records. */
export async function deleteReadRecords(listIds: readonly string[]): Promise<void> {
  await localRemove(listIds.map(readRecordKey))
}

/**
 * Every work id these lists' records hold, as decimal ids: works whose blurbs
 * the review will draw, and which the blurb store must count as referenced.
 */
export async function readRecordWorkIds(listIds: readonly string[]): Promise<Set<string>> {
  return recordedWorkIds((await readStoredRecords(listIds)).values())
}

/**
 * Hear every write to a record, from any page: the ids of the lists whose
 * records changed, with their new values (undefined for one removed). Returns
 * the way to stop.
 */
export function onReadRecordsChanged(listener: (changed: Map<string, unknown>) => void): () => void {
  const handle = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
    if (area !== 'local')
      return
    const changed = new Map<string, unknown>()
    for (const [key, change] of Object.entries(changes)) {
      if (key.startsWith(READ_RECORD_PREFIX))
        changed.set(key.slice(READ_RECORD_PREFIX.length), change.newValue)
    }
    if (changed.size)
      listener(changed)
  }
  // A page the extension was reloaded under has no storage to hear.
  if (!isExtensionContextValid())
    return () => {}
  try {
    browser.storage.onChanged.addListener(handle)
  }
  catch (error) {
    if (isContextInvalidatedError(error))
      return () => {}
    throw error
  }
  return () => {
    try {
      browser.storage.onChanged.removeListener(handle)
    }
    catch {}
  }
}
