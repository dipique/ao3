import type { BackupKind, BackupSummary } from './api.ts'
import type { Options } from './options.ts'
import type { SyncMeta } from './syncMeta.ts'

import { BACKUP_KIND_LABELS, BACKUP_PREFIX, freeBackupTime, newestOfKind, planBackupPrune, sortBackups } from './backupIndex.ts'
import { canonicalStringify } from './syncCodec.ts'

/** Backups live in `storage.local`, one key per backup (`backup.<createdAt>`). */
export interface Backup {
  /** epoch ms */
  createdAt: number
  /** YYYY-MM-DD in the device's local time — the daily-dedup key */
  date: string
  kind: BackupKind
  /** human-friendly label */
  label: string
  /** full options snapshot (every `option.*` key) */
  options: Partial<Options>
}

/** The subset of a `storage.local` area backups use. */
export interface BackupStorageArea {
  get: (keys: string[] | null) => Promise<Record<string, unknown>>
  set: (items: Record<string, unknown>) => Promise<void>
  remove: (keys: string[]) => Promise<void>
  /** Lists names without values, where the browser has it. */
  getKeys?: () => Promise<string[]>
}

export interface BackupDeps {
  local: BackupStorageArea
  meta: {
    get: <K extends keyof SyncMeta>(keys: K[]) => Promise<Pick<SyncMeta, K>>
    set: (update: Partial<SyncMeta>) => Promise<void>
  }
  /** Every option as it is stored now, as plain data. */
  readOptions: () => Promise<Partial<Options>>
  writeOptions: (update: Partial<Options>) => Promise<void>
  now?: () => number
  logger?: { log: (...args: unknown[]) => void }
}

/**
 * Backups of the options, kept in `storage.local` and indexed in
 * `syncMeta.backups`. The background wires in the real storage
 * ({@link file://./../background/backups.ts}); the sync tests wire in a fake
 * one per simulated browser, so a scenario runs the backups it ships with.
 */
export function createBackupStore(deps: BackupDeps) {
  const { local, meta } = deps
  const now = deps.now ?? Date.now
  const logger = deps.logger ?? { log() {} }

  // Every change to the index is a read-modify-write of one value, and backups
  // are taken from the sync engine and from the options page alike — so one at
  // a time.
  let chain: Promise<unknown> = Promise.resolve()
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn)
    chain = run.then(() => {}, () => {})
    return run
  }

  /**
   * The backup index, built the first time it's needed.
   *
   * Only that first build has to find the backups by listing storage, since the
   * keys alone don't say which are backups. `getKeys` lists names without values;
   * where the browser doesn't have it, one full read is the price, paid once.
   */
  async function readIndex(): Promise<BackupSummary[]> {
    const { backups: stored } = await meta.get(['backups'])
    if (stored)
      return stored

    const keys = typeof local.getKeys === 'function'
      ? await local.getKeys()
      : Object.keys(await local.get(null))
    const backupKeys = keys.filter(key => key.startsWith(BACKUP_PREFIX))
    const found = backupKeys.length ? await local.get(backupKeys) : {}
    const index = sortBackups(Object.entries(found).map(([key, backup]) => summarize(key, backup as Backup)))
    await meta.set({ backups: index })
    logger.log('Indexed backups', index.length)
    return index
  }

  /**
   * Snapshot options under a fresh key, then prune. `snapshot` defaults to the
   * current options; pass one to keep something that isn't in them — the incoming
   * copy of a sync update the reader declined, say.
   *
   * An event backup that would hold just what the newest of its kind holds
   * isn't written, and resolves as one that was: that backup already keeps
   * those options, and a run of repeats would push out the older ones its kind
   * keeps. A daily backup is always written, as its day's restore point.
   */
  function create(kind: BackupKind, snapshot?: Partial<Options>): Promise<void> {
    return serialized(async () => {
      const index = await readIndex()
      const options = snapshot ?? await deps.readOptions()
      if (kind !== 'daily' && await repeatsNewest(index, kind, options)) {
        logger.log('Backup not taken: the newest of its kind holds the same', kind)
        return
      }
      const createdAt = freeBackupTime(index, now())
      const backup: Backup = { createdAt, date: localDate(createdAt), kind, label: BACKUP_KIND_LABELS[kind], options }
      const key = `${BACKUP_PREFIX}${createdAt}`
      await local.set({ [key]: backup })

      const { backupCount } = await meta.get(['backupCount'])
      const { keep, remove } = planBackupPrune([summarize(key, backup), ...index], backupCount)
      if (remove.length)
        await local.remove(remove)
      // Only a daily backup answers "has today been backed up?": an event backup
      // is kept to a different count and says nothing about the day's changes.
      await meta.set(kind === 'daily' ? { backups: keep, lastBackupDate: backup.date } : { backups: keep })
      logger.log('Created backup', kind)
    })
  }

  /** Compared canonically: the order of an object's keys is no difference. */
  async function repeatsNewest(index: readonly BackupSummary[], kind: BackupKind, options: Partial<Options>): Promise<boolean> {
    const newest = newestOfKind(index, kind)
    if (!newest)
      return false
    const stored = (await local.get([newest.key]))[newest.key] as Backup | undefined
    return !!stored && canonicalStringify(stored.options) === canonicalStringify(options)
  }

  /**
   * Create a backup only if today has none yet. Called on the first option change
   * of the day (whether a local edit or an incoming sync pull), so each day keeps a
   * single restore point capturing the state before that day's changes.
   */
  async function maybeDaily(): Promise<void> {
    // Cheap checks against the switch and the tracked date, so the hot path
    // (every option change) never has to read the index, let alone storage.
    const { backupsEnabled, lastBackupDate } = await meta.get(['backupsEnabled', 'lastBackupDate'])
    if (!backupsEnabled || lastBackupDate === localDate(now()))
      return
    await create('daily')
  }

  function list(): Promise<BackupSummary[]> {
    return serialized(async () => sortBackups(await readIndex()))
  }

  /**
   * Restore a backup. First snapshots the current state (so a restore is itself
   * undoable), then writes the backed-up options — which the sync engine
   * observes and replicates if sync is on.
   */
  async function restore(key: string): Promise<void> {
    const stored = (await local.get([key]))[key] as Backup | undefined
    if (!stored) {
      // The index outlived the backup (storage cleared, or removed by hand).
      await serialized(async () => {
        const index = await readIndex()
        await meta.set({ backups: index.filter(backup => backup.key !== key) })
      })
      throw new Error(`Backup not found: ${key}`)
    }

    await create('pre-restore')
    await deps.writeOptions(stored.options)
    logger.log('Restored backup', key)
  }

  return { create, maybeDaily, list, restore }
}

export type BackupStore = ReturnType<typeof createBackupStore>

function summarize(key: string, backup: Backup): BackupSummary {
  return { key, createdAt: backup.createdAt, date: backup.date, kind: backup.kind, label: backup.label }
}

function localDate(ts: number): string {
  const d = new Date(ts)
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mo}-${da}`
}
