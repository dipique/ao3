import type { WorkTextIndex } from './workText.ts'

import { cachedWorkIds, WORK_TEXT_INDEX_KEY } from './workText.ts'
import { readWorkTextIndex } from './workTextCache.ts'

/**
 * The works whose text is cached, for this page run: read once, then kept in
 * step with every caching run's writes to the index, from this page or another.
 */
let loaded: Set<string> | null = null

function onStorageChange(changes: Record<string, { newValue?: unknown }>, area: string): void {
  const change = changes[WORK_TEXT_INDEX_KEY]
  if (area !== 'local' || !change || !loaded)
    return
  const next = cachedWorkIds((change.newValue ?? {}) as WorkTextIndex)
  // In place: the set is handed out ({@link cachedTextIds}) and read live.
  loaded.clear()
  for (const id of next)
    loaded.add(id)
}

/** The cached works' ids, read once per page run and shared from then on. */
export async function loadCachedTextIds(): Promise<ReadonlySet<string>> {
  if (!loaded) {
    const ids = new Set(cachedWorkIds(await readWorkTextIndex()))
    if (!loaded) {
      loaded = ids
      browser.storage.onChanged.addListener(onStorageChange)
    }
  }
  return loaded
}

/**
 * The ids read this run, without a storage round-trip — or null when nothing
 * has loaded them yet, which is not the same as "no work is cached".
 */
export function cachedTextIds(): ReadonlySet<string> | null {
  return loaded
}
