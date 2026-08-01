import { notUndefined, objectMap, toArray } from '@antfu/utils'
import type { ValueOf } from 'type-fest'

import { isContextInvalidatedError, isExtensionContextValid } from './extensionContext.ts'
import { createLogger } from './logger.ts'

export interface StorageDetails<Shape extends StorageShape> {
  area: StorageArea
  name: string
  prefix: string
  defaults: Shape
  ignoredEvents?: StorageId<Shape>[]
}

interface StorageShape {
  [key: string]: any
}

type StorageArea = 'local' | 'sync' | 'managed' | 'session'
type StorageId<Shape extends StorageShape> = keyof Shape & string
type StorageChange<Shape extends StorageShape> = Partial<Shape>
type StorageListener<Shape extends StorageShape> = (changes: StorageChange<Shape>) => void

const onChanged = browser.storage.onChanged

export function createStorage<Shape extends StorageShape>(details: StorageDetails<Shape>) {
  const { area, name, prefix, defaults, ignoredEvents = [] } = details
  const logger = createLogger(name)
  const listeners = new Set<StorageListener<Shape>>()

  /**
   * Set once this script has been orphaned (see
   * {@link file://./extensionContext.ts}). From then on reads answer from
   * defaults and writes are dropped, because there is no longer anywhere to put
   * them — and it's logged once rather than on every call, since a stale tab can
   * go on generating these for as long as it stays open.
   */
  let orphaned = false

  function noteOrphaned(): void {
    if (orphaned)
      return
    orphaned = true
    logger.warn('The extension was reloaded, updated, or disabled — this page\'s copy can no longer read or write settings. Reload the page to reconnect.')
  }

  const storage = {
    ...details,
    get,
    set,
    addListener(this: void, listener: StorageListener<Shape>) {
      listeners.add(listener)
      updateListener()
    },
    removeListener(this: void, listener: StorageListener<Shape>) {
      listeners.delete(listener)
      updateListener()
    },
    hasListener(this: void, listener: StorageListener<Shape>) {
      return listeners.has(listener)
    },
  }

  return storage

  async function get<K extends StorageId<Shape>>(id: K): Promise<ValueOf<Shape, K>>
  async function get<K extends Array<StorageId<Shape>>>(ids: K): Promise<Pick<Shape, K[number]>>
  async function get(): Promise<Shape>
  async function get(ids?: StorageId<Shape> | StorageId<Shape>[]): Promise<unknown> {
    // Turn into array of prefixed keys
    const request = toArray(ids ?? Object.keys(defaults)).map(id => `${prefix}${id}`)

    // An orphaned script answers from defaults instead of rejecting. Callers are
    // spread across event handlers that mostly can't do anything useful with a
    // failure, and the pairing that matters is safe: a read that falls back to
    // defaults can't be written back over real data, because `set` is dropped
    // too — both are dead for exactly the same reason.
    const rawResponse = await readRaw(request)

    // Map back to the original key names, and apply defaults
    const response = request.map((key) => {
      const id = key.substring(prefix.length) as StorageId<Shape>
      return [id, rawResponse[key] ?? defaults[id]] as [StorageId<Shape>, unknown]
    })

    logger.debug(response)

    return (ids === undefined || Array.isArray(ids)) ? Object.fromEntries(response) : response[0]![1]
  }

  /** Read raw items, answering `{}` (so callers fall back to defaults) once orphaned. */
  async function readRaw(request: string[]): Promise<Record<string, unknown>> {
    if (orphaned || !isExtensionContextValid()) {
      noteOrphaned()
      return {}
    }
    try {
      return await browser.storage[area].get(request)
    }
    catch (error) {
      // The check above races — the context can die between it and this call.
      if (!isContextInvalidatedError(error))
        throw error
      noteOrphaned()
      return {}
    }
  }

  async function set<T extends Partial<Shape>>(obj: T): Promise<void> {
    if (orphaned || !isExtensionContextValid()) {
      noteOrphaned()
      return
    }
    const items = objectMap(obj, (id, value) => [`${prefix}${id}`, value])
    logger.debug('Setting:', items)
    try {
      await browser.storage[area].set(items)
    }
    catch (error) {
      if (!isContextInvalidatedError(error))
        throw error
      noteOrphaned()
    }
  }

  function listener(changes: { [key: string]: browser.storage.StorageChange }, areaName: string) {
    if (areaName !== area)
      return

    const keys = Object.keys(changes).filter(key => key.startsWith(prefix))

    if (!keys.length)
      return

    const entries = keys.map((key) => {
      const id = key.slice(prefix.length) as StorageId<Shape>
      return ignoredEvents.includes(id) ? undefined : [id, changes[key]!.newValue] as [StorageId<Shape>, unknown]
    }).filter(notUndefined)

    if (entries.length) {
      logger.debug('Change:', entries)
      const change = Object.fromEntries(entries) as StorageChange<Shape>
      listeners.forEach(l => l(change))
    }
  }

  function updateListener() {
    // Subscribing through a severed context throws the same way a read does, and
    // there are no changes left to hear about anyway.
    if (orphaned || !isExtensionContextValid()) {
      noteOrphaned()
      return
    }
    try {
      if (listeners.size === 0 && onChanged.hasListener(listener))
        onChanged.removeListener(listener)
      else if (!onChanged.hasListener(listener))
        onChanged.addListener(listener)
    }
    catch (error) {
      if (!isContextInvalidatedError(error))
        throw error
      noteOrphaned()
    }
  }
}
