// Simulated browsers for the sync scenario tests: one fake sync server, several
// real sync engines (src/common/syncCore.ts) each over its own fake storage, and
// a scripted stand-in for an outdated build. Not a test file itself.

import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import { decode, encode, MANIFEST_KEY } from '../../src/common/syncCodec.ts'
import { createSyncEngine } from '../../src/common/syncCore.ts'
import { SYNC_META_DEFAULTS } from '../../src/common/syncMetaDefaults.ts'
import { createDefaultMarks, localMarkIds, markItems, packIds } from '../../src/common/workMarks.ts'

const clone = v => (v === undefined ? undefined : structuredClone(v))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

/**
 * The sync server. Each browser keeps its own view of the synced items and an
 * outbox of the writes it hasn't sent yet; `deliver()` sends every connected
 * browser's outbox in turn (a later write to the same item wins, which is how
 * Chrome resolves them) and then brings every connected view up to date, firing
 * `storage.onChanged` wherever an item changed.
 */
export function createCloud() {
  const server = new Map()
  const peers = []
  const actors = []

  function attach(peer) {
    peers.push(peer)
    for (const [key, value] of server)
      peer.view.set(key, clone(value))
  }

  function deliver() {
    let moved = false
    for (const peer of peers) {
      if (!peer.online)
        continue
      for (const [key, value] of peer.outbox.splice(0)) {
        moved = true
        if (value === undefined)
          server.delete(key)
        else
          server.set(key, clone(value))
      }
    }
    for (const peer of peers) {
      if (!peer.online)
        continue
      const changes = {}
      for (const [key, value] of server) {
        if (!same(peer.view.get(key), value)) {
          peer.view.set(key, clone(value))
          changes[key] = { newValue: clone(value) }
        }
      }
      for (const key of [...peer.view.keys()]) {
        if (!server.has(key)) {
          peer.view.delete(key)
          changes[key] = {}
        }
      }
      if (Object.keys(changes).length)
        peer.notify(changes)
    }
    return moved
  }

  /**
   * Let everything play out: deliver writes, let each browser react, fire the
   * alarms that reaction set (standing in for the minute passing), and repeat
   * until nothing moves. Bounded, so an echo loop shows up as a long run instead
   * of a hung test.
   */
  async function run({ rounds = 25 } = {}) {
    for (let round = 1; round <= rounds; round++) {
      let busy = deliver()
      for (const actor of actors)
        await actor.settle()
      for (const actor of actors)
        busy = (await actor.react()) || busy
      if (!busy)
        return round
    }
    return rounds
  }

  return {
    server,
    manifest: () => clone(server.get(MANIFEST_KEY)) ?? null,
    attach,
    deliver,
    run,
    addActor: actor => actors.push(actor),
  }
}

/**
 * One browser running the real engine. `options` and `meta` seed its storage;
 * `version` is the sync version its build speaks.
 */
export function createDevice(cloud, name, { options = {}, meta = {}, version, online = true } = {}) {
  let opts = clone({ ...OPTION_DEFAULTS, ...options })
  const state = { ...clone(SYNC_META_DEFAULTS), ...clone(meta) }
  let alarms = new Map()
  const backups = []
  let seq = 0
  let engine

  const peer = {
    name,
    view: new Map(),
    outbox: [],
    online,
    notify: changes => engine.onStorageChanged(changes, 'sync'),
  }

  const sync = {
    async get(keys) {
      const wanted = keys == null ? [...peer.view.keys()] : Array.isArray(keys) ? keys : [keys]
      const out = {}
      for (const key of wanted) {
        if (peer.view.has(key))
          out[key] = clone(peer.view.get(key))
      }
      return out
    },
    async set(items) {
      const changes = {}
      for (const [key, value] of Object.entries(items)) {
        peer.view.set(key, clone(value))
        peer.outbox.push([key, clone(value)])
        changes[key] = { newValue: clone(value) }
      }
      // storage.sync fires onChanged on the writing browser too.
      queueMicrotask(() => engine.onStorageChanged(changes, 'sync'))
    },
    async remove(keys) {
      const changes = {}
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        peer.view.delete(key)
        peer.outbox.push([key, undefined])
        changes[key] = {}
      }
      queueMicrotask(() => engine.onStorageChanged(changes, 'sync'))
    },
    async getBytesInUse() {
      return JSON.stringify([...peer.view]).length
    },
  }

  const deps = {
    defaults: OPTION_DEFAULTS,
    version,
    readOptions: async () => clone(opts),
    async writeOptions(update) {
      opts = { ...opts, ...clone(update) }
      const changes = Object.fromEntries(Object.keys(update).map(key => [`option.${key}`, {}]))
      queueMicrotask(() => engine.onStorageChanged(changes, 'local'))
    },
    meta: {
      get: async keys => Object.fromEntries(keys.map(key => [key, clone(state[key])])),
      set: async (update) => { Object.assign(state, clone(update)) },
    },
    sync,
    alarms: {
      create: (alarm, info) => { alarms.set(alarm, info) },
      get: async alarm => alarms.get(alarm),
      clear: async alarm => alarms.delete(alarm),
    },
    backups: {
      maybeDaily: async () => {},
      async create(kind, snapshot) {
        backups.push({ kind, options: clone(snapshot ?? opts) })
      },
    },
    randomId: () => `${name}-${++seq}`,
  }

  engine = createSyncEngine(deps)
  cloud.attach(peer)

  const device = {
    name,
    peer,
    backups,
    get options() { return clone(opts) },
    get meta() { return clone(state) },
    get alarms() { return [...alarms.keys()] },
    get engine() { return engine },

    /** Wait for every queued storage event and engine operation to finish. */
    async settle() {
      for (let pass = 0; pass < 6; pass++) {
        await tick()
        await engine.idle()
      }
    },

    /** Fire whatever alarms are pending, as if their delay had passed. */
    async react() {
      if (!peer.online || !alarms.size)
        return false
      const names = [...alarms.keys()]
      alarms = new Map()
      for (const alarm of names)
        engine.onAlarm({ name: alarm })
      await device.settle()
      return true
    },

    async enableSync() {
      const result = await engine.setEnabled(true)
      await device.settle()
      return result
    },

    /** The reader answers a held update. */
    async resolveHeld(choice) {
      const resolved = await engine.resolveHeld(choice)
      await device.settle()
      return resolved
    },

    /** A change the reader makes in this browser's options. */
    async edit(update) {
      await deps.writeOptions(update)
      await device.settle()
    },

    /**
     * The worker restarts (an extension reload, an update, the browser coming
     * back): alarms are gone, the engine's memory is gone, storage survives.
     * `start` is whatever the background does at the top level when it wakes.
     */
    async restart({ version: nextVersion, init = false } = {}) {
      alarms = new Map()
      if (nextVersion !== undefined)
        deps.version = nextVersion
      engine = createSyncEngine(deps)
      await engine.start?.()
      // An update or browser start also reconciles with the cloud.
      if (init)
        await engine.init()
      await device.settle()
    },
  }

  cloud.addActor(device)
  return device
}

/**
 * An outdated build that keeps syncing: whenever the cloud changes under it, it
 * copies the payload into its own storage and pushes back a copy holding only
 * the options it knows (`knownKeys`), with no key list, on sync version 1. That
 * is what the first sync build did. Like that build, it goes quiet the moment
 * the cloud carries a newer sync version.
 */
export function createLegacyDevice(cloud, name, { knownKeys, options = {}, legacyOptions = {} }) {
  const legacyDefaults = Object.fromEntries(knownKeys.map(key => [key, OPTION_DEFAULTS[key]]))
  Object.assign(legacyDefaults, Object.fromEntries(Object.keys(legacyOptions).map(key => [key, emptyLike(legacyOptions[key])])))
  let opts = { ...clone(legacyDefaults), ...clone(options), ...clone(legacyOptions) }
  let seq = 0
  let pending = false
  let pushes = 0

  const peer = {
    name,
    view: new Map(),
    outbox: [],
    online: true,
    notify: () => {
      pending = true
    },
  }
  cloud.attach(peer)

  async function write(generation) {
    const { chunks, manifest } = await encode(opts, legacyDefaults, generation, `${name}.${++seq}`)
    manifest.v = 1
    delete manifest.k
    for (const [key, value] of Object.entries({ ...chunks, [MANIFEST_KEY]: manifest })) {
      peer.view.set(key, clone(value))
      peer.outbox.push([key, clone(value)])
    }
    pushes++
  }

  const legacy = {
    peer,
    /** How many copies it has written. */
    get pushes() { return pushes },
    async settle() {},
    async react() {
      if (!pending || !peer.online)
        return false
      pending = false
      const remote = peer.view.get(MANIFEST_KEY)
      if (!remote || remote.v > 1 || remote.w.startsWith(`${name}.`))
        return false
      const result = await decode(Object.fromEntries(peer.view), 1)
      if (!result.ok)
        return false
      opts = { ...opts, ...clone(result.options) }
      await write(remote.g + 1)
      return true
    },
    /**
     * Write regardless of what the cloud holds: an old build that was offline
     * when the newer version landed, and never saw it before writing.
     */
    async overwrite() {
      await write((peer.view.get(MANIFEST_KEY)?.g ?? 0) + 1)
    },
  }
  cloud.addActor(legacy)
  return legacy
}

function emptyLike(value) {
  if (Array.isArray(value))
    return []
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, typeof inner === 'boolean' ? false : emptyLike(inner)]))
  return value
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export function rulesFixture(count) {
  return {
    enabled: true,
    colors: {},
    filters: Array.from({ length: count }, (_, i) => ({ target: 'freeform', value: `Tag ${i}`, matcher: 'exact', behavior: 'hide' })),
  }
}

export function marksFixture(ids, { read = ids } = {}) {
  const marks = createDefaultMarks()
  marks.read.items = packIds(read)
  return { enabled: true, marks, version: 1 }
}

export function textReplacementsFixture(count) {
  return {
    enabled: true,
    tools: true,
    rules: Array.from({ length: count }, (_, i) => ({ find: `find ${i}`, replace: `replace ${i}`, caseSensitive: false, matchCasing: false, wholeWord: true })),
  }
}

/** Every work id carrying any mark. */
export function markedWorks(options) {
  const ids = new Set()
  for (const mark of localMarkIds(options.workMarks.marks)) {
    for (const id of markItems(options.workMarks.marks, mark))
      ids.add(id)
  }
  return ids
}

export const range = (from, count) => Array.from({ length: count }, (_, i) => String(from + i))
