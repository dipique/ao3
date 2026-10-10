import type { BackupKind, Options } from '#common'

import { createBackupStore, createLogger, deepToRaw, options, syncMeta } from '#common'

/**
 * Backups, wired to the real browser: `storage.local`, the sync state and the
 * options. The store itself is {@link file://./../common/backupStore.ts}, which
 * takes all of those as arguments so the sync tests can run it too.
 */
const store = createBackupStore({
  local: browser.storage.local,
  meta: {
    get: keys => syncMeta.get(keys),
    set: update => syncMeta.set(update),
  },
  readOptions: async () => deepToRaw(await options.get()),
  writeOptions: update => options.set(update),
  logger: createLogger('Backups'),
})

export function createBackup(kind: BackupKind, snapshot?: Partial<Options>): Promise<void> {
  return store.create(kind, snapshot && deepToRaw(snapshot))
}

export const maybeDailyBackup = store.maybeDaily
export const listBackups = store.list
export const restoreBackup = store.restore
