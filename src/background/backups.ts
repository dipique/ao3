import type { BackupKind, BackupSummary, Options } from '#common'

import { BACKUP_KIND_LABELS, BACKUP_PREFIX, createLogger, deepToRaw, freeBackupTime, options, planBackupPrune, sortBackups, syncMeta } from '#common'

const logger = createLogger('Backups')

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

function localDate(ts: number): string {
  const d = new Date(ts)
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mo}-${da}`
}

function summarize(key: string, backup: Backup): BackupSummary {
  return { key, createdAt: backup.createdAt, date: backup.date, kind: backup.kind, label: backup.label }
}

// Every change to the index is a read-modify-write of one value, and backups are
// taken from the sync engine and from the options page alike — so one at a time.
let chain: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.then(() => {}, () => {})
  return run
}

/**
 * The backup index (`syncMeta.backups`), built the first time it's needed.
 *
 * Only that first build has to find the backups by listing storage, since the
 * keys alone don't say which are backups. `getKeys` lists names without values;
 * where the browser doesn't have it, one full read is the price, paid once.
 */
async function readIndex(): Promise<BackupSummary[]> {
  const stored = await syncMeta.get('backups')
  if (stored)
    return stored

  const local = browser.storage.local
  const keys = typeof local.getKeys === 'function'
    ? await local.getKeys()
    : Object.keys(await local.get(null))
  const backupKeys = keys.filter(key => key.startsWith(BACKUP_PREFIX))
  const found = backupKeys.length ? await local.get(backupKeys) : {}
  const index = sortBackups(Object.entries(found).map(([key, backup]) => summarize(key, backup as Backup)))
  await syncMeta.set({ backups: index })
  logger.log('Indexed backups', index.length)
  return index
}

/**
 * Snapshot options under a fresh key, then prune. `snapshot` defaults to the
 * current options; pass one to keep something that isn't in them — the incoming
 * copy of a sync update the reader declined, say.
 */
export function createBackup(kind: BackupKind, snapshot?: Partial<Options>): Promise<void> {
  return serialized(async () => {
    const index = await readIndex()
    const createdAt = freeBackupTime(index, Date.now())
    const backup: Backup = {
      createdAt,
      date: localDate(createdAt),
      kind,
      label: BACKUP_KIND_LABELS[kind],
      options: deepToRaw(snapshot ?? await options.get()),
    }
    const key = `${BACKUP_PREFIX}${createdAt}`
    await browser.storage.local.set({ [key]: backup })

    const { keep, remove } = planBackupPrune([summarize(key, backup), ...index], await syncMeta.get('backupCount'))
    if (remove.length)
      await browser.storage.local.remove(remove)
    // Only a daily backup answers "has today been backed up?": an event backup
    // is kept to a different count and says nothing about the day's changes.
    await syncMeta.set(kind === 'daily' ? { backups: keep, lastBackupDate: backup.date } : { backups: keep })
    logger.log('Created backup', kind)
  })
}

/**
 * Create a backup only if today has none yet. Called on the first option change
 * of the day (whether a local edit or an incoming sync pull), so each day keeps a
 * single restore point capturing the state before that day's changes.
 */
export async function maybeDailyBackup(): Promise<void> {
  if (!(await syncMeta.get('backupsEnabled')))
    return
  // Cheap check against the tracked date so the hot path (every option change)
  // never has to read the index, let alone storage.
  if (await syncMeta.get('lastBackupDate') === localDate(Date.now()))
    return
  await createBackup('daily')
}

export function listBackups(): Promise<BackupSummary[]> {
  return serialized(async () => sortBackups(await readIndex()))
}

/**
 * Restore a backup. First snapshots the current state (so a restore is itself
 * undoable), then writes the backed-up options into `storage.local` — which the
 * sync engine observes and replicates if sync is on.
 */
export async function restoreBackup(key: string): Promise<void> {
  const stored = (await browser.storage.local.get(key))[key] as Backup | undefined
  if (!stored) {
    // The index outlived the backup (storage cleared, or removed by hand).
    await serialized(async () => {
      const index = await readIndex()
      await syncMeta.set({ backups: index.filter(backup => backup.key !== key) })
    })
    throw new Error(`Backup not found: ${key}`)
  }

  await createBackup('pre-restore')
  await options.set(stored.options)
  logger.log('Restored backup', key)
}
