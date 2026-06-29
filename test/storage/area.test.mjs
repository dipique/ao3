import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'

// storage.ts and logger.ts touch `browser` at module-load time, so the mock must
// exist on globalThis *before* the dynamic import below evaluates them.
function installMock() {
  const stores = { local: {}, sync: {}, session: {}, managed: {} }
  const listeners = new Set()
  const toArr = k => (k == null ? null : Array.isArray(k) ? k : typeof k === 'object' ? Object.keys(k) : [k])
  const area = name => ({
    get: (keys) => {
      const out = {}
      const ks = toArr(keys) ?? Object.keys(stores[name])
      for (const k of ks) if (k in stores[name]) out[k] = stores[name][k]
      return Promise.resolve(out)
    },
    set: (items) => {
      const changes = {}
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: stores[name][k], newValue: v }
        stores[name][k] = v
      }
      listeners.forEach(l => l(changes, name))
      return Promise.resolve()
    },
    remove: (keys) => { (toArr(keys) || []).forEach(k => delete stores[name][k]); return Promise.resolve() },
    clear: () => { stores[name] = {}; return Promise.resolve() },
  })
  const browser = {
    storage: {
      local: area('local'),
      sync: area('sync'),
      session: area('session'),
      managed: area('managed'),
      onChanged: {
        addListener: l => listeners.add(l),
        removeListener: l => listeners.delete(l),
        hasListener: l => listeners.has(l),
      },
    },
  }
  globalThis.browser = browser
  globalThis.chrome = browser
  return { stores }
}

describe('createStorage honors the configured area', () => {
  let createStorage, mock

  before(async () => {
    mock = installMock()
    ;({ createStorage } = await import('../../src/common/storage.ts'))
  })

  test('set() writes to the configured area, not always local', async () => {
    const store = createStorage({ area: 'sync', name: 'T', prefix: 't.', defaults: { a: 1 } })
    await store.set({ a: 42 })

    assert.equal(mock.stores.sync['t.a'], 42, 'value should land in the sync area')
    assert.equal('t.a' in mock.stores.local, false, 'value must NOT land in local')
  })

  test('get() reads from the configured area with defaults applied', async () => {
    const store = createStorage({ area: 'sync', name: 'T', prefix: 't.', defaults: { a: 1, b: 'x' } })
    mock.stores.sync['t.a'] = 7
    const all = await store.get()
    assert.deepEqual(all, { a: 7, b: 'x' }, 'present key from sync, missing key from defaults')
  })

  test('the change listener fires only for the matching area', async () => {
    const store = createStorage({ area: 'sync', name: 'T', prefix: 't.', defaults: { a: 1 } })
    const seen = []
    store.addListener(change => seen.push(change))

    // A write to a DIFFERENT area must be ignored.
    await browser.storage.local.set({ 't.a': 100 })
    assert.deepEqual(seen, [], 'local change must not notify a sync-area store')

    // A write to the configured area must be delivered.
    await browser.storage.sync.set({ 't.a': 200 })
    assert.deepEqual(seen, [{ a: 200 }], 'sync change must notify a sync-area store')

    store.removeListener(() => {})
  })
})
