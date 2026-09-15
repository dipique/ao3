import type { BlurbMeta, BlurbOrphanPlan, BlurbSource, StoredBlurbHtml } from '#common'
import type { Blurb, Work } from '#content_script/blurb.js'

import {
  BLURB_DATA_PREFIX,
  BLURB_INDEX_KEY,
  BLURB_PREFIX,
  blurbDataKey,
  blurbKey,
  decideBlurbWrite,
  hashBlurbHtml,
  htmlBytes,
  idFromBlurbKey,
  isContextInvalidatedError,
  isExtensionContextValid,
  packIds,
  PARSE_VERSION,
  planBlurbOrphans,
  toShortId,
  unpackIds,
} from '#common'
import { defineLazyNode, getBlurb, parseWork, rememberBlurb } from '#content_script/blurb.js'

import { normalizeBlurb, pristineBlurb } from './pristine.ts'

/**
 * The shared blurb store: one blurb per work, however many stored lists hold
 * it. The layout and the rules it is written by are in
 * {@link file://../../common/blurbRecord.ts}; this is the half that touches
 * `storage.local` and the DOM.
 *
 * **Import discipline.** Like {@link file://./refresh.ts}, this imports the
 * blurb parser and nothing from the host or the units, so the options page can
 * read and write lists without dragging the content script in with it.
 */

const PARSED_FIELDS = [
  'workId',
  'title',
  'authors',
  'summaryText',
  'language',
  'words',
  'chapters',
  'complete',
  'kudos',
  'hits',
  'comments',
  'bookmarks',
  'dateUpdated',
  'dateText',
  'fandoms',
  'rating',
  'warnings',
  'categories',
  'relationships',
  'characters',
  'freeforms',
  'restricted',
] as const satisfies readonly (keyof Work)[]

/** Everything `parseWork` reads that belongs to the work, not to a list or a page load. */
export type ParsedWork = Pick<Work, typeof PARSED_FIELDS[number]>

/**
 * `getBlurb`'s reading, less the authors — which are `parseWork`'s without
 * their display text. Stored verbatim rather than derived from {@link ParsedWork}
 * because the two parsers disagree in small ways (warnings, untrimmed language),
 * and every consumer should go on seeing exactly what it sees on a live page.
 */
export type StoredBlurbFields = Omit<Blurb, 'authors'>

/** What a `blurbData.<sid>` key holds. `work`/`blurb` are absent on a migrated, unparsed record. */
export interface BlurbData extends BlurbMeta {
  work?: ParsedWork
  blurb?: StoredBlurbFields
}

/** A stored blurb as read: either half may be missing. */
export interface BlurbRecord {
  html?: string
  data?: BlurbData
}

/**
 * What the store knows about a work's markup: the normalized html (without the
 * list's block), that block, and the hash. Recorded for every work read from
 * the store or written to it, so writing one back never needs its node.
 */
interface StoredForm {
  html: string
  ctx?: string
  hash: string
  /**
   * The store holds exactly this, parsed with the current parser — nothing to
   * write. False for a work re-parsed from an out-of-date record, which is
   * written back.
   */
  persisted: boolean
}

const forms = new WeakMap<Work, StoredForm>()

/** Works written to storage per `set`. Two keys each. */
const WRITE_CHUNK = 200

/** Where an absolute tag href is pointed, whatever page it was parsed on. */
const ARCHIVE_ORIGIN = 'https://archiveofourown.org'

// ---------------------------------------------------------------------------
// storage.local, the way `createStorage` treats it: an orphaned page reads
// nothing and writes nothing, rather than throwing from every call.
// ---------------------------------------------------------------------------

async function localGet(keys: string | string[] | null): Promise<Record<string, unknown>> {
  if (!isExtensionContextValid())
    return {}
  try {
    return await browser.storage.local.get(keys)
  }
  catch (error) {
    if (isContextInvalidatedError(error))
      return {}
    throw error
  }
}

async function localSet(items: Record<string, unknown>): Promise<void> {
  if (!isExtensionContextValid())
    return
  try {
    await browser.storage.local.set(items)
  }
  catch (error) {
    if (!isContextInvalidatedError(error))
      throw error
  }
}

async function localRemove(keys: string[]): Promise<void> {
  if (!keys.length || !isExtensionContextValid())
    return
  try {
    await browser.storage.local.remove(keys)
  }
  catch (error) {
    if (!isContextInvalidatedError(error))
      throw error
  }
}

async function storageKeys(): Promise<string[]> {
  const area = browser.storage.local as typeof browser.storage.local & { getKeys?: () => Promise<string[]> }
  if (typeof area.getKeys === 'function')
    return await area.getKeys()
  return Object.keys(await localGet(null))
}

/**
 * Serializes this context's index read-modify-writes, so two list writes
 * finishing together don't each drop the other's additions. Across contexts the
 * index can still lose one; it is advisory, and the explicit discard reconciles it.
 */
let indexChain: Promise<unknown> = Promise.resolve()

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexChain.then(fn, fn)
  indexChain = run.then(() => undefined, () => undefined)
  return run
}

// ---------------------------------------------------------------------------
// Parsing and building.
// ---------------------------------------------------------------------------

/** An href as it would read on the archive, whatever origin the node was parsed under. */
function archiveHref(href: string): string {
  try {
    const url = new URL(href)
    return new URL(`${url.pathname}${url.search}${url.hash}`, ARCHIVE_ORIGIN).href
  }
  catch {
    return href
  }
}

function pickParsed(work: ParsedWork): ParsedWork {
  return Object.fromEntries(PARSED_FIELDS.map(field => [field, work[field]])) as ParsedWork
}

function storedBlurbFields(blurb: Blurb): StoredBlurbFields {
  const { authors: _authors, ...rest } = blurb
  return { ...rest, tags: rest.tags.map(tag => tag.href ? { ...tag, href: archiveHref(tag.href) } : tag) }
}

/** The whole blurb back from its stored halves: the authors come from the work. */
function blurbFromData(work: ParsedWork, fields: StoredBlurbFields): Blurb {
  return { ...fields, authors: work.authors.map(({ userId, pseud }) => ({ userId, pseud })) }
}

/** Both parsers over one pristine, normalized node. */
function parseNode(li: HTMLLIElement): { work: ParsedWork, blurb: Blurb } {
  return { work: pickParsed(parseWork(li, 0)), blurb: getBlurb(li) }
}

/**
 * A blurb node from markup, adopted into the page at once: a template's content
 * has no base URL, and the parsers read absolute hrefs.
 */
function fromMarkup(html: string): HTMLLIElement | null {
  const template = document.createElement('template')
  template.innerHTML = html
  const el = template.content.firstElementChild
  return el instanceof HTMLLIElement ? document.adoptNode(el) : null
}

/**
 * The node a stored work is drawn with: its markup, this list's block back on
 * the end, adopted into the page, and the per-load stamps its work carries.
 */
function buildNode(html: string, ctx: string | undefined, work: Work): HTMLLIElement {
  const li = fromMarkup(html) ?? (document.createElement('li') as HTMLLIElement)
  if (ctx) {
    const template = document.createElement('template')
    template.innerHTML = ctx
    const block = template.content.firstElementChild
    if (block)
      li.append(block)
  }
  document.adoptNode(li)
  if (work.filtered)
    li.dataset.ao3eFiltered = ''
  if (work.blurb)
    rememberBlurb(li, work.blurb)
  return li
}

/**
 * The form a work would be stored in. Known without the DOM for a work that
 * came from the store; otherwise read off a pristine copy of its node — which is
 * also when the list's block is split off it.
 */
function formOf(work: Work): StoredForm & { parsed?: { work: ParsedWork, blurb: Blurb } } {
  const known = forms.get(work)
  if (known)
    return known
  const clone = pristineBlurb(work.el)
  const ctx = normalizeBlurb(clone)
  const html = clone.outerHTML
  const parsed = parseNode(clone)
  work.blurb ??= parsed.blurb
  rememberBlurb(work.el, work.blurb)
  const form: StoredForm = { html, ctx, hash: hashBlurbHtml(html), persisted: false }
  forms.set(work, form)
  return { ...form, parsed }
}

// ---------------------------------------------------------------------------
// Reading.
// ---------------------------------------------------------------------------

/** Both halves of every given work's stored blurb, in one read. */
export async function readRecords(ids: readonly string[]): Promise<Map<string, BlurbRecord>> {
  const out = new Map<string, BlurbRecord>()
  if (!ids.length)
    return out
  const raw = await localGet(ids.flatMap(id => [blurbKey(id), blurbDataKey(id)]))
  for (const id of ids) {
    const html = (raw[blurbKey(id)] as StoredBlurbHtml | undefined)?.html
    const data = raw[blurbDataKey(id)] as BlurbData | undefined
    out.set(id, { html: typeof html === 'string' ? html : undefined, data })
  }
  return out
}

export interface StoredWorks {
  /** In the order asked for, `markedOrder` numbered to match. */
  works: Work[]
  /** Ids with no stored markup. */
  missing: string[]
  /** Works re-parsed from an out-of-date record, to be written back ({@link rewriteStale}). */
  stale: Work[]
}

/**
 * Works from stored records, in `ids` order.
 *
 * A record parsed by the current parser becomes a work without touching the
 * DOM: every field comes from its parsed half, and its node is built from the
 * markup the first time something asks for `el`. One parsed by an older parser
 * — or migrated, never parsed — is parsed now, the way a stored list always used
 * to be, and handed back in `stale` to be written back.
 *
 * `ctx` is the list's own markup by short id (see `StoredList.ctx`).
 */
export function worksFromRecords(
  ids: readonly string[],
  records: ReadonlyMap<string, BlurbRecord>,
  ctx?: { [sid: string]: string },
): StoredWorks {
  const result: StoredWorks = { works: [], missing: [], stale: [] }
  for (const id of ids) {
    const record = records.get(id)
    const html = record?.html
    if (html === undefined) {
      result.missing.push(id)
      continue
    }
    const listCtx = ctx?.[toShortId(id) ?? '']
    const data = record!.data
    const markedOrder = result.works.length

    if (data && data.pv === PARSE_VERSION && data.work && data.blurb) {
      const fields: Omit<Work, 'el'> = {
        ...data.work,
        markedOrder,
        seenAt: data.seenAt,
        src: data.src,
        blurb: blurbFromData(data.work, data.blurb),
      }
      const work: Work = defineLazyNode(fields, () => buildNode(html, listCtx, work))
      forms.set(work, { html, ctx: listCtx, hash: data.hash, persisted: true })
      result.works.push(work)
      continue
    }

    const li = fromMarkup(html)
    if (!li) {
      result.missing.push(id)
      continue
    }
    // Stripped on the way in: markup stored before blurbs were shared may still
    // carry decorations, or a readings block, from the list it was stored with.
    pristineBlurb(li, { inPlace: true })
    const split = normalizeBlurb(li)
    const clean = li.outerHTML
    const blurb = getBlurb(li)
    const blockCtx = listCtx ?? split
    const work = parseWork(li, markedOrder)
    if (blockCtx) {
      const template = document.createElement('template')
      template.innerHTML = blockCtx
      const block = template.content.firstElementChild
      if (block)
        li.append(block)
    }
    work.blurb = blurb
    work.seenAt = data?.seenAt ?? 0
    work.src = data?.src ?? 'listing'
    rememberBlurb(li, blurb)
    forms.set(work, { html: clean, ctx: blockCtx, hash: hashBlurbHtml(clean), persisted: false })
    result.works.push(work)
    result.stale.push(work)
  }
  return result
}

/** A work's list block as the store knows it. Undefined for a work never read or written. */
export function storedContext(work: Work): string | undefined {
  return forms.get(work)?.ctx
}

/** Whether the store holds exactly this work's blurb already. */
export function isPersisted(work: Work): boolean {
  return forms.get(work)?.persisted ?? false
}

/**
 * The parsed half of each work, in order, without building a node for any
 * work that doesn't need one — the job runner's context, which wants titles and
 * three numbers. Works with no current parsed half are parsed from their markup.
 */
export async function readParsed(ids: readonly string[]): Promise<ParsedWork[]> {
  if (!ids.length)
    return []
  const raw = await localGet(ids.map(blurbDataKey))
  const unparsed = ids.filter((id) => {
    const data = raw[blurbDataKey(id)] as BlurbData | undefined
    return !(data?.pv === PARSE_VERSION && data.work)
  })
  const html = unparsed.length ? await localGet(unparsed.map(blurbKey)) : {}
  const out: ParsedWork[] = []
  for (const id of ids) {
    const data = raw[blurbDataKey(id)] as BlurbData | undefined
    if (data?.pv === PARSE_VERSION && data.work) {
      out.push(data.work)
      continue
    }
    const markup = (html[blurbKey(id)] as StoredBlurbHtml | undefined)?.html
    const li = markup ? fromMarkup(markup) : null
    if (li)
      out.push(pickParsed(parseWork(pristineBlurb(li, { inPlace: true }), 0)))
  }
  return out
}

/**
 * The stored works among `ids`, for a list that would otherwise fetch them one
 * page each — only those seen within `maxAgeMs`, since a blurb from a list
 * nobody has refreshed in months is no stand-in for the work's own page.
 */
export async function readStoredWorks(ids: readonly string[], maxAgeMs: number, now: number = Date.now()): Promise<Work[]> {
  const records = await readRecords(ids)
  const fresh = ids.filter((id) => {
    const seenAt = records.get(id)?.data?.seenAt ?? 0
    return now - seenAt < maxAgeMs
  })
  const { works, stale } = worksFromRecords(fresh, records)
  if (stale.length)
    void rewriteStale(stale).catch(err => console.error('[searchView] could not rewrite stored blurbs', err))
  return works
}

// ---------------------------------------------------------------------------
// Writing.
// ---------------------------------------------------------------------------

/** Every work id the index says is stored. */
export async function readBlurbIndex(): Promise<Set<string>> {
  const packed = (await localGet(BLURB_INDEX_KEY))[BLURB_INDEX_KEY]
  return unpackIds(typeof packed === 'string' ? packed : '')
}

function updateIndex(add: readonly string[], remove: readonly string[]): Promise<void> {
  if (!add.length && !remove.length)
    return Promise.resolve()
  return serialized(async () => {
    const index = await readBlurbIndex()
    for (const id of add)
      index.add(id)
    for (const id of remove)
      index.delete(id)
    await localSet({ [BLURB_INDEX_KEY]: packIds(index) })
  })
}

async function setChunked(entries: [string, Record<string, unknown>][]): Promise<void> {
  for (let start = 0; start < entries.length; start += WRITE_CHUNK)
    await localSet(Object.assign({}, ...entries.slice(start, start + WRITE_CHUNK).map(([, items]) => items)))
}

/**
 * Store each work's blurb, where it should be ({@link decideBlurbWrite}).
 *
 * Works the store already holds exactly — read back from it, or written by an
 * earlier call — are passed over without a read, so re-storing a list of
 * stored works costs nothing. For the rest, one read of their parsed halves
 * decides, and what changed is written a chunk at a time.
 */
export async function storeWorks(works: readonly Work[], now: number = Date.now()): Promise<void> {
  const pending = new Map<string, Work>()
  for (const work of works) {
    if (work.workId && !pending.has(work.workId) && !isPersisted(work))
      pending.set(work.workId, work)
  }
  if (!pending.size)
    return

  const ids = [...pending.keys()]
  const stored = await localGet(ids.map(blurbDataKey))
  const writes: [string, Record<string, unknown>][] = []
  const inserted: string[] = []
  const settled: Work[] = []

  for (const [id, work] of pending) {
    const form = formOf(work)
    const previous = stored[blurbDataKey(id)] as BlurbData | undefined
    const seenAt = work.seenAt ?? now
    const src: BlurbSource = work.src ?? 'listing'
    const decision = decideBlurbWrite(previous, { seenAt, src, hash: form.hash, work })
    settled.push(work)
    if (decision === 'skip')
      continue
    if (decision === 'touch') {
      writes.push([id, { [blurbDataKey(id)]: { ...previous, seenAt } }])
      continue
    }
    const parsed = 'parsed' in form && form.parsed
      ? form.parsed
      : { work: pickParsed(work), blurb: work.blurb ?? getBlurb(work.el) }
    const data: BlurbData = {
      pv: PARSE_VERSION,
      seenAt,
      src,
      hash: form.hash,
      size: htmlBytes(form.html),
      work: parsed.work,
      blurb: storedBlurbFields(parsed.blurb),
    }
    writes.push([id, { [blurbKey(id)]: { html: form.html } satisfies StoredBlurbHtml, [blurbDataKey(id)]: data }])
    if (decision === 'insert')
      inserted.push(id)
  }

  await setChunked(writes)
  await updateIndex(inserted, [])
  // Written or deliberately not: either way what the store holds for these works
  // is now as good as what this call had, and a second call has nothing to add.
  for (const work of settled) {
    const form = forms.get(work)
    if (form)
      form.persisted = true
  }
}

/** Write back works {@link worksFromRecords} had to re-parse. */
export async function rewriteStale(works: readonly Work[]): Promise<void> {
  await storeWorks(works)
}

/** Forget these works' blurbs — markup, parsed half and index entry. */
export async function removeBlurbs(ids: readonly string[]): Promise<void> {
  if (!ids.length)
    return
  await localRemove(ids.flatMap(id => [blurbKey(id), blurbDataKey(id)]))
  await updateIndex([], ids)
}

// ---------------------------------------------------------------------------
// Orphans.
// ---------------------------------------------------------------------------

async function orphansAmong(candidates: readonly string[], referenced: ReadonlySet<string>, now: number): Promise<BlurbOrphanPlan> {
  const unreferenced = candidates.filter(id => !referenced.has(id))
  if (!unreferenced.length)
    return { ids: [], bytes: 0 }
  const raw = await localGet(unreferenced.map(blurbDataKey))
  const meta = Object.fromEntries(unreferenced.map(id => [id, raw[blurbDataKey(id)] as BlurbData | undefined]))
  return planBlurbOrphans(unreferenced, meta, referenced, now)
}

/**
 * What discarding orphaned blurbs would take, by the index. `referenced` is
 * every work id any stored list holds.
 */
export async function blurbOrphans(referenced: ReadonlySet<string>, now: number = Date.now()): Promise<BlurbOrphanPlan> {
  return orphansAmong([...await readBlurbIndex()], referenced, now)
}

/**
 * Of `ids` — which a list write has just stopped referencing — the ones nothing
 * else references and that are past the grace period, removed.
 */
export async function pruneBlurbs(ids: readonly string[], referenced: ReadonlySet<string>, now: number = Date.now()): Promise<BlurbOrphanPlan> {
  const plan = await orphansAmong(ids, referenced, now)
  await removeBlurbs(plan.ids)
  return plan
}

/**
 * Discard every blurb no stored list holds — the blurb half of "Discard
 * orphans".
 *
 * Sweeps by key as well as by index, since an interrupted write can leave a
 * blurb the index never learned of, and puts the index back in agreement with
 * what is actually stored. Only on an explicit action: listing keys can mean
 * reading every value in `storage.local`.
 */
export async function discardOrphanedBlurbs(referenced: ReadonlySet<string>, now: number = Date.now()): Promise<BlurbOrphanPlan> {
  const keys = await storageKeys()
  const stored = new Set<string>()
  for (const key of keys) {
    if (!key.startsWith(BLURB_PREFIX) && !key.startsWith(BLURB_DATA_PREFIX))
      continue
    const id = idFromBlurbKey(key)
    if (id)
      stored.add(id)
  }
  const index = await readBlurbIndex()
  const plan = await orphansAmong([...new Set([...index, ...stored])], referenced, now)
  await localRemove(plan.ids.flatMap(id => [blurbKey(id), blurbDataKey(id)]))
  await serialized(async () => {
    const removed = new Set(plan.ids)
    await localSet({ [BLURB_INDEX_KEY]: packIds([...stored].filter(id => !removed.has(id))) })
  })
  return plan
}
