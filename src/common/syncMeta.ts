import type { BackupSummary } from './api.ts'
import type { PullLoss } from './syncGuard.ts'

import { createStorage } from './storage.ts'
import { SYNC_META_DEFAULTS } from './syncMetaDefaults.ts'

/**
 * Why this browser has stopped syncing, when it has. Unlike `lastError` (a push
 * or read that failed and will be retried), a pause lasts until something
 * changes: the reader answers, or the extension is updated.
 */
export type SyncPause
  /**
   * An incoming update would remove a large share of this browser's rules,
   * marked works or text replacements (see `syncGuard.ts`). `g`/`w` name the
   * copy being held, so the same copy isn't assessed (and backed up) again.
   */
  = | { reason: 'held', g: number, w: string, loss: PullLoss, at: number, backedUp: boolean }
  /**
   * The cloud copy was written at a higher sync version than this build speaks.
   * Lifts by itself once the extension is updated.
   */
    | { reason: 'newer-version', remoteVersion: number }
  /**
   * The cloud copy was written at a lower sync version, and this browser has
   * never synced — so it has nothing of its own to replace that copy with, and
   * waits for a browser that has. (One that has synced replaces it straight
   * away, and never pauses for this.)
   */
    | { reason: 'older-cloud', remoteVersion: number }

/**
 * Device-local sync/backup state and settings. Deliberately kept **out** of the
 * `options` store so it can never leak into the synced payload (and so toggling
 * sync on one device never propagates to others). Lives in `storage.local` under
 * the `sync.` prefix.
 *
 * The noisy engine-internal keys (`meta`, `dirty`, `dirtySince`, `deviceId`) are
 * in `ignoredEvents` so the options UI's listener only wakes for user-facing
 * fields (the enabled toggles, last-error, last-sync time, a pause).
 */
export interface SyncMeta {
  /** Master switch — does THIS device replicate options to `storage.sync`? */
  enabled: boolean
  /** Keep daily local backups of the options. */
  backupsEnabled: boolean
  /** How many daily backups to retain. */
  backupCount: number
  /**
   * Every stored backup, newest first, without its options. Kept so listing and
   * pruning backups never has to find them by reading all of `storage.local`,
   * which also holds cached work text and every stored blurb. `null` until the
   * first backup operation on a build that keeps it builds it.
   */
  backups: BackupSummary[] | null

  /** The sync generation/hash/writer-token this device's working copy agrees with. */
  meta: { g: number, h: string, w: string }
  /** A local option change is pending push. */
  dirty: boolean
  /** Epoch ms the current dirty streak started (for the max-wait push ceiling). */
  dirtySince: number
  /** Stable random id for this browser instance (writer-token component). */
  deviceId: string

  /** YYYY-MM-DD of the most recent daily backup — cheap daily-dedup without scanning storage. */
  lastBackupDate: string

  /** Why sync is paused on this browser, or `null` when it isn't. */
  pause: SyncPause | null
  /**
   * Set when the background found itself running a different build than the one
   * on disk (`build.json`), which Chrome can do for an unpacked extension for as
   * long as nobody reloads it. Nothing syncs while it's set: an old background
   * pushes only the options it knows, and whatever it doesn't know is what other
   * browsers stand to lose. Cleared by the first worker start that matches.
   */
  staleBuild: { running: string, onDisk: string } | null
  /** The on-disk build id the background last reloaded itself for, so it reloads once per build. */
  reloadAttemptedFor: string

  /** Last sync error message surfaced to the UI ('' when healthy). */
  lastError: string
  /** Epoch ms of the last successful push/pull. */
  lastSyncAt: number
}

export const syncMeta = createStorage<SyncMeta>({
  area: 'local',
  name: 'SyncMeta',
  prefix: 'sync.',
  ignoredEvents: ['meta', 'dirty', 'dirtySince', 'deviceId', 'lastBackupDate', 'backups', 'reloadAttemptedFor'],
  defaults: SYNC_META_DEFAULTS,
})

// eslint-disable-next-line ts/no-namespace, ts/no-redeclare
export namespace syncMeta {
  export type Id = keyof SyncMeta
}
