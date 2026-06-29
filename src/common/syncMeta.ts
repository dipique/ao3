import { createStorage } from './storage.ts'

/**
 * Device-local sync/backup state and settings. Deliberately kept **out** of the
 * `options` store so it can never leak into the synced payload (and so toggling
 * sync on one device never propagates to others). Lives in `storage.local` under
 * the `sync.` prefix.
 *
 * The noisy engine-internal keys (`meta`, `dirty`, `dirtySince`, `deviceId`) are
 * in `ignoredEvents` so the options UI's listener only wakes for user-facing
 * fields (the enabled toggles, last-error, last-sync time).
 */
export interface SyncMeta {
  /** Master switch — does THIS device replicate options to `storage.sync`? */
  enabled: boolean
  /** Keep daily local backups of the options. */
  backupsEnabled: boolean
  /** How many backups to retain. */
  backupCount: number

  /** The sync generation/hash/writer-token this device's working copy agrees with. */
  meta: { g: number, h: string, w: string }
  /** A local option change is pending push. */
  dirty: boolean
  /** Epoch ms the current dirty streak started (for the max-wait push ceiling). */
  dirtySince: number
  /** Stable random id for this browser instance (writer-token component). */
  deviceId: string

  /** YYYY-MM-DD of the most recent backup — cheap daily-dedup without scanning storage. */
  lastBackupDate: string

  /** Last sync error message surfaced to the UI ('' when healthy). */
  lastError: string
  /** Epoch ms of the last successful push/pull. */
  lastSyncAt: number
}

export const syncMeta = createStorage<SyncMeta>({
  area: 'local',
  name: 'SyncMeta',
  prefix: 'sync.',
  ignoredEvents: ['meta', 'dirty', 'dirtySince', 'deviceId', 'lastBackupDate'],
  defaults: {
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
  },
})

// eslint-disable-next-line ts/no-namespace, ts/no-redeclare
export namespace syncMeta {
  export type Id = keyof SyncMeta
}
