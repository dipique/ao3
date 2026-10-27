import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { BACKUP_PREFIX, EVENT_BACKUPS_PER_KIND } from '../../src/common/backupIndex.ts'
import { createBackupStore } from '../../src/common/backupStore.ts'
import { SYNC_META_DEFAULTS } from '../../src/common/syncMetaDefaults.ts'

const DAY = 24 * 60 * 60 * 1000
const NOON = new Date(2026, 9, 9, 12).getTime()

const EVENT_KINDS = ['pre-restore', 'pre-sync', 'sync-held', 'sync-declined']

/**
 * A backup store over a `storage.local` of its own, as the background wires
 * one: `options` are the settings it reads, `meta` seeds the sync state,
 * `failWrites` makes every write to storage fail. Its clock starts at noon
 * and moves a millisecond a reading; `nextDay()` moves it on a day.
 */
function setup({ options = { wordsPerMinute: 320 }, meta = {}, failWrites = false } = {}) {
  const items = new Map()
  const state = { ...structuredClone(SYNC_META_DEFAULTS), ...structuredClone(meta) }
  let current = structuredClone(options)
  let clock = NOON
  const failing = { writes: failWrites }

  const store = createBackupStore({
    local: {
      async get(keys) {
        const wanted = keys ?? [...items.keys()]
        return Object.fromEntries(wanted.filter(key => items.has(key)).map(key => [key, structuredClone(items.get(key))]))
      },
      async set(update) {
        if (failing.writes)
          throw new Error('storage.local is full')
        for (const [key, value] of Object.entries(update))
          items.set(key, structuredClone(value))
      },
      async remove(keys) {
        for (const key of keys)
          items.delete(key)
      },
    },
    meta: {
      get: async keys => Object.fromEntries(keys.map(key => [key, structuredClone(state[key])])),
      set: async (update) => { Object.assign(state, structuredClone(update)) },
    },
    readOptions: async () => structuredClone(current),
    writeOptions: async (update) => { current = { ...current, ...structuredClone(update) } },
    now: () => clock++,
  })

  return {
    store,
    state,
    failing,
    /** Every backup in storage, oldest first. */
    get stored() {
      return [...items.entries()].filter(([key]) => key.startsWith(BACKUP_PREFIX)).map(([, backup]) => backup).sort((a, b) => a.createdAt - b.createdAt)
    },
    get options() { return structuredClone(current) },
    edit(update) { current = { ...current, ...structuredClone(update) } },
    nextDay() { clock += DAY },
    removeStored(key) { items.delete(key) },
  }
}

const kinds = backups => backups.map(backup => backup.kind)

describe('backup store', () => {
  describe('an event backup the same as the newest of its kind', () => {
    for (const kind of EVENT_KINDS) {
      test(`isn't written again: ${kind}`, async () => {
        const at = setup()
        await at.store.create(kind)
        await at.store.create(kind)
        assert.deepEqual(kinds(at.stored), [kind])
        assert.deepEqual((await at.store.list()).map(backup => backup.kind), [kind], 'the index lists the one')
      })
    }

    test('isn\'t written again from a snapshot either', async () => {
      const at = setup()
      const declined = { wordsPerMinute: 250, rules: { enabled: true, colors: {}, filters: [] } }
      await at.store.create('sync-declined', declined)
      await at.store.create('sync-declined', structuredClone(declined))
      assert.deepEqual(kinds(at.stored), ['sync-declined'])
      assert.deepEqual(at.stored[0].options, declined)
    })

    test('is the same whatever order its keys are in, at any depth', async () => {
      const at = setup()
      const filters = [{ target: 'freeform', value: 'Angst', matcher: 'exact', behavior: 'hide' }]
      await at.store.create('pre-sync', { wordsPerMinute: 320, rules: { enabled: true, colors: { a: '#fff', b: '#000' }, filters } })
      await at.store.create('pre-sync', {
        rules: { filters: [{ behavior: 'hide', matcher: 'exact', value: 'Angst', target: 'freeform' }], colors: { b: '#000', a: '#fff' }, enabled: true },
        wordsPerMinute: 320,
      })
      assert.deepEqual(kinds(at.stored), ['pre-sync'])
    })

    test('resolves without writing, so it holds even where nothing can be written', async () => {
      const at = setup()
      await at.store.create('sync-held')
      at.failing.writes = true
      await at.store.create('sync-held')
      assert.deepEqual(kinds(at.stored), ['sync-held'])
      await assert.rejects(at.store.create('pre-sync'), /storage\.local is full/, 'one that has to be written still fails')
    })
  })

  describe('an event backup that differs', () => {
    test('from the newest of its kind is written', async () => {
      const at = setup()
      await at.store.create('sync-held')
      at.edit({ wordsPerMinute: 330 })
      await at.store.create('sync-held')
      assert.deepEqual(at.stored.map(backup => [backup.kind, backup.options.wordsPerMinute]), [['sync-held', 320], ['sync-held', 330]])
    })

    test('only in the order of a list is written: a list\'s order is part of what it holds', async () => {
      const at = setup()
      const a = { target: 'freeform', value: 'Angst', matcher: 'exact', behavior: 'hide' }
      const b = { ...a, value: 'Fluff' }
      await at.store.create('pre-sync', { rules: { enabled: true, colors: {}, filters: [a, b] } })
      await at.store.create('pre-sync', { rules: { enabled: true, colors: {}, filters: [b, a] } })
      assert.equal(at.stored.length, 2)
    })

    test('only under a key spelled __proto__ is written: such a key is data like any other', async () => {
      const at = setup()
      const facets = values => JSON.parse(`{"trackedLists":{"enabled":true,"lists":[{"id":"a","filter":{"facets":{"__proto__":{"in":${JSON.stringify(values)}}}}}]}}`)
      await at.store.create('sync-declined', facets(['Angst']))
      await at.store.create('sync-declined', facets(['Fluff']))
      assert.deepEqual(at.stored.map(backup => Object.getOwnPropertyDescriptor(backup.options.trackedLists.lists[0].filter.facets, '__proto__').value.in), [['Angst'], ['Fluff']])
    })

    test('is written when it matches an older backup of its kind but not the newest', async () => {
      const at = setup()
      await at.store.create('pre-sync')
      at.edit({ wordsPerMinute: 330 })
      await at.store.create('pre-sync')
      at.edit({ wordsPerMinute: 320 })
      await at.store.create('pre-sync')
      assert.deepEqual(at.stored.map(backup => backup.options.wordsPerMinute), [320, 330, 320])
    })

    test('is weighed against its own kind alone: the same as another kind\'s newest is written', async () => {
      const at = setup()
      await at.store.create('pre-sync')
      await at.store.create('sync-held')
      await at.store.create('pre-restore')
      assert.deepEqual(kinds(at.stored), ['pre-sync', 'sync-held', 'pre-restore'])
    })

    test('is written when the newest of its kind is gone from storage, though the index still lists it', async () => {
      const at = setup()
      await at.store.create('sync-held')
      at.removeStored(`${BACKUP_PREFIX}${at.stored[0].createdAt}`)
      await at.store.create('sync-held')
      assert.deepEqual(kinds(at.stored), ['sync-held'])
    })
  })

  describe('daily backups', () => {
    test('are taken once a day, while daily backups are on', async () => {
      const at = setup()
      await at.store.maybeDaily()
      await at.store.maybeDaily()
      assert.deepEqual(kinds(at.stored), ['daily'])
      at.nextDay()
      at.edit({ wordsPerMinute: 330 })
      await at.store.maybeDaily()
      assert.deepEqual(at.stored.map(backup => backup.options.wordsPerMinute), [320, 330])
    })

    test('are written however much they hold what the day before\'s did: each is its day\'s restore point', async () => {
      const at = setup()
      for (let day = 0; day < 3; day++) {
        await at.store.maybeDaily()
        at.nextDay()
      }
      assert.deepEqual(kinds(at.stored), ['daily', 'daily', 'daily'])
    })

    test('aren\'t taken with daily backups off', async () => {
      const at = setup({ meta: { backupsEnabled: false } })
      await at.store.maybeDaily()
      assert.deepEqual(at.stored, [])
    })

    test('a day\'s backup that can\'t be written rejects, and the day still has none', async () => {
      const at = setup({ failWrites: true })
      await assert.rejects(at.store.maybeDaily(), /storage\.local is full/)
      assert.equal(at.state.lastBackupDate, '')
    })
  })

  describe('retention', () => {
    test('each event kind keeps its newest ten, and the daily backups all stay', async () => {
      const at = setup({ meta: { backupCount: 3 } })
      for (let day = 0; day < 3; day++) {
        at.edit({ wordsPerMinute: 100 + day })
        await at.store.maybeDaily()
        at.nextDay()
      }
      for (const kind of EVENT_KINDS) {
        for (let i = 0; i < EVENT_BACKUPS_PER_KIND + 2; i++) {
          at.edit({ wordsPerMinute: 1000 + i })
          await at.store.create(kind)
        }
      }
      assert.equal(EVENT_BACKUPS_PER_KIND, 10)
      for (const kind of EVENT_KINDS)
        assert.deepEqual(at.stored.filter(backup => backup.kind === kind).map(backup => backup.options.wordsPerMinute), Array.from({ length: 10 }, (_, i) => 1002 + i), kind)
      assert.deepEqual(at.stored.filter(backup => backup.kind === 'daily').map(backup => backup.options.wordsPerMinute), [100, 101, 102])
      assert.equal((await at.store.list()).length, at.stored.length, 'the index lists what storage holds')
    })
  })

  describe('restoring', () => {
    test('backs up the current settings first, then puts the backup\'s back', async () => {
      const at = setup()
      await at.store.create('sync-held')
      const [held] = await at.store.list()
      at.edit({ wordsPerMinute: 330 })
      await at.store.restore(held.key)
      assert.equal(at.options.wordsPerMinute, 320)
      assert.deepEqual(at.stored.map(backup => [backup.kind, backup.options.wordsPerMinute]), [['sync-held', 320], ['pre-restore', 330]])
    })

    test('a backup gone from storage leaves the index, and the restore fails', async () => {
      const at = setup()
      await at.store.create('sync-held')
      const [held] = await at.store.list()
      at.removeStored(held.key)
      await assert.rejects(at.store.restore(held.key), err => err.message.includes(held.key))
      assert.deepEqual(await at.store.list(), [])
    })
  })

  test('builds its index from storage the first time, where none is recorded', async () => {
    const at = setup()
    await at.store.create('pre-sync')
    at.state.backups = null
    assert.deepEqual((await at.store.list()).map(backup => backup.kind), ['pre-sync'])
  })
})
