// Simulated browsers for the sync scenario tests: one fake sync server, several
// real sync engines (src/common/syncCore.ts) each over its own fake storage, and
// a scripted stand-in for an outdated build. Not a test file itself.

import { createBackupStore } from '../../src/common/backupStore.ts'
import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import { createSavedListsReconciler } from '../../src/common/savedLists.ts'
import { decode, encode, MANIFEST_KEY } from '../../src/common/syncCodec.ts'
import { ALARM_CONSISTENCY, ALARM_PUSH, createSyncEngine } from '../../src/common/syncCore.ts'
import { SYNC_META_DEFAULTS } from '../../src/common/syncMetaDefaults.ts'
import { createDefaultMarks, localMarkIds, markItems, packIds } from '../../src/common/workMarks.ts'

const clone = v => (v === undefined ? undefined : structuredClone(v))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
/**
 * Let every promise chain and I/O callback already queued run. Not a timer:
 * nothing here waits on a clock, and Windows fires a zero-delay timer only
 * every 15 ms, which once made these scenarios take minutes.
 */
const tick = () => new Promise(resolve => setImmediate(resolve))

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
 * `version` is the sync version its build speaks. `stored` is its stored lists
 * (`cache.searchLists`).
 *
 * `savedLists` says whether its build keeps saved-list records. One that does
 * runs the background's half of them, the saved-list planner, one run at a time:
 * once as it is installed (the migration), whenever its tracked lists or stored
 * lists change, and inside the engine before a pull is applied.
 *
 * Its backups are the background's own store, over a `storage.local` of its
 * own, on a clock that stays within one day. `failBackups` makes every backup
 * it has to write fail, as a full or broken `storage.local` would: a daily one
 * too, whenever daily backups are on, since a failed one never counts as the
 * day's. `breakBackups()` does the same from then on.
 *
 * `ids: false` is a build from before the synced copy carried an ID, which
 * speaks sync version 11 at most (`version`): it never sees a copy's ID, or
 * the line an upload carries, on a copy, writes neither, and keeps neither
 * with its agreement. `restart({ version, ids: true })` updates it.
 *
 * The engine and the backups read one clock, which stands still until
 * `advance` moves it; each backup is taken a millisecond after the last. The push's and the read retry's alarms fire at the next
 * round, as if their minute had passed; the consistency check's fires once
 * the clock reaches it.
 */
export function createDevice(cloud, name, { options = {}, meta = {}, version, online = true, savedLists = true, stored = {}, failBackups = false, ids = true } = {}) {
  let opts = clone({ ...OPTION_DEFAULTS, ...options })
  let searchLists = clone(stored)
  const state = { ...clone(SYNC_META_DEFAULTS), ...clone(meta) }
  let alarms = new Map()
  const local = new Map()
  let backupsFail = failBackups
  /** Run once, as the next backup is written. */
  let onBackup = null
  let clock = new Date(2026, 9, 9, 12).getTime()
  /** Each backup a millisecond apart, without moving the clock the engine reads. */
  let backupTick = 0
  let seq = 0
  let engine
  let keepsSavedLists = savedLists
  let knowsIds = ids
  let planner = Promise.resolve()

  /** `value` as a build that knows no copy's ID has it: a manifest, or an agreement, without one or a line. */
  const asItKnows = value => (knowsIds || !value || typeof value !== 'object' ? value : (({ i, p, o, ...rest }) => rest)(value))

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
          out[key] = clone(key === MANIFEST_KEY ? asItKnows(peer.view.get(key)) : peer.view.get(key))
      }
      return out
    },
    async set(written) {
      const items = MANIFEST_KEY in written ? { ...written, [MANIFEST_KEY]: asItKnows(written[MANIFEST_KEY]) } : written
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
    now: () => clock,
    readOptions: async () => clone(opts),
    async writeOptions(update) {
      opts = { ...opts, ...clone(update) }
      const changes = Object.fromEntries(Object.keys(update).map(key => [`option.${key}`, {}]))
      queueMicrotask(() => {
        engine.onStorageChanged(changes, 'local')
        if (keepsSavedLists && 'trackedLists' in update)
          void reconcile()
      })
    },
    prePull: savedLists ? reconcile : undefined,
    meta: {
      get: async keys => Object.fromEntries(keys.map(key => [key, clone(state[key])])),
      set: async (update) => { Object.assign(state, clone('meta' in update ? { ...update, meta: asItKnows(update.meta) } : update)) },
    },
    sync,
    alarms: {
      create: (alarm, info) => { alarms.set(alarm, { ...info, due: clock + info.delayInMinutes * 60_000 }) },
      get: async alarm => alarms.get(alarm),
      clear: async alarm => alarms.delete(alarm),
    },
    randomId: () => `${name}-${++seq}`,
  }

  deps.backups = createBackupStore({
    local: {
      async get(keys) {
        const wanted = keys ?? [...local.keys()]
        return Object.fromEntries(wanted.filter(key => local.has(key)).map(key => [key, clone(local.get(key))]))
      },
      async set(items) {
        const during = onBackup
        onBackup = null
        during?.()
        if (backupsFail)
          throw new Error(`${name}: storage.local could not be written`)
        for (const [key, value] of Object.entries(items))
          local.set(key, clone(value))
      },
      async remove(keys) {
        for (const key of keys)
          local.delete(key)
      },
    },
    meta: deps.meta,
    readOptions: deps.readOptions,
    writeOptions: deps.writeOptions,
    now: () => clock + backupTick++,
  })

  /** The background's reconciler, over this browser's storage. */
  const reconciler = createSavedListsReconciler({
    read: async () => clone({ trackedLists: opts.trackedLists, savedLists: opts.savedLists, searchLists }),
    write: update => deps.writeOptions(update),
  })

  /** The planner's run, after any already under way; `settle` waits for the last one asked for. */
  function reconcile() {
    const run = reconciler()
    planner = run.catch(() => {})
    return run
  }

  engine = createSyncEngine(deps)
  cloud.attach(peer)
  if (keepsSavedLists)
    void reconcile()

  /** Its backups in storage, oldest first. */
  const storedBackups = () => [...local.values()].sort((a, b) => a.createdAt - b.createdAt)

  const device = {
    name,
    peer,
    /** Its event backups, oldest first: each one's kind and the settings it holds. */
    get backups() {
      return storedBackups().filter(backup => backup.kind !== 'daily').map(backup => ({ kind: backup.kind, options: clone(backup.options) }))
    },
    /** Its daily backups, oldest first, as `backups` has the others. */
    get dailyBackups() {
      return storedBackups().filter(backup => backup.kind === 'daily').map(backup => ({ kind: backup.kind, options: clone(backup.options) }))
    },
    get options() { return clone(opts) },
    get meta() { return clone(state) },
    get alarms() { return [...alarms.keys()] },
    get engine() { return engine },
    /** Its stored lists, `cache.searchLists`. */
    get stored() { return clone(searchLists) },
    /** The synced items as it sees them: the copy it last wrote or was sent. */
    get synced() { return Object.fromEntries([...peer.view].map(([key, value]) => [key, clone(value)])) },

    /**
     * The sync service hands it `items` as the synced store, as a service can
     * before it settles on the write that lands last: its view becomes them,
     * and it hears of each item that changed.
     */
    async receive(items) {
      const changes = {}
      for (const key of new Set([...peer.view.keys(), ...Object.keys(items)])) {
        if (same(peer.view.get(key), items[key]))
          continue
        if (key in items)
          peer.view.set(key, clone(items[key]))
        else
          peer.view.delete(key)
        changes[key] = key in items ? { newValue: clone(items[key]) } : {}
      }
      if (Object.keys(changes).length)
        engine.onStorageChanged(changes, 'sync')
      await device.settle()
    },

    /** Wait for every queued storage event, engine operation and planner run to finish. */
    async settle() {
      for (let pass = 0; pass < 6; pass++) {
        await tick()
        await engine.idle()
        await planner
      }
    },

    /** A search view stores a list, as `cache.searchLists[key]`. */
    async store(key, list) {
      searchLists = { ...searchLists, [key]: clone(list) }
      if (keepsSavedLists)
        void reconcile()
      await device.settle()
    },

    /** Fire the alarms that are due: the push's and the read retry's as if their delay had passed, the consistency check's once the clock has reached it. */
    async react() {
      const due = [...alarms].filter(([name, info]) => name !== ALARM_CONSISTENCY || info.due <= clock).map(([name]) => name)
      if (!peer.online || !due.length)
        return false
      for (const alarm of due)
        alarms.delete(alarm)
      for (const alarm of due)
        engine.onAlarm({ name: alarm })
      await device.settle()
      return true
    },

    /**
     * Its pending push runs while it is offline, as a browser cut off from the
     * sync service still writes to its synced storage: the upload waits in its
     * outbox until it is back. Whether a push was pending.
     */
    async pushOffline() {
      if (!alarms.delete(ALARM_PUSH))
        return false
      engine.onAlarm({ name: ALARM_PUSH })
      await device.settle()
      return true
    },

    /** Move its clock on by `ms`. */
    advance(ms) {
      clock += ms
    },

    async enableSync() {
      const result = await engine.setEnabled(true)
      await device.settle()
      return result
    },

    async disableSync() {
      const result = await engine.setEnabled(false)
      await device.settle()
      return result
    },

    /** Write device-local sync state directly, as the background does outside the engine. */
    async setMeta(update) {
      Object.assign(state, clone(update))
    },

    /** From now on, every backup it has to write fails, as `failBackups` has them fail from the start. */
    breakBackups() {
      backupsFail = true
    },

    /** Runs `fn` as its next backup is written: something that happens while the engine is partway through what took it. */
    whileBackingUp(fn) {
      onBackup = fn
    },

    /** The reader answers a held update, or which settings to keep as sync turns on: whether it was answered. */
    async resolveHeld(choice) {
      return (await device.answer(choice)).resolved
    },

    /** As `resolveHeld`, with the whole answer: `refused` says why an answer wasn't taken. */
    async answer(choice) {
      const answer = await engine.resolveHeld(choice)
      await device.settle()
      return answer
    },

    /** The reader replaces synced settings that can't be read whole with this browser's: whether they were sent. */
    async replace() {
      const replaced = await engine.replaceSyncedCopy()
      await device.settle()
      return replaced
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
     *
     * An update can bring saved lists (`savedLists`), and with them `migrate`,
     * the migration's planner run, ahead of the engine's reconciliation with the
     * cloud, as an install runs them. Without `migrate`, the engine gets there
     * first. It can bring the synced copy's ID (`ids`), finding its agreement
     * with none.
     */
    async restart({ version: nextVersion, init = false, savedLists: keeps, migrate = false, ids: nextIds } = {}) {
      alarms = new Map()
      if (nextVersion !== undefined)
        deps.version = nextVersion
      if (nextIds !== undefined)
        knowsIds = nextIds
      if (keeps !== undefined) {
        keepsSavedLists = keeps
        deps.prePull = keeps ? reconcile : undefined
      }
      engine = createSyncEngine(deps)
      await engine.start?.()
      if (migrate)
        await reconcile()
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

/**
 * `count` tracked lists, each a works search for a different word — different
 * queries, so each one is its own entry as far as the guard is concerned.
 */
export function trackedListsFixture(count, over = {}) {
  return {
    enabled: true,
    target: 40,
    reviewedThrough: 0,
    lists: Array.from({ length: count }, (_, i) => ({
      id: `l${i}`,
      kind: 'text-search',
      url: `/works/search?work_search%5Bquery%5D=word+${i}`,
      alias: `Search ${i}`,
      tracked: true,
      since: 20000,
    })),
    ...over,
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
