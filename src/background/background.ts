import { api, cache, options, syncMeta } from '#common'

import { listBackups, restoreBackup } from './backups.ts'
import {
  clearSyncedData,
  getSyncStatus,
  getSyncUsage,
  initSyncEngine,
  onAlarm,
  onStorageChanged,
  setSyncEnabled,
} from './syncEngine.ts'

import './menus.ts'

// --- Sync engine listeners ---
// Registered synchronously at the top level so an MV3 wake-up event (a remote
// sync change, or the debounce alarm) is never delivered before its handler is
// attached.
browser.storage.onChanged.addListener(onStorageChanged)
browser.alarms.onAlarm.addListener(onAlarm)
browser.runtime.onStartup.addListener(() => void initSyncEngine())

browser.runtime.onInstalled.addListener(async () => {
  // Run migrations when we install or update extension
  await runMigrations()
  await initSyncEngine()
})

api.openOptionsPage.addListener(async () => {
  await browser.runtime.openOptionsPage()
})

api.runMigrations.addListener(async () => {
  await runMigrations()
  browser.runtime.reload()
})

// --- Sync + backups API ---
api.setSyncEnabled.addListener(async (enabled) => {
  await setSyncEnabled(enabled)
  return true
})
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
