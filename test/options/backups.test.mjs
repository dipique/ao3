import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { BACKUP_KIND_LABELS } from '../../src/common/backupIndex.ts'
import { backupList, NEXT_BACKUP } from '../../src/options_ui/model/backups.ts'
import { formatMoment } from '../../src/options_ui/model/moments.ts'
import { numbers } from '../facts.mjs'

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

describe('backupList', () => {
  test('lists the backups newest first', () => {
    const { rows } = backupList([backup('daily', sep28), backup('daily', today), backup('pre-sync', sep29), backup('daily', yesterday)], ON, NOW)
    assert.deepEqual(rows.map(row => row.key), [today, yesterday, sep29, sep28].map(at => `backup.${at}`))
  })

  test('names each kind by what took it, and keeps all but daily backups apart, under one retention', () => {
    const { rows } = backupList(KINDS, ON, NOW)
    assert.deepEqual(rows.map(row => [row.kind, row.label]), ['daily', 'sync-held', 'pre-restore', 'pre-sync', 'sync-declined'].map(kind => [kind, BACKUP_KIND_LABELS[kind]]))
    const [daily, ...events] = rows
    assert.equal(new Set(events.map(row => row.retention)).size, 1, 'every event backup is kept the same way')
    assert.notEqual(daily.retention, events[0].retention, 'a daily backup is kept another way')
  })

  test('a daily backup\'s retention follows the count to keep', () => {
    const retention = count => backupList([backup('daily', today)], { enabled: true, count }, NOW).rows[0].retention
    assert.deepEqual(numbers(retention(7)), [7])
    assert.deepEqual(numbers(retention(30)), [30])
    assert.ok(retention(1), 'one kept is said too')
    assert.notEqual(retention(1), retention(2).replace('2', '1'), 'one kept is said as one')
  })

  test('a backup taken under an older name reads by its kind', () => {
    const [row] = backupList([backup('pre-sync', sep29, 'Before sync adopt')], ON, NOW).rows
    assert.equal(row.label, BACKUP_KIND_LABELS['pre-sync'])
  })

  test('a kind this build doesn\'t know keeps the name it was taken with, and is kept apart', () => {
    const [row] = backupList([backup('sync-later', sep29, 'Some later kind')], ON, NOW).rows
    assert.equal(row.label, 'Some later kind')
    assert.equal(row.retention, backupList([backup('sync-held', oct1)], ON, NOW).rows[0].retention)
  })

  test('says when each was taken', () => {
    const { rows } = backupList([backup('daily', today), backup('daily', yesterday), backup('sync-held', oct1)], ON, NOW)
    assert.deepEqual(rows.map(row => row.when), [formatMoment(today, NOW), formatMoment(yesterday, NOW), formatMoment(oct1, NOW)])
  })

  test('names each Restore by the backup it restores, and when it was taken', () => {
    const { rows } = backupList([backup('daily', today), backup('pre-restore', sep30)], ON, NOW)
    for (const row of rows) {
      assert.ok(row.restore.includes(row.label), `${row.kind}'s Restore names it`)
      assert.ok(row.restore.includes(row.when), `${row.kind}'s Restore says when it was taken`)
    }
    assert.notEqual(rows[0].restore, rows[1].restore)
  })

  test('counts them', () => {
    assert.deepEqual(numbers(backupList(KINDS, ON, NOW).count), [5])
    assert.deepEqual(numbers(backupList([backup('daily', today)], ON, NOW).count), [1])
    assert.equal(backupList(KINDS, ON, NOW).empty, null)
  })

  test('with none yet, says so, and when one will be taken', () => {
    const view = backupList([], ON, NOW)
    assert.deepEqual(view.rows, [])
    assert.deepEqual(numbers(view.count), [])
    assert.ok(view.empty.title)
    assert.equal(view.empty.text, NEXT_BACKUP.daily)
  })

  test('with daily backups off, still lists the backups taken as sync held an update, kept apart', () => {
    const view = backupList([backup('sync-held', oct1), backup('daily', sep28)], { enabled: false, count: 7 }, NOW)
    assert.equal(view.empty, null)
    assert.deepEqual(numbers(view.count), [2])
    assert.deepEqual(view.rows.map(row => [row.kind, row.label]), [['sync-held', BACKUP_KIND_LABELS['sync-held']], ['daily', BACKUP_KIND_LABELS.daily]])
    assert.deepEqual(numbers(view.rows[1].retention), [7])
  })

  test('with none yet and daily backups off, promises none', () => {
    const { empty } = backupList([], { enabled: false, count: 7 }, NOW)
    assert.ok(empty.title)
    assert.equal(empty.text, NEXT_BACKUP.off)
  })

  test('says it is loading until the backups are known', () => {
    const view = backupList(null, ON, NOW)
    assert.deepEqual([view.count, view.rows, view.empty.title], ['', [], null])
    assert.ok(view.empty.text)
  })
})
