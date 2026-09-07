/**
 * A `browser` for a page with no extension behind it.
 *
 * The exported site runs the extension's own search view, and everything that
 * view reads or writes funnels through two places: `createStorage`
 * ({@link file://../common/storage.ts}) for settings and caches, and
 * `createAPI` ({@link file://../common/api.ts}) for cross-context calls. So the
 * whole surface an export has to stand in for is `storage.local`,
 * `storage.onChanged`, and a handful of `runtime` stubs — not a WebExtension.
 *
 * **Storage is one IndexedDB database, `ao3e-site`.** Every local file shares a
 * single `file://` origin, so one database serves every export a reader ever
 * opens — which is what you want: marks belong to the reader, not to the list
 * they were made on, and two exports should agree about them. The database name
 * is the namespace; nothing else needs one.
 *
 * **Reads answer from memory, writes go through to disk.** The store is
 * hydrated once, before the app is loaded, and kept in a `Map` from then on.
 * That makes `storage.local.get` as cheap as the real thing (it is called on
 * nearly every render) while `set` still resolves only once the row is
 * committed, so a reader who closes the tab straight after a mark keeps it.
 *
 * **Whether it is writable at all is measured, not assumed.** A probe value is
 * written and read back on the way in; where that round trip fails the store
 * degrades to memory for the session and says so, because a page that offers to
 * remember something and silently doesn't is worse than one that never offered.
 *
 * **The open itself is defensive**, for the same reason the origin is shared:
 * this page cannot assume it is the only thing that ever used the name, or the
 * newest thing to have used it. See {@link openDatabase}.
 */

/** One database for every export the reader opens; the name is the namespace. */
const DB_NAME = 'ao3e-site'

/** Mirrors `browser.storage.local`: one row per storage key. */
const STORAGE_STORE = 'storage'

/**
 * The append-only record of what the reader did here, for the change ops an
 * export hands back to the extension. Created with the database rather than
 * waiting for the feature that fills it, so the store is already there for an
 * export built before it and one built after.
 */
const JOURNAL_STORE = 'journal'

/** Where {@link SiteStorageMeta} lives, inside the storage store. */
const META_KEY = 'ao3e.site.meta'

/** Written and read back to decide whether this origin can keep anything. */
const PROBE_KEY = 'ao3e.site.probe'

/**
 * The little that has to be known about this origin rather than about any one
 * export. Deliberately small: none of it can be recovered if the store is
 * evicted, so nothing that matters is kept only here.
 */
export interface SiteStorageMeta {
  /** Epoch ms this origin was first written to, so "last opened" has an age. */
  firstOpened: number
  lastOpened: number
  opens: number
  /**
   * `generatedAt` of the export whose settings are in the store.
   *
   * The reason it is recorded at all: every local file shares one origin, so an
   * older export opened after a newer one would otherwise write its stale
   * settings over the fresh ones. Seeding happens only when this is absent or
   * older than the export doing the seeding.
   */
  seededGeneration: number
}

/** What {@link installBrowserShim} reports back about the origin it found. */
export interface SiteStorage {
  /** Whether a write here survives the page being closed. */
  writable: boolean
  /** Why it doesn't, when it doesn't — for the line the page shows. */
  reason: string | null
  meta: SiteStorageMeta
}

type Items = Record<string, unknown>
type Changes = Record<string, { oldValue?: unknown, newValue?: unknown }>
type ChangeListener = (changes: Changes, areaName: string) => void

const memory = new Map<string, unknown>()
const changeListeners = new Set<ChangeListener>()
const messageListeners = new Set<unknown>()

let db: IDBDatabase | null = null
let writable = false

/** Writes are chained so they land in the order they were made. */
let writes: Promise<void> = Promise.resolve()

/**
 * Stand a `browser` up on `globalThis` and hydrate it, then return what the
 * origin turned out to be capable of.
 *
 * Must finish before anything that imports `#common` is loaded: the storage
 * layer captures `browser.storage.onChanged` at module scope, and the logger
 * reads a setting the moment it is imported. That is why the site's entry
 * module reaches its app through a dynamic import rather than a static one.
 */
export async function installBrowserShim(seed: { generatedAt: number, items: Items }): Promise<SiteStorage> {
  defineBrowser()

  let reason: string | null = null
  try {
    db = await openDatabase()
    await hydrate(db)
    await probe(db)
    writable = true
  }
  catch (error) {
    reason = error instanceof Error ? error.message : String(error)
    db = null
    writable = false
  }

  const meta = await openOrigin(seed)
  return { writable, reason, meta }
}

// --- The origin ------------------------------------------------------------

/**
 * Note this open, and seed the reader's settings if this export is the newest
 * one this origin has seen.
 */
async function openOrigin(seed: { generatedAt: number, items: Items }): Promise<SiteStorageMeta> {
  const now = Date.now()
  const stored = memory.get(META_KEY) as Partial<SiteStorageMeta> | undefined
  const meta: SiteStorageMeta = {
    firstOpened: stored?.firstOpened ?? now,
    lastOpened: now,
    opens: (stored?.opens ?? 0) + 1,
    seededGeneration: stored?.seededGeneration ?? 0,
  }

  const items: Items = {}
  if (!stored || seed.generatedAt > meta.seededGeneration) {
    Object.assign(items, seed.items)
    meta.seededGeneration = seed.generatedAt
  }
  items[META_KEY] = meta

  await setItems(items)
  return meta
}

// --- The database ----------------------------------------------------------

/** What an export has to find before it can call the origin usable. */
const STORES = [STORAGE_STORE, JOURNAL_STORE]

function hasStores(database: IDBDatabase): boolean {
  return STORES.every(name => database.objectStoreNames.contains(name))
}

/**
 * Open `ao3e-site`, adding the stores if whatever is already on that name
 * doesn't have them.
 *
 * **No fixed version number, deliberately.** An export is immutable and lands on
 * an origin shared by every other local file — exports made months earlier or
 * later, and (measured, on a real device) unrelated pages that happened to pick
 * the same database name. Asking for a *specific* version turns both into
 * permanent failures: a database already on a higher version rejects the open
 * outright with `VersionError`, and one sitting on the same version without our
 * stores never upgrades again, so every open succeeds and every transaction then
 * fails with `NotFoundError`. Neither heals on its own, and the reader is told
 * this browser keeps nothing — on a device where it keeps things perfectly well.
 *
 * So: open at whatever version is there, look for the stores, and only if they
 * are missing reopen one version higher to create them. Any bundle of any
 * vintage then reaches what it needs, wherever the origin has drifted to. The
 * one rule this asks of future changes is that stores are only ever **added** —
 * never renumbered, never renamed out from under an older export.
 *
 * What it will not do is delete anything. A database it cannot fix is left
 * exactly as found and the store degrades to memory for the session: what is in
 * there may be the reader's only copy of an afternoon's marking.
 */
async function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined')
    throw new TypeError('this browser has no storage for a local file')

  let database = await openAt()
  if (hasStores(database))
    return database

  const next = database.version + 1
  database.close()
  database = await openAt(next)
  if (hasStores(database))
    return database

  database.close()
  throw new Error('storage here could not be given the stores this page needs')
}

/**
 * One open. With no version an absent database is created at 1 (running the
 * upgrade below), and an existing one opens wherever it already is.
 */
function openAt(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORAGE_STORE))
        database.createObjectStore(STORAGE_STORE)
      if (!database.objectStoreNames.contains(JOURNAL_STORE))
        database.createObjectStore(JOURNAL_STORE, { keyPath: 'id' }).createIndex('at', 'at')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('the browser refused to open storage'))
    // Only reachable if another tab holds an older version of the database open.
    request.onblocked = () => reject(new Error('another copy of this page is holding storage open'))
  })
}

/** Read every row into memory. Everything after this is answered from there. */
function hydrate(database: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORAGE_STORE, 'readonly')
    const store = tx.objectStore(STORAGE_STORE)
    const keys = store.getAllKeys()
    const values = store.getAll()
    tx.oncomplete = () => {
      keys.result.forEach((key, index) => {
        // The probe's own row is left on disk rather than deleted in a third
        // transaction, so it is skipped here instead — it is this module's
        // business, not something a caller reading all of storage should see.
        if (String(key) !== PROBE_KEY)
          memory.set(String(key), values.result[index])
      })
      resolve()
    }
    tx.onerror = () => reject(tx.error ?? new Error('storage could not be read'))
  })
}

/**
 * Write a value and read it back, in two transactions, to find out whether this
 * origin keeps anything at all.
 *
 * Not a protocol check. `file:` was measured to store perfectly well in at least
 * one browser, and a served copy can still be opened somewhere storage is
 * blocked, so the only honest question is whether a write round-trips.
 */
async function probe(database: IDBDatabase): Promise<void> {
  const token = `${Date.now()}`
  await commit(database, new Map([[PROBE_KEY, token]]), [])
  const seen = await new Promise<unknown>((resolve, reject) => {
    const tx = database.transaction(STORAGE_STORE, 'readonly')
    const request = tx.objectStore(STORAGE_STORE).get(PROBE_KEY)
    tx.oncomplete = () => resolve(request.result)
    tx.onerror = () => reject(tx.error ?? new Error('storage could not be read back'))
  })
  if (seen !== token)
    throw new Error('a test write did not come back')
}

function commit(database: IDBDatabase, sets: Map<string, unknown>, deletes: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORAGE_STORE, 'readwrite')
    const store = tx.objectStore(STORAGE_STORE)
    for (const [key, value] of sets)
      store.put(value, key)
    for (const key of deletes)
      store.delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('storage could not be written'))
    tx.onabort = () => reject(tx.error ?? new Error('storage refused the write'))
  })
}

// --- storage.local ---------------------------------------------------------

function getItems(query?: string | string[] | Items | null): Items {
  if (query === undefined || query === null)
    return Object.fromEntries(memory)

  const result: Items = {}
  if (typeof query === 'string') {
    if (memory.has(query))
      result[query] = memory.get(query)
    return result
  }
  if (Array.isArray(query)) {
    for (const key of query) {
      if (memory.has(key))
        result[key] = memory.get(key)
    }
    return result
  }
  // The object form's values are the caller's defaults for absent keys.
  for (const [key, fallback] of Object.entries(query))
    result[key] = memory.has(key) ? memory.get(key) : fallback
  return result
}

async function setItems(items: Items): Promise<void> {
  const sets = new Map(Object.entries(items))
  const changes = collect(sets.keys(), key => ({ oldValue: memory.get(key), newValue: sets.get(key) }))
  for (const [key, value] of sets)
    memory.set(key, value)
  await flush(sets, [])
  announce(changes)
}

async function removeItems(query: string | string[]): Promise<void> {
  const keys = (Array.isArray(query) ? query : [query]).filter(key => memory.has(key))
  const changes = collect(keys, key => ({ oldValue: memory.get(key) }))
  for (const key of keys)
    memory.delete(key)
  await flush(new Map(), keys)
  announce(changes)
}

function collect(keys: Iterable<string>, describe: (key: string) => Changes[string]): Changes {
  const changes: Changes = {}
  for (const key of keys)
    changes[key] = describe(key)
  return changes
}

/**
 * Push a change to disk, keeping writes in the order they were made.
 *
 * A failure here downgrades the origin rather than rejecting: the value is
 * already in memory and the page keeps working for this session, which is
 * exactly what a reader whose browser evicted the database mid-read should get.
 */
function flush(sets: Map<string, unknown>, deletes: string[]): Promise<void> {
  if (!db || !writable)
    return Promise.resolve()
  const database = db
  writes = writes.then(
    () => commit(database, sets, deletes),
    () => commit(database, sets, deletes),
  ).catch(() => {
    writable = false
  })
  return writes
}

function announce(changes: Changes): void {
  if (!Object.keys(changes).length)
    return
  for (const listener of changeListeners)
    listener(changes, 'local')
}

// --- The object itself -----------------------------------------------------

/**
 * The one packaged resource anything reachable from the view asks for is the
 * bundled fandom→id index, and an export carries no extension package to hold
 * it. A `data:` URL of an empty object lets that load succeed and find nothing,
 * which is the truth — the toolbars lose their tag ids, not their menus — where
 * a broken URL would only add a failed request and a console error to say the
 * same thing.
 */
const EMPTY_PACKAGED_RESOURCE = 'data:application/json,%7B%7D'

function defineBrowser(): void {
  const area = {
    get: (query?: string | string[] | Items | null) => Promise.resolve(getItems(query)),
    set: (items: Items) => setItems(items),
    remove: (query: string | string[]) => removeItems(query),
    clear: () => removeItems([...memory.keys()]),
    getKeys: () => Promise.resolve([...memory.keys()]),
    getBytesInUse: () => Promise.resolve(0),
  }

  const shim = {
    runtime: {
      // Truthy, because `#common` reads this to tell a live extension from an
      // orphaned one and answers from defaults — silently — when it is absent.
      id: DB_NAME,
      getManifest: () => ({ manifest_version: 3, name: 'AO3 Enhancements', short_name: 'AO3 Enhancements', version: '0.0.0' }),
      getURL: () => EMPTY_PACKAGED_RESOURCE,
      // There is no background here. Every caller already copes with a message
      // going unanswered, because an orphaned content script produces the same.
      sendMessage: () => Promise.resolve(undefined),
      openOptionsPage: () => Promise.resolve(),
      onMessage: {
        addListener: (fn: unknown) => void messageListeners.add(fn),
        removeListener: (fn: unknown) => void messageListeners.delete(fn),
        hasListener: (fn: unknown) => messageListeners.has(fn),
      },
    },
    storage: {
      local: area,
      session: area,
      onChanged: {
        addListener: (fn: ChangeListener) => void changeListeners.add(fn),
        removeListener: (fn: ChangeListener) => void changeListeners.delete(fn),
        hasListener: (fn: ChangeListener) => changeListeners.has(fn),
      },
    },
    tabs: {
      sendMessage: () => Promise.reject(new Error('there are no tabs to message from a saved page')),
      query: () => Promise.resolve([]),
    },
  }

  Object.defineProperty(globalThis, 'browser', { configurable: true, value: shim, writable: true })
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: shim, writable: true })
}
