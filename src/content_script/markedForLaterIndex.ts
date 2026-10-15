import type { Cache, MarkedForLaterIndex } from '#common'

import { cache, packIds, savedIndexChanges, unpackIds } from '#common'

/**
 * The set of works on your Marked for Later list, as of the last time we scraped
 * it in bulk (the Marked for Later search view, which caches the list anyway).
 *
 * A blurb doesn't say whether its work is marked for later — only the work's own
 * page does — so reading the state honestly costs one fetch per work, which is
 * why listings showed no saved indicator at all until you opened a work's menu.
 * This index turns that around: the indicator is drawn from the last scrape, and
 * the per-work fetch is only paid when a menu actually opens, which then corrects
 * whatever the list has moved on from.
 *
 * It is therefore a cache, not a source of truth — a work in it is *probably*
 * still saved; a work missing from it is simply unknown, never "not saved". It's
 * kept per user (someone else's ids would be nonsense) and packed with the same
 * delta encoding the read/favourite marks use, since it grows to the size of the
 * whole list.
 */

/** The index for the current page run, once read. */
let loaded: { userId: string, ids: Set<string> } | null = null

/** Ids are stored against a case-folded user id: AO3 login names aren't case-sensitive. */
function normalize(userId: string): string {
  return userId.toLowerCase()
}

/** Told of each work that came onto the index or went off it, from this page or another. */
export type SavedListener = (workId: string, saved: boolean) => void

const listeners = new Set<SavedListener>()

/**
 * This page's own writes, oldest first, by {@link echoOf}: storage tells the
 * page that wrote a value as well as every other, and a write of ours that
 * arrives after a newer one would otherwise read as the newer one undone.
 */
const ownWrites: string[] = []

function echoOf(entry: MarkedForLaterIndex): string {
  return `${entry.updatedAt}:${entry.ids}`
}

function write(userId: string, ids: Set<string>): Promise<void> {
  const entry = { userId, updatedAt: Date.now(), ids: packIds(ids) }
  ownWrites.push(echoOf(entry))
  return cache.set({ markedForLater: entry })
}

function announce(changes: Map<string, boolean>): void {
  for (const [id, saved] of changes) {
    for (const listener of listeners)
      listener(id, saved)
  }
}

/**
 * Another page's write: taken in as this page's index, so a toggle here goes on
 * from it rather than writing back a set from before it, and announced.
 */
function onCacheChange(change: Partial<Cache>): void {
  const entry = change.markedForLater
  if (!entry || !loaded)
    return
  const echo = ownWrites.indexOf(echoOf(entry))
  if (echo >= 0) {
    ownWrites.splice(0, echo + 1)
    return
  }
  if (normalize(entry.userId) !== loaded.userId)
    return
  const changes = savedIndexChanges(loaded.ids, unpackIds(entry.ids))
  // In place: the set is handed out ({@link markedForLaterIds}) and read live.
  for (const [id, saved] of changes) {
    if (saved)
      loaded.ids.add(id)
    else
      loaded.ids.delete(id)
  }
  announce(changes)
}

/** From the first load on, so a toggle here goes on from what other pages wrote. Idempotent. */
function hear(): void {
  cache.addListener(onCacheChange)
}

/**
 * Hear of every work that comes onto the index or goes off it once it has been
 * loaded this run — by this page's toggles, and by any other page's — so what
 * a page shows can follow a work saved for later in another tab. Returns the
 * way to stop.
 */
export function onSavedChange(listener: SavedListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The cached ids for `userId`, read once per page run and shared from then on.
 * An index belonging to another user (or none at all) reads as empty rather than
 * as an error — "we know nothing" is exactly what an empty set means here.
 */
export async function loadMarkedForLaterIndex(userId: string): Promise<Set<string>> {
  const key = normalize(userId)
  if (loaded?.userId === key)
    return loaded.ids
  const entry = await cache.get('markedForLater')
  const ids = entry.userId === key ? unpackIds(entry.ids) : new Set<string>()
  hear()
  loaded = { userId: key, ids }
  return ids
}

/**
 * The ids read this run, without a storage round-trip — or null when nothing has
 * loaded the index yet, which is not the same as "no work is saved". For the
 * callers that have to answer synchronously per work (the search view's Status
 * facet); everything else should await {@link loadMarkedForLaterIndex}, which is
 * what puts a set here in the first place.
 */
export function markedForLaterIds(): ReadonlySet<string> | null {
  return loaded?.ids ?? null
}

/** Replace the index with a freshly scraped list. */
export async function saveMarkedForLaterIndex(userId: string, ids: Iterable<string>): Promise<void> {
  const key = normalize(userId)
  const before = loaded?.userId === key ? loaded.ids : null
  hear()
  loaded = { userId: key, ids: new Set(ids) }
  if (before)
    announce(savedIndexChanges(before, loaded.ids))
  await write(key, loaded.ids)
}

/**
 * Fold one toggle into the index, so an indicator doesn't outlive the action that
 * changed it. Synchronous, with the write dispatched unawaited, because the
 * strictest caller is AO3's own mark button: it submits a form and navigates, so
 * there's no time for a storage round-trip (the same reason
 * {@link file://./workMarks.ts}'s mark writers work this way).
 *
 * A no-op until the index has been loaded this run — without the loaded set the
 * new one can't be computed without a read, and the cost of skipping is one stale
 * entry, which the next menu open or scrape corrects.
 */
export function noteMarkedForLater(id: string, saved: boolean): void {
  if (!loaded || loaded.ids.has(id) === saved)
    return
  if (saved)
    loaded.ids.add(id)
  else
    loaded.ids.delete(id)
  void write(loaded.userId, loaded.ids)
  announce(new Map([[id, saved]]))
}
