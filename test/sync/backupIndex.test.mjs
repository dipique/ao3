import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { EVENT_BACKUPS_PER_KIND, freeBackupTime, newestOfKind, planBackupPrune, sortBackups } from '../../src/common/backupIndex.ts'

const DAY = 24 * 60 * 60 * 1000
const backup = (kind, createdAt) => ({ key: `backup.${createdAt}`, createdAt, date: '', kind, label: '' })

describe('planBackupPrune', () => {
  test('keeps the newest N daily backups', () => {
    const index = Array.from({ length: 10 }, (_, i) => backup('daily', i * DAY))
    const { keep, remove } = planBackupPrune(index, 7)
    assert.deepEqual(keep.map(b => b.createdAt), [9, 8, 7, 6, 5, 4, 3].map(i => i * DAY))
    assert.deepEqual(remove.sort(), [0, 1, 2].map(i => `backup.${i * DAY}`).sort())
  })

  test('event backups don\'t push out the daily history', () => {
    const daily = Array.from({ length: 7 }, (_, i) => backup('daily', i * DAY))
    const burst = Array.from({ length: 12 }, (_, i) => backup('sync-held', 7 * DAY + i))
    const { keep } = planBackupPrune([...daily, ...burst], 7)
    assert.equal(keep.filter(b => b.kind === 'daily').length, 7, 'every daily backup survives the burst')
    assert.equal(keep.filter(b => b.kind === 'sync-held').length, EVENT_BACKUPS_PER_KIND)
  })

  test('keeps the newest ten of each event kind', () => {
    assert.equal(EVENT_BACKUPS_PER_KIND, 10)
    const kinds = ['pre-restore', 'pre-sync', 'sync-held', 'sync-declined']
    const events = kinds.flatMap((kind, k) => Array.from({ length: 12 }, (_, i) => backup(kind, 100 * k + i)))
    const { keep, remove } = planBackupPrune(events, 7)
    for (const [k, kind] of kinds.entries()) {
      assert.deepEqual(keep.filter(b => b.kind === kind).map(b => b.createdAt), Array.from({ length: 10 }, (_, i) => 100 * k + 11 - i), kind)
      assert.deepEqual(remove.filter(key => events.find(b => b.key === key).kind === kind).sort(), [`backup.${100 * k}`, `backup.${100 * k + 1}`].sort(), kind)
    }
  })

  test('however many event backups every kind takes, the daily ones all stay', () => {
    const daily = Array.from({ length: 30 }, (_, i) => backup('daily', i * DAY))
    const events = ['pre-restore', 'pre-sync', 'sync-held', 'sync-declined']
      .flatMap((kind, k) => Array.from({ length: 40 }, (_, i) => backup(kind, 40 * DAY + 100 * k + i)))
    const { keep } = planBackupPrune([...events, ...daily], 30)
    assert.deepEqual(keep.filter(b => b.kind === 'daily'), sortBackups(daily))
  })

  test('a held update\'s backup keeps to its kind\'s newest ten, and leaves the daily backups be', () => {
    const daily = Array.from({ length: 3 }, (_, i) => backup('daily', i * DAY))
    const held = Array.from({ length: EVENT_BACKUPS_PER_KIND + 1 }, (_, i) => backup('sync-held', 10 * DAY + i))
    const { keep, remove } = planBackupPrune([...daily, ...held], 7)
    assert.deepEqual(remove, [held[0].key], 'only the oldest held backup goes')
    assert.deepEqual(keep.filter(b => b.kind === 'daily'), sortBackups(daily), 'the daily backups taken before stay')
  })

  test('each event kind is counted on its own', () => {
    const declined = backup('sync-declined', 1)
    const restores = Array.from({ length: EVENT_BACKUPS_PER_KIND + 3 }, (_, i) => backup('pre-restore', 100 + i))
    const { keep } = planBackupPrune([declined, ...restores], 7)
    assert.ok(keep.includes(declined), 'a burst of restores can\'t evict the declined copy')
  })

  test('always keeps at least one daily backup', () => {
    const { keep } = planBackupPrune([backup('daily', 1), backup('daily', 2)], 0)
    assert.deepEqual(keep.map(b => b.createdAt), [2])
  })
})

describe('sortBackups', () => {
  test('newest first, without mutating the input', () => {
    const index = [backup('daily', 1), backup('daily', 3), backup('pre-sync', 2)]
    assert.deepEqual(sortBackups(index).map(b => b.createdAt), [3, 2, 1])
    assert.deepEqual(index.map(b => b.createdAt), [1, 3, 2])
  })
})

describe('newestOfKind', () => {
  test('the newest backup of the kind, whatever the index\'s order and the other kinds', () => {
    const index = [backup('pre-sync', 2), backup('sync-held', 9), backup('pre-sync', 5), backup('pre-sync', 3), backup('daily', 8)]
    assert.equal(newestOfKind(index, 'pre-sync')?.createdAt, 5)
    assert.equal(newestOfKind(index, 'sync-declined'), undefined)
  })
})

describe('freeBackupTime', () => {
  test('the time itself when free, the next free millisecond when not', () => {
    assert.equal(freeBackupTime([], 50), 50)
    assert.equal(freeBackupTime([backup('daily', 50), backup('pre-sync', 51)], 50), 52)
  })
})
