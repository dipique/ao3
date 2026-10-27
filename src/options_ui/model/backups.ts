import type { BackupKind, BackupSummary } from '../../common/api.ts'

import { BACKUP_KIND_LABELS, sortBackups } from '../../common/backupIndex.ts'
import { formatMoment } from './moments.ts'

/**
 * The Backups sub-section's list of snapshots, from the backup index: newest
 * first, each named by what took it, with how long a backup of its kind is
 * kept and when it was taken.
 */

export interface BackupRow {
  key: string
  kind: BackupKind
  /** What took it. */
  label: string
  /** How long a backup of its kind is kept. */
  retention: string
  /** When it was taken, naming today and yesterday. */
  when: string
  /** Its Restore button's name. */
  restore: string
}

export interface BackupListView {
  /** The list header's count. */
  count: string
  rows: BackupRow[]
  /** What the list says in place of rows while it has none. */
  empty: { title: string | null, text: string } | null
}

/** Daily backups: whether they are taken, and how many are kept. */
export interface DailyBackups {
  enabled: boolean
  count: number
}

/** What the list says with no backups of when the next is taken: `daily` with daily backups on, `off` with them off, when none is. */
export const NEXT_BACKUP = {
  daily: 'One is saved automatically the first time you change a setting each day.',
  off: 'Daily backups are off.',
} as const

/**
 * The list for `backups`, the index as the background lists it, or null until
 * it has answered. A kind this build doesn't know is pruned as an event backup
 * is, and named as it was when taken.
 */
export function backupList(backups: readonly BackupSummary[] | null, daily: DailyBackups, now: number): BackupListView {
  if (!backups)
    return { count: '', rows: [], empty: { title: null, text: 'Loading…' } }
  if (!backups.length) {
    const text = daily.enabled ? NEXT_BACKUP.daily : NEXT_BACKUP.off
    return { count: 'none yet', rows: [], empty: { title: 'No backups yet', text } }
  }
  const rows = sortBackups(backups).map((backup): BackupRow => {
    const label = BACKUP_KIND_LABELS[backup.kind] ?? backup.label
    const when = formatMoment(backup.createdAt, now)
    return {
      key: backup.key,
      kind: backup.kind,
      label,
      retention: backup.kind === 'daily' ? dailyRetention(daily.count) : 'kept apart · newest ten of its kind',
      when,
      restore: `Restore “${label}” from ${when}`,
    }
  })
  return { count: `${rows.length} · newest first`, rows, empty: null }
}

function dailyRetention(count: number): string {
  return count === 1 ? 'daily · only the newest is kept' : `daily · the newest ${count} are kept`
}
