import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { backupList } from '../../src/options_ui/model/backups.ts'
import { formatMoment } from '../../src/options_ui/model/moments.ts'

const NOW = new Date(2026, 9, 3, 18, 4).getTime()
const ON = { enabled: true, count: 7 }

const backup = (kind, createdAt, label = '') => ({ key: `backup.${createdAt}`, createdAt, date: '', kind, label })

const today = new Date(2026, 9, 3, 14, 46).getTime()
const yesterday = new Date(2026, 9, 2, 18, 46).getTime()
const oct1 = new Date(2026, 9, 1, 18, 46).getTime()
const sep30 = new Date(2026, 8, 30, 18, 46).getTime()
const sep29 = new Date(2026, 8, 29, 18, 46).getTime()
const sep28 = new Date(2026, 8, 28, 18, 46).getTime()

/** Every kind, once each, in no order. */
const KINDS = [
  backup('pre-sync', sep29),
  backup('daily', today),
  backup('sync-declined', sep28),
  backup('sync-held', oct1),
  backup('pre-restore', sep30),
]

const KEPT_APART = 'kept apart · newest five of its kind'

describe('backupList', () => {
  test('lists the backups newest first', () => {
    const { rows } = backupList([backup('daily', sep28), backup('daily', today), backup('pre-sync', sep29), backup('daily', yesterday)], ON, NOW)
    assert.deepEqual(rows.map(row => row.key), [today, yesterday, sep29, sep28].map(at => `backup.${at}`))
  })

  test('names each kind by what took it, and says how long it is kept', () => {
    const { rows } = backupList(KINDS, ON, NOW)
    assert.deepEqual(rows.map(row => [row.kind, row.label, row.retention]), [
      ['daily', 'Daily backup', 'daily · the newest 7 are kept'],
      ['sync-held', 'Before a held sync update', KEPT_APART],
      ['pre-restore', 'Before a restore', KEPT_APART],
      ['pre-sync', 'Before turning on sync', KEPT_APART],
      ['sync-declined', 'Sync update you declined', KEPT_APART],
    ])
  })

  test('a daily backup\'s retention follows the count to keep', () => {
    const [kept] = backupList([backup('daily', today)], { enabled: true, count: 30 }, NOW).rows
    assert.equal(kept.retention, 'daily · the newest 30 are kept')
    const [one] = backupList([backup('daily', today)], { enabled: true, count: 1 }, NOW).rows
    assert.equal(one.retention, 'daily · only the newest is kept')
  })

  test('a backup taken under an older name reads by its kind', () => {
    const [row] = backupList([backup('pre-sync', sep29, 'Before sync adopt')], ON, NOW).rows
    assert.equal(row.label, 'Before turning on sync')
  })

  test('a kind this build doesn\'t know keeps the name it was taken with, and is kept apart', () => {
    const [row] = backupList([backup('sync-later', sep29, 'Some later kind')], ON, NOW).rows
    assert.equal(row.label, 'Some later kind')
    assert.equal(row.retention, KEPT_APART)
  })

  test('says when each was taken, naming today and yesterday', () => {
    const { rows } = backupList([backup('daily', today), backup('daily', yesterday), backup('sync-held', oct1)], ON, NOW)
    assert.deepEqual(rows.map(row => row.when), [formatMoment(today, NOW), formatMoment(yesterday, NOW), formatMoment(oct1, NOW)])
    assert.match(rows[0].when, /^Today, /)
    assert.match(rows[1].when, /^Yesterday, /)
  })

  test('names each Restore by the backup it restores', () => {
    const { rows } = backupList([backup('daily', today), backup('pre-restore', sep30)], ON, NOW)
    assert.deepEqual(rows.map(row => row.restore), [
      `Restore “Daily backup” from ${formatMoment(today, NOW)}`,
      `Restore “Before a restore” from ${formatMoment(sep30, NOW)}`,
    ])
  })

  test('counts them, newest first', () => {
    assert.equal(backupList(KINDS, ON, NOW).count, '5 · newest first')
    assert.equal(backupList([backup('daily', today)], ON, NOW).count, '1 · newest first')
    assert.equal(backupList(KINDS, ON, NOW).empty, null)
  })

  test('with none yet, says so, and when one will be taken', () => {
    assert.deepEqual(backupList([], ON, NOW), {
      count: 'none yet',
      rows: [],
      empty: { title: 'No backups yet', text: 'One is saved automatically the first time you change a setting each day.' },
    })
  })

  test('with daily backups off, still lists the backups taken as sync held an update, kept apart', () => {
    const view = backupList([backup('sync-held', oct1), backup('daily', sep28)], { enabled: false, count: 7 }, NOW)
    assert.equal(view.empty, null)
    assert.equal(view.count, '2 · newest first')
    assert.deepEqual(view.rows.map(row => [row.kind, row.label, row.retention]), [
      ['sync-held', 'Before a held sync update', KEPT_APART],
      ['daily', 'Daily backup', 'daily · the newest 7 are kept'],
    ])
  })

  test('with none yet and daily backups off, promises none', () => {
    assert.deepEqual(backupList([], { enabled: false, count: 7 }, NOW).empty, { title: 'No backups yet', text: 'Daily backups are off.' })
  })

  test('says it is loading until the backups are known', () => {
    assert.deepEqual(backupList(null, ON, NOW), { count: '', rows: [], empty: { title: null, text: 'Loading…' } })
  })
})
