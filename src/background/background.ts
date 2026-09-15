import { api, cache, logBanner, options, SYNC_SCHEMA_VERSION, syncMeta } from '#common'

import { listBackups, restoreBackup } from './backups.ts'
import { checkBuild } from './buildCheck.ts'
import {
  clearSyncedData,
  getSyncStatus,
  getSyncUsage,
  initSyncEngine,
  onAlarm,
  onStorageChanged,
  resolveHeldSync,
  resumeSync,
  setSyncEnabled,
} from './syncEngine.ts'

import './menus.ts'

logBanner()

// Is this worker the build on disk? Everything that syncs or migrates waits for
// the answer, and a stale worker reloads itself rather than doing either.
const current = checkBuild()

// --- Sync engine listeners ---
// Registered synchronously at the top level so an MV3 wake-up event (a remote
// sync change, or the debounce alarm) is never delivered before its handler is
// attached. The engine itself does nothing while a stale build is recorded.
browser.storage.onChanged.addListener(onStorageChanged)
browser.alarms.onAlarm.addListener(onAlarm)
browser.runtime.onStartup.addListener(async () => {
  if (await current)
    await initSyncEngine()
})
// Every worker start, not just browser start or install: a push left pending
// when the worker last stopped would otherwise wait for the next edit.
void current.then(async (isCurrent) => {
  if (isCurrent)
    await resumeSync()
})

browser.runtime.onInstalled.addListener(async () => {
  // Never migrate with code that isn't the code on disk.
  if (!(await current))
    return
  // Run migrations when we install or update extension
  await runMigrations()
  await initSyncEngine()
})

api.openOptionsPage.addListener(async () => {
  await browser.runtime.openOptionsPage()
})

api.runMigrations.addListener(async () => {
  if (await current)
    await runMigrations()
  browser.runtime.reload()
})

api.getBuildInfo.addListener(async () => ({ buildId: process.env.BUILD_ID, syncVersion: SYNC_SCHEMA_VERSION }))

// --- Sync + backups API ---
api.setSyncEnabled.addListener(async enabled => setSyncEnabled(enabled))
api.resolveHeldSync.addListener(async choice => ({ resolved: await resolveHeldSync(choice) }))
api.clearSyncedData.addListener(async () => {
  await clearSyncedData()
  return true
})
api.getSyncUsage.addListener(async () => getSyncUsage())
api.getSyncStatus.addListener(async () => getSyncStatus())
api.listBackups.addListener(async () => listBackups())
api.restoreBackup.addListener(async (key) => {
  await restoreBackup(key)
  return true
})

async function runMigrations() {
  await import('./migrations.ts').then(({ migrate }) => migrate())
}

if (process.env.NODE_ENV === 'development') {
  // Allow manual testing access to the option and cache object
  ;(globalThis as any).options = options
  ;(globalThis as any).cache = cache
  ;(globalThis as any).syncMeta = syncMeta
}
