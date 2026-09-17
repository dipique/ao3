import type { LegacySearchSnapshot, SnapshotDescriptor, StoredList } from '#common'
import type { Work } from '#content_script/blurb.js'

import {
  cache,
  droppedIds,
  isContextInvalidatedError,
  isExtensionContextValid,
  LEGACY_SNAPSHOTS_KEY,
  LIST_VERSION,
  listedIds,
  options,
  packIds,
  packOrderedIds,
  toShortId,
  unpackIds,
  unpackOrderedIds,
} from '#common'
import { parseWork } from '#content_script/blurb.js'

import type { ParsedWork } from './blurbStore.ts'

import { isPersisted, pruneBlurbs, readBlurbIndex, readParsed, readRecords, rewriteStale, storedContext, storeWorks, worksFromRecords } from './blurbStore.ts'
import { pristineBlurb } from './pristine.ts'

export { normalizeBlurb, pristineBlurb } from './pristine.ts'

/**
 * Persistent lists for the in-memory search view, keyed by an arbitrary source
 * string (e.g. `marked-for-later:USERID`), so a later visit can render the view
 * instantly from storage while a fresh scrape runs in the background.
 *
 * A list holds its works' short ids (`cache.searchLists`); each blurb is stored
 * once, under its work, by the shared store ({@link file://./blurbStore.ts}),
 * however many lists hold it. The functions here keep the names and shapes they
 * had when a list carried its blurbs inline, so their callers never learned the
 * difference.
 */

/** Lists this build can draw. Anything else is kept, and not drawn. */
function readable(list: StoredList | undefined): list is StoredList {
  return !!list && list.v === LIST_VERSION && typeof list.ids === 'string'
}

/**
 * Oldest and newest versions of a list stored the old way — blurbs inline —
 * that the fallback reader will still draw. v1 is v2 without a descriptor.
 */
const LEGACY_VERSIONS = [1, 2] as const

export interface CachedSnapshot {
  scrapedAt: number
  works: Work[]
  /** Absent on a list first stored before descriptors existed. */
  descriptor?: SnapshotDescriptor
  /**
   * Works the list names whose blurbs aren't stored — a partial migration, a
   * cache-only import, a race with a discard. They are left out of `works`, and
   * a copy missing some is not one to trust as recent.
   */
  missing: number
}

/** A list's metadata, without paying to read its blurbs. */
export interface SnapshotSummary {
  key: string
  scrapedAt: number
  /** Works held. */
  count: number
  /**
   * The works' ids, in list order. The options page needs them to say how many
   * of *this* list's works are cached ({@link file://../siteExport/workTextCache.ts}
   * keys by work, not by list).
   */
  workIds: string[]
  /** Of those, how many the blurb index says aren't stored — works a refresh would restore. */
  unstored: number
  descriptor?: SnapshotDescriptor
}

// ---------------------------------------------------------------------------
// The old layout, for the release that migrates it.
// ---------------------------------------------------------------------------

async function readLegacy(): Promise<{ [key: string]: LegacySearchSnapshot }> {
  if (!isExtensionContextValid())
    return {}
  try {
    const value = (await browser.storage.local.get(LEGACY_SNAPSHOTS_KEY))[LEGACY_SNAPSHOTS_KEY]
    return value && typeof value === 'object' ? value as { [key: string]: LegacySearchSnapshot } : {}
  }
  catch (error) {
    if (isContextInvalidatedError(error))
      return {}
    throw error
  }
}

function legacyReadable(entry: LegacySearchSnapshot | undefined): entry is LegacySearchSnapshot {
  return !!entry && Array.isArray(entry.blurbsHtml)
    && entry.version >= LEGACY_VERSIONS[0] && entry.version <= LEGACY_VERSIONS[1]
}

/**
 * Take `key` out of the old layout, if it is still there — once a list has been
 * written the new way, the copy from before would only come back to haunt the
 * fallback reader.
 */
async function forgetLegacy(key: string): Promise<void> {
  const legacy = await readLegacy()
  if (!(key in legacy))
    return
  delete legacy[key]
  if (Object.keys(legacy).length)
    await browser.storage.local.set({ [LEGACY_SNAPSHOTS_KEY]: legacy })
  else
    await browser.storage.local.remove(LEGACY_SNAPSHOTS_KEY)
}

// ---------------------------------------------------------------------------
// Reading.
// ---------------------------------------------------------------------------

/** Read a stored list and its works, or null if there is none this build can draw. */
export async function readSnapshot(key: string): Promise<CachedSnapshot | null> {
  const lists = await cache.get('searchLists')
  const list = lists[key]
  if (!list) {
    // Not migrated yet — the background's migration runs on update, and a page
    // can open a list before it gets there.
    const entry = (await readLegacy())[key]
    return legacyReadable(entry)
      ? { scrapedAt: entry.scrapedAt, works: worksFromHtml(entry.blurbsHtml), descriptor: entry.descriptor, missing: 0 }
      : null
  }
  if (!readable(list))
    return null
  const ids = unpackOrderedIds(list.ids)
  const { works, missing, stale } = worksFromRecords(ids, await readRecords(ids), list.ctx)
  if (stale.length)
    void rewriteStale(stale).catch(err => console.error('[searchView] could not rewrite stored blurbs', err))
  return { scrapedAt: list.scrapedAt, works, descriptor: list.descriptor, missing: missing.length }
}

/**
 * A stored list's works as parsed data only — no nodes built, no markup read
 * for a work whose parsed half is current. For a caller that wants titles and
 * numbers, like the export job's queue.
 */
export async function readSnapshotData(key: string): Promise<{ scrapedAt: number, descriptor?: SnapshotDescriptor, works: ParsedWork[] } | null> {
  const lists = await cache.get('searchLists')
  const list = lists[key]
  if (!list) {
    const snapshot = await readSnapshot(key)
    return snapshot && { scrapedAt: snapshot.scrapedAt, descriptor: snapshot.descriptor, works: snapshot.works }
  }
  if (!readable(list))
    return null
  return { scrapedAt: list.scrapedAt, descriptor: list.descriptor, works: await readParsed(unpackOrderedIds(list.ids)) }
}

/**
 * Every readable list, newest first — what the options page lists. Metadata
 * only: reading the blurbs of every list the reader has ever opened would cost
 * far more than the one they actually pick.
 */
export async function listSnapshots(): Promise<SnapshotSummary[]> {
  const [lists, legacy, index] = await Promise.all([cache.get('searchLists'), readLegacy(), readBlurbIndex()])
  const out: SnapshotSummary[] = []
  for (const [key, list] of Object.entries(lists)) {
    if (!readable(list))
      continue
    const workIds = unpackOrderedIds(list.ids)
    out.push({
      key,
      scrapedAt: list.scrapedAt,
      count: workIds.length,
      workIds,
      unstored: workIds.filter(id => !index.has(id)).length,
      descriptor: list.descriptor,
    })
  }
  for (const [key, entry] of Object.entries(legacy)) {
    if (key in lists || !legacyReadable(entry))
      continue
    const workIds = [...listedIds({}, { [key]: entry })]
    out.push({ key, scrapedAt: entry.scrapedAt, count: entry.blurbsHtml.length, workIds, unstored: 0, descriptor: entry.descriptor })
  }
  return out.sort((a, b) => b.scrapedAt - a.scrapedAt)
}

/**
 * Every work id any stored list holds, readable or not.
 *
 * The version gate {@link listSnapshots} applies is deliberately *not* applied
 * here, because the question is different. Listing asks "can this build render
 * it"; this asks "does any stored list still hold this work", which is what
 * decides whether its blurb and its cached text are orphans. A list written by a
 * newer build is one the reader kept, and discarding what it holds because this
 * build cannot draw it would be the worst kind of tidying.
 */
export async function snapshotWorkIds(): Promise<Set<string>> {
  const [lists, legacy] = await Promise.all([cache.get('searchLists'), readLegacy()])
  return listedIds(lists, legacy)
}

/**
 * How many works a stored list holds, without reading one blurb.
 *
 * The list entry is ids and nothing else, so this is one small read — which is
 * the point: it answers "is there anything here to lose?" for a caller that is
 * about to overwrite the list ({@link file://./refresh.ts}) and must not pay the
 * cost of loading it to find out.
 */
export async function snapshotSize(key: string): Promise<number> {
  const list = (await cache.get('searchLists'))[key]
  if (list && typeof list.ids === 'string')
    return unpackOrderedIds(list.ids).length
  const entry = (await readLegacy())[key]
  return entry?.blurbsHtml?.length ?? 0
}

// ---------------------------------------------------------------------------
// Writing.
// ---------------------------------------------------------------------------

export interface WriteSnapshotOptions {
  /**
   * This write is not a scrape — a blurb action took one work out of the stored
   * list — so keep the time the list was last actually fetched. That time is
   * what an auto-refresh interval measures and what "as of" displays; a
   * "Mark as Read" click resetting it would put off a real refresh indefinitely.
   */
  keepScrapedAt?: boolean
}

/**
 * Store a list of the given works, in order, plus how to re-fetch the listing
 * later ({@link SnapshotDescriptor}).
 *
 * **Blurbs first, list second**, so a stored list never names a blurb that isn't
 * there: an interrupted write leaves a blurb nothing references, which the
 * orphan discard collects, rather than a list pointing at nothing.
 *
 * Works the store already holds cost nothing to write again, which is what makes
 * the commonest write — a blurb action taking one work out of the list — a
 * rewrite of one small list of ids and nothing else.
 */
export async function writeSnapshot(
  key: string,
  works: Work[],
  descriptor: SnapshotDescriptor,
  opts: WriteSnapshotOptions = {},
): Promise<void> {
  await storeWorks(opts.keepScrapedAt ? works.filter(work => !isPersisted(work)) : works)

  // Read after the blurbs are down, so a list another tab wrote meanwhile is kept.
  // Copied: with nothing stored yet, what comes back is the storage defaults.
  const lists = { ...await cache.get('searchLists') }
  const previous = lists[key]
  const ids = works.map(work => work.workId).filter(Boolean)
  const ctx: { [sid: string]: string } = {}
  for (const work of works) {
    const block = storedContext(work)
    const sid = toShortId(work.workId)
    if (block && sid)
      ctx[sid] = block
  }
  const list: StoredList = {
    v: LIST_VERSION,
    scrapedAt: opts.keepScrapedAt && previous ? previous.scrapedAt : Date.now(),
    ids: packOrderedIds(ids),
    descriptor,
  }
  if (Object.keys(ctx).length)
    list.ctx = ctx
  lists[key] = list
  await cache.set({ searchLists: lists })
  await forgetLegacy(key)

  if (previous && typeof previous.ids === 'string')
    await pruneIfWanted(key, unpackOrderedIds(previous.ids), ids, lists)
}

/**
 * Forget a stored list.
 *
 * Its blurbs stay unless the reader has asked for blurbs nothing holds to go at
 * once ({@link file://../../common/options.ts}'s `pruneOrphanedBlurbs`); either
 * way a blurb another list holds is untouched. The work text never goes with
 * it: that cache is keyed by work too, and the text is hours of requests to AO3
 * where the blurbs are one scrape. Deleting it is its own action, and the narrow
 * version of that action reads its answer from {@link snapshotWorkIds}.
 */
export async function deleteSnapshot(key: string): Promise<void> {
  const lists = { ...await cache.get('searchLists') }
  const previous = lists[key]
  if (previous) {
    delete lists[key]
    await cache.set({ searchLists: lists })
  }
  await forgetLegacy(key)
  // What the list failed to find goes with the list.
  const misses = { ...await cache.get('searchMisses') }
  if (key in misses) {
    delete misses[key]
    await cache.set({ searchMisses: misses })
  }
  if (previous && typeof previous.ids === 'string')
    await pruneIfWanted(key, unpackOrderedIds(previous.ids), [], lists)
}

/** Discard the blurbs a list write stranded, if the reader has asked for that. */
async function pruneIfWanted(key: string, before: string[], after: string[], lists: { [key: string]: StoredList }): Promise<void> {
  if (!await options.get('pruneOrphanedBlurbs'))
    return
  const others = Object.entries(lists).filter(([other]) => other !== key).map(([, list]) => list)
  const candidates = droppedIds(before, after, others)
  if (!candidates.length)
    return
  const referenced = listedIds(lists, await readLegacy())
  await pruneBlurbs(candidates, referenced)
}

// ---------------------------------------------------------------------------
// Misses.
// ---------------------------------------------------------------------------

/**
 * The work ids a source looked for in its listing and did not find, as of its
 * last scrape that could have found them. See the `searchMisses` cache entry.
 */
export async function readMisses(key: string): Promise<Set<string>> {
  const misses = await cache.get('searchMisses')
  return unpackIds(misses[key] ?? '')
}

/** Replace the recorded misses for `key` — the whole set, not an addition to it. */
export async function writeMisses(key: string, ids: Iterable<string>): Promise<void> {
  const misses = { ...await cache.get('searchMisses') }
  const packed = packIds(ids)
  if (packed === (misses[key] ?? ''))
    return
  if (packed)
    misses[key] = packed
  else
    delete misses[key]
  await cache.set({ searchMisses: misses })
}

/**
 * Rebuild `Work[]` from blurb HTML, mounting fresh nodes in the document — for
 * markup that isn't in the store: a site export's blurbs, and a list stored the
 * old way that hasn't been migrated yet.
 */
export function worksFromHtml(blurbsHtml: string[]): Work[] {
  const template = document.createElement('template')
  const works: Work[] = []
  blurbsHtml.forEach((html) => {
    template.innerHTML = html
    const li = template.content.firstElementChild
    if (li instanceof HTMLLIElement) {
      // Stripped on the way in as well as on the way out: markup stored before
      // the write side did so still carries the decorations of every time it was
      // written, and would go on drawing them twice until it was next refreshed.
      pristineBlurb(li, { inPlace: true })
      document.adoptNode(li)
      works.push(parseWork(li, works.length))
    }
  })
  return works
}
