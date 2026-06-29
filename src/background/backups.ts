import type { BackupKind, BackupSummary, Options } from '#common'

import { createLogger, deepToRaw, options, syncMeta } from '#common'

const logger = createLogger('Backups')

/** Backups live in `storage.local`, one key per backup. */
const PREFIX = 'backup.'

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

const KIND_LABEL: Record<BackupKind, string> = {
  'daily': 'Daily backup',
  'pre-restore': 'Before restore',
  'pre-sync': 'Before sync adopt',
}

async function readAll(): Promise<Array<{ key: string, backup: Backup }>> {
  const all = await browser.storage.local.get(null)
  return Object.entries(all)
    .filter(([k]) => k.startsWith(PREFIX))
    .map(([key, backup]) => ({ key, backup: backup as Backup }))
    .sort((a, b) => b.backup.createdAt - a.backup.createdAt)
}

/** Snapshot the current options under a fresh key, then prune to the configured count. */
export async function createBackup(kind: BackupKind): Promise<void> {
  const createdAt = Date.now()
  const snapshot = deepToRaw(await options.get())
  const backup: Backup = {
    createdAt,
    date: localDate(createdAt),
    kind,
    label: KIND_LABEL[kind],
    options: snapshot,
  }
  await browser.storage.local.set({ [`${PREFIX}${createdAt}`]: backup })
  await syncMeta.set({ lastBackupDate: backup.date })
  logger.log('Created backup', kind)
  await pruneBackups()
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
  // never has to read all of `storage.local` (which holds the big caches too).
  if (await syncMeta.get('lastBackupDate') === localDate(Date.now()))
    return
  await createBackup('daily')
}

/** Keep the newest N backups (by creation time); delete the rest. */
export async function pruneBackups(): Promise<void> {
  const count = Math.max(1, await syncMeta.get('backupCount'))
  const all = await readAll()
  const excess = all.slice(count)
  if (excess.length)
    await browser.storage.local.remove(excess.map(e => e.key))
}

export async function listBackups(): Promise<BackupSummary[]> {
  return (await readAll()).map(({ key, backup }) => ({
    key,
    createdAt: backup.createdAt,
    date: backup.date,
    kind: backup.kind,
    label: backup.label,
  }))
}

/**
 * Restore a backup. First snapshots the current state (so a restore is itself
 * undoable), then writes the backed-up options into `storage.local` — which the
 * sync engine observes and replicates if sync is on.
 */
export async function restoreBackup(key: string): Promise<void> {
  const stored = (await browser.storage.local.get(key))[key] as Backup | undefined
  if (!stored)
    throw new Error(`Backup not found: ${key}`)

  await createBackup('pre-restore')
  await options.set(stored.options)
  logger.log('Restored backup', key)
}
