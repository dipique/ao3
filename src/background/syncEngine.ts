import { createLogger, createSyncEngine, options, syncMeta } from '#common'

import { createBackup, maybeDailyBackup } from './backups.ts'

/**
 * The sync engine, wired to the real browser: `storage.local` options, the
 * `storage.sync` area, alarms and backups. The engine itself is
 * {@link file://./../common/syncCore.ts}, which takes all of those as arguments
 * so the sync tests can run it against simulated browsers.
 *
 * Listeners are registered synchronously at the top of `background.ts` so an MV3
 * wake-up event is never dropped; everything here is invoked from those.
 */
const engine = createSyncEngine({
  defaults: options.defaults,
  readOptions: () => options.get(),
  writeOptions: update => options.set(update),
  meta: {
    get: keys => syncMeta.get(keys),
    set: update => syncMeta.set(update),
  },
  sync: browser.storage.sync,
  alarms: browser.alarms,
  backups: {
    maybeDaily: maybeDailyBackup,
    create: createBackup,
  },
  logger: createLogger('Sync'),
})

export const onStorageChanged = engine.onStorageChanged
export const onAlarm = engine.onAlarm
export const resumeSync = engine.start
export const initSyncEngine = engine.init
export const setSyncEnabled = engine.setEnabled
export const resolveHeldSync = engine.resolveHeld
export const clearSyncedData = engine.clearSyncedData
export const getSyncUsage = engine.getUsage
export const getSyncStatus = engine.getStatus
