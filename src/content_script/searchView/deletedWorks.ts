import type { DeletedWork, ListedEntry } from '#common'
import type { Work } from '#content_script/blurb.js'

import { cache, fromShortId, isReadingsListing, planDeleted, readingFacts, toShortId } from '#common'
import { hasNode } from '#content_script/blurb.js'

import { storedContext } from './blurbStore.ts'

/**
 * The storage half of keeping works AO3 has deleted on the lists that held them
 * (the rules are `common/deletedWorks.ts`'s): reading and writing the record of
 * deleted works, and putting a read's deleted works back on the list it stores.
 *
 * Imports no `host.tsx`, so the options page's refresh can use it.
 */

/** Every work recorded as deleted, by work id. */
export async function readDeletedWorks(): Promise<Map<string, DeletedWork>> {
  const known = new Map<string, DeletedWork>()
  for (const [sid, record] of Object.entries(await cache.get('deletedWorks'))) {
    const id = fromShortId(sid)
    if (id)
      known.set(id, record)
  }
  return known
}

/**
 * Record works as deleted that their own page says don't exist, keeping the
 * record of any already noticed. Returns every one's record.
 */
export async function recordDeleted(ids: readonly string[], now: number = Date.now()): Promise<Map<string, DeletedWork>> {
  const records = { ...await cache.get('deletedWorks') }
  const out = new Map<string, DeletedWork>()
  let changed = false
  for (const id of ids) {
    const sid = toShortId(id)
    if (!sid)
      continue
    if (!records[sid]) {
      records[sid] = { at: now }
      changed = true
    }
    out.set(id, records[sid])
  }
  if (changed)
    await cache.set({ deletedWorks: records })
  return out
}

/** Stamp each work with its record as deleted, or take a stale one off. */
export function stampDeleted(works: readonly Work[], known: ReadonlyMap<string, DeletedWork>): void {
  for (const work of works) {
    const record = known.get(work.workId)
    if (record)
      work.deleted = record
    else
      delete work.deleted
  }
}

/** Not a work: a readings page's "Deleted work" entry ({@link Work.deletedEntry}). */
export function isDeletedEntry(work: Work): boolean {
  return !!work.deletedEntry
}

/** A listing's "Deleted work" entries, each after the work listed before it. */
export function entriesOf(listing: readonly Work[]): ListedEntry[] {
  const entries: ListedEntry[] = []
  let after: string | null = null
  for (const work of listing) {
    if (work.deletedEntry)
      entries.push({ after, entry: work.deletedEntry })
    else if (work.workId)
      after = work.workId
  }
  return entries
}

/** The readings block a work carries: the list's own, or the one still on its node. */
function readingBlock(work: Work): string | undefined {
  return storedContext(work)
    ?? (hasNode(work) ? work.el.querySelector(':scope > div.user.module.group')?.outerHTML : undefined)
}

export interface KeepDeletedOptions {
  /** The listing read, which says whether it shows its deleted works. */
  listUrl: string
  /** The works the read will store, in order. */
  works: readonly Work[]
  /** The listing as scraped, "Deleted work" entries included. */
  listing: readonly Work[]
  /** The works the copy held before the read: asked for only when there may be deleted works to keep. */
  held: () => readonly Work[] | Promise<readonly Work[]>
  /** Whether a held work still belongs on the list (the source's `select` and `belongs`). */
  keep?: (work: Work) => boolean
  now?: number
}

/**
 * The works a read stores, with the deleted works it keeps put back where they
 * stood and every work stamped with its record as deleted, or not. Records the
 * works newly noticed, and forgets those the read found back on AO3.
 */
export async function keepDeletedWorks(opts: KeepDeletedOptions): Promise<Work[]> {
  const { listUrl, listing, held, keep, now = Date.now() } = opts
  const works = opts.works.filter(work => !isDeletedEntry(work))
  const entries = entriesOf(listing)
  const known = await readDeletedWorks()
  if (!entries.length && !known.size)
    return works

  const kept = (await held()).filter(work => work.workId && !isDeletedEntry(work) && (!keep || keep(work)))
  const plan = planDeleted({
    order: works.map(work => work.workId),
    seen: listing.flatMap(work => (work.workId && !isDeletedEntry(work) ? [work.workId] : [])),
    entries,
    held: kept.map(work => ({ id: work.workId, ...readingFacts(readingBlock(work)) })),
    known: Object.fromEntries(known),
    entriesShown: isReadingsListing(listUrl),
    now,
  })

  const byId = new Map<string, Work>()
  for (const work of [...kept, ...works])
    byId.set(work.workId, work)
  const out = plan.order.flatMap(id => byId.get(id) ?? [])
  stampDeleted(out, new Map(Object.entries(plan.deleted)))
  out.forEach((work, index) => {
    work.markedOrder = index
  })

  if (Object.keys(plan.noticed).length || plan.revived.length) {
    const records = { ...await cache.get('deletedWorks') }
    for (const [id, record] of Object.entries(plan.noticed))
      records[toShortId(id)!] = record
    for (const id of plan.revived)
      delete records[toShortId(id)!]
    await cache.set({ deletedWorks: records })
  }
  return out
}
