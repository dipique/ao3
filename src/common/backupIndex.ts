import type { BackupKind, BackupSummary } from './api.ts'

/** Storage key prefix of a backup. The rest of the key is its creation time. */
export const BACKUP_PREFIX = 'backup.'

/**
 * How many of each event backup to keep, on top of the daily ones. Event
 * backups are taken around something that replaces options wholesale — turning
 * sync on, a restore, a sync update held back or declined — and each is the one
 * copy of what that event replaced, so a run of them mustn't push out the daily
 * history (or each other's kinds).
 */
export const EVENT_BACKUPS_PER_KIND = 5

export const BACKUP_KIND_LABELS: Record<BackupKind, string> = {
  'daily': 'Daily backup',
  'pre-restore': 'Before restore',
  'pre-sync': 'Before sync adopt',
  'sync-held': 'Before a held sync update',
  'sync-declined': 'Sync update you declined',
}

/** Newest first. */
export function sortBackups(index: readonly BackupSummary[]): BackupSummary[] {
  return [...index].sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Which backups to keep: the newest `dailyCount` daily backups, and the newest
 * {@link EVENT_BACKUPS_PER_KIND} of every other kind, each counted separately.
 */
export function planBackupPrune(
  index: readonly BackupSummary[],
  dailyCount: number,
): { keep: BackupSummary[], remove: string[] } {
  const seen = new Map<BackupKind, number>()
  const keep: BackupSummary[] = []
  const remove: string[] = []
  for (const backup of sortBackups(index)) {
    const limit = backup.kind === 'daily' ? Math.max(1, dailyCount) : EVENT_BACKUPS_PER_KIND
    const count = (seen.get(backup.kind) ?? 0) + 1
    seen.set(backup.kind, count)
    if (count <= limit)
      keep.push(backup)
    else
      remove.push(backup.key)
  }
  return { keep, remove }
}

/** A creation time no backup in `index` has, starting from `now`: it's the key. */
export function freeBackupTime(index: readonly BackupSummary[], now: number): number {
  const taken = new Set(index.map(backup => backup.createdAt))
  let createdAt = now
  while (taken.has(createdAt))
    createdAt++
  return createdAt
}
