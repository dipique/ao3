import type { SyncMeta } from './syncMeta.ts'

/**
 * The device-local sync state a browser starts with. Kept out of `syncMeta.ts`
 * for the same reason the option defaults are kept out of `options.ts`: that
 * module builds its storage over `browser.storage` as soon as it loads, and the
 * sync tests need these under a plain `node --test`.
 */
export const SYNC_META_DEFAULTS: SyncMeta = {
  enabled: false,
  backupsEnabled: true,
  backupCount: 7,

  meta: { g: 0, h: '', w: '' },
  dirty: false,
  dirtySince: 0,
  deviceId: '',

  lastBackupDate: '',

  lastError: '',
  lastSyncAt: 0,
}
