/**
 * Saved lists — every search the reader keeps: a works search, an uncommon
 * tag's works, a series, a filtered listing. Each is a **record** on this
 * browser, with a permanent id, a title, and what it searches. A record never
 * syncs.
 *
 * **Tracking is a synced entry with the same id.** A list is tracked exactly
 * while `trackedLists.lists` holds an entry with its id; the entry carries the
 * list's title and query to every other browser, and that is all that syncs. So
 * a browser sees another's lists only while they are tracked, and a list that
 * stops being tracked stays a saved list wherever it was made.
 *
 * Which of the two holds the truth depends on that: while a list is tracked its
 * entry does, and every change to the entries, made here or pulled, is copied
 * onto the record ({@link planSavedLists}). While it isn't, the record is the
 * only home its title has. Local edits go through the plans below, which write
 * the record, and the entry too when there is one.
 *
 * Import-free but for the tracked-lists module, so it loads under a plain
 * `node --test`.
 */

import type { Day, NormalizedTrackedUrl, TrackedFilter, TrackedKind, TrackedList, TrackedListsOption, TrackedMeta, TrackedQuery, TrackedType } from './trackedLists.ts'

import { defaultTitle, entrySignature, fillMeta, isListId, newTrackedListId, normalizeTrackedUrl, queryOf, requery, sameTitle, titleAfterUpdate, titleTakenBy, trackedKey, trackedMeta, uniqueTitle, withQueryOf } from './trackedLists.ts'

/** One saved list: its identity, and what it searches. */
export interface SavedList {
  /** Permanent: titling, tracking, stopping and saving a refined search back all keep it. Shared with the list's entry while it's tracked. */
  id: string
  kind: TrackedKind
  /** As an entry's: the archive path and normalized query. Kept as it came when it doesn't normalize, and the list is then pending. */
  url: string
  /** Unique among the records, compared trimmed and in any case. `''` is untitled, shown by a placeholder. */
  title: string
  type?: TrackedType
  entity?: string
  filter?: TrackedFilter
  scan?: true
  /**
   * Made from a synced entry, and not touched here since. Such a record held
   * nothing of this browser's own, so when its entry leaves the synced set it
   * goes too, unless this browser keeps a copy of the list. A title, a track, a
   * stop or a save-back made here clears it.
   */
  mirror?: true
}

/**
 * The `savedLists` option: every record, by id. With no `v` it is from before
 * records existed, and the next {@link planSavedLists} is the migration.
 */
export interface SavedListsOption {
  v?: 1
  lists: { [id: string]: SavedList }
}

/** What every plan here reads and returns: the synced entries and the local records. */
export interface ListState {
  tracked: TrackedListsOption
  saved: SavedListsOption
}

/** A stored list, its descriptor flattened in. An undescribed one has none of the three. */
export interface StoredListRef {
  key: string
  sourceId?: string
  listUrl?: string
  label?: string
  scrapedAt: number
}

/** The `v` a migrated {@link SavedListsOption} carries. */
export const SAVED_LISTS_VERSION = 1

/**
 * The search views whose stored lists are saved lists. Marked for Later and the
 * read list aren't: their works are the reader's own choices, not a search's.
 * Nor is the review's window, which is gathered from every tracked list at once.
 */
export const SAVED_LIST_SOURCE_IDS: readonly string[] = ['text-search', 'tag-works', 'series-works']

/**
 * A list's address: its normalized key without the view filter. Copies join
 * records by it, so a filtered list and the copy of its page are one list, and
 * two lists filtering one search share that copy. Null when the URL isn't a list
 * on the archive.
 */
export function addressOf(url: string | undefined): string | null {
  return typeof url === 'string' ? normalizeTrackedUrl(url)?.key ?? null : null
}

/**
 * What a stored list is, for a saved list made from it: what its address says,
 * plus a series' title, which a stored series' own label carries ("Series: …")
 * and its address can't.
 */
export function storedListMeta(url: string, label: string): TrackedMeta {
  const meta = trackedMeta({ url })!
  const title = meta.type === 'series' ? /^Series: (.+)$/.exec(label.trim())?.[1] : undefined
  const filled = title ? fillMeta({ url }, { type: 'series', entity: title }) : null
  return filled ? { type: filled.type ?? meta.type, entity: filled.entity ?? meta.entity } : meta
}

/**
 * The stored lists as the planner reads them, from `cache.searchLists` as
 * storage holds it: each one's key and when it was read, and its descriptor's
 * source, address and label where it has them. Anything that isn't a list is
 * left out.
 */
export function storedListRefs(searchLists: unknown): StoredListRef[] {
  if (!isObject(searchLists))
    return []
  const refs: StoredListRef[] = []
  for (const [key, list] of Object.entries(searchLists)) {
    if (!isObject(list))
      continue
    const ref: StoredListRef = { key, scrapedAt: typeof list.scrapedAt === 'number' ? list.scrapedAt : 0 }
    const descriptor = list.descriptor
    if (isObject(descriptor)) {
      for (const field of ['sourceId', 'listUrl', 'label'] as const) {
        if (typeof descriptor[field] === 'string')
          ref[field] = descriptor[field]
      }
    }
    refs.push(ref)
  }
  return refs
}

/** What {@link planSavedLists} makes of a state, and which of its halves need writing. */
export interface SavedListsPlan {
  state: ListState
  changed: { tracked: boolean, saved: boolean }
}

/**
 * The options to write once a plan given `before` has returned `next`: only the
 * halves it changed. Every plan here hands back a half it left alone as it was
 * given, so a plan that touched only the records writes nothing that syncs,
 * and one that changed nothing writes nothing at all.
 */
export function savedListsWrite(before: ListState, next: ListState): { trackedLists?: TrackedListsOption, savedLists?: SavedListsOption } {
  return {
    ...(next.tracked !== before.tracked ? { trackedLists: next.tracked } : {}),
    ...(next.saved !== before.saved ? { savedLists: next.saved } : {}),
  }
}

/** A saved list as the title and label helpers of `trackedLists.ts` read a list: its title as an alias. */
export function aliasOf(list: SavedList): Pick<TrackedList, 'id' | 'alias' | 'url' | 'type' | 'entity'> {
  return { id: list.id, alias: list.title, url: list.url, type: list.type, entity: list.entity }
}

/**
 * Bring the records and the entries into agreement. It is the migration and the
 * ongoing reconciliation both, and running it on its own output changes nothing.
 *
 * 1. An entry that isn't tracked leaves the synced set: a paused one from
 *    before records existed, or one a restore or an import brought back. Its
 *    fields go onto the record with its id, which is made if missing.
 * 2. Every remaining entry is mirrored onto the record with its id: the record
 *    is made if missing (a mirror, see {@link SavedList.mirror}), or its query
 *    and title are overwritten.
 * 3. A mirror whose id has left the synced set (its tracking stopped, or it was
 *    removed, on another browser) stays as a saved list here if this browser
 *    holds a copy at its address, and no longer as a mirror. Otherwise it goes.
 * 4. A stored list from a search view that keeps saved lists, at an address no
 *    record has, gets a record: a new id, untitled. Of several copies at one
 *    address, the newest says what the record searches.
 *
 * Nothing else is removed. A legacy state (no `v`) is migrated: it makes no
 * mirrors, because its entries may well have been made on this browser, and
 * comes out stamped with {@link SAVED_LISTS_VERSION}.
 */
export function planSavedLists(state: ListState, stored: readonly StoredListRef[]): SavedListsPlan {
  const legacy = typeof state.saved?.v !== 'number'
  const before = recordsOf(state)
  const entries = entriesOf(state)
  const next: { [id: string]: SavedList } = { ...before }

  const synced = entries.filter(entry => !isEntry(entry) || entry.tracked === true)
  for (const entry of entries) {
    if (isEntry(entry) && entry.tracked !== true)
      next[entry.id] = recordFrom(entry, own(next, entry.id), false)
  }

  const syncedIds = new Set<string>()
  for (const entry of synced) {
    if (!isEntry(entry))
      continue
    syncedIds.add(entry.id)
    const existing = own(next, entry.id)
    next[entry.id] = recordFrom(entry, existing, existing ? existing.mirror === true : !legacy)
  }

  const copies = addressed(stored)
  for (const [id, record] of Object.entries(next)) {
    if (!isListId(id) || record?.mirror !== true || syncedIds.has(id))
      continue
    if (copiesAt(addressOf(record.url), copies).length)
      next[id] = withoutMirror(record)
    else
      delete next[id]
  }

  const taken = new Set(Object.values(next).map(record => addressOf(record?.url)))
  const ids = [...Object.keys(next), ...entries.filter(isEntry).map(entry => entry.id)].map(id => ({ id }))
  for (const { copy, address } of [...copies].sort(newestFirst)) {
    if (address === null || taken.has(address) || !SAVED_LIST_SOURCE_IDS.includes(copy.sourceId ?? ''))
      continue
    const id = newTrackedListId(ids)
    next[id] = { id, ...copyQuery(normalizeTrackedUrl(copy.listUrl!)!, copy.label), title: '' }
    ids.push({ id })
    taken.add(address)
  }

  const changed = { tracked: synced.length !== entries.length, saved: legacy || !sameRecords(before, next) }
  return {
    state: {
      tracked: changed.tracked ? { ...state.tracked, lists: synced } : state.tracked,
      saved: changed.saved ? { ...state.saved, v: legacy ? SAVED_LISTS_VERSION : state.saved.v, lists: next } : state.saved,
    },
    changed,
  }
}

/** A saved list, and its entry while it is tracked. */
export interface SavedListState {
  list: SavedList
  entry: TrackedList | null
}

/**
 * Every saved list, each with its entry while it is tracked: the records, then
 * any entry the planner hasn't filed a record for yet, read as the record it
 * will make of it. An entry that isn't tracked is a saved list's, not a
 * tracked one's.
 */
export function savedListsOf(state: ListState): SavedListState[] {
  const records = recordsOf(state)
  const tracked = new Map<string, TrackedList>()
  for (const entry of entriesOf(state)) {
    if (isEntry(entry) && entry.tracked === true && !tracked.has(entry.id))
      tracked.set(entry.id, entry)
  }
  const out: SavedListState[] = []
  const seen = new Set<string>()
  for (const [id, record] of Object.entries(records)) {
    if (!isListId(id) || !isRecord(record))
      continue
    seen.add(id)
    out.push({ list: record, entry: tracked.get(id) ?? null })
  }
  for (const entry of entriesOf(state)) {
    if (!isEntry(entry) || seen.has(entry.id))
      continue
    seen.add(entry.id)
    out.push({ list: recordFrom(entry, undefined, false), entry: entry.tracked === true ? entry : null })
  }
  return out
}

/**
 * The saved list that searches exactly `key` (a {@link trackedKey}, view filter
 * and all) and isn't tracked: the list that tracking that search tracks. Null
 * when there's none, or no key.
 */
export function savedListAt(state: ListState, key: string | null): SavedList | null {
  if (key === null)
    return null
  return savedListsOf(state).find(({ list, entry }) => !entry && trackedKey(list) === key)?.list ?? null
}

/**
 * Give list `id` a title, trimmed: on its record, and on its entry while it is
 * tracked, since the entry is what carries a title to the other browsers. It
 * never tracks or stops tracking anything. An entry with no record yet gets one.
 *
 * Refused, naming the list, when another list has the title. Untitled (`''`)
 * is never taken. Committing the title the list already has changes nothing, so
 * a mirror stays one; and a list that is gone is left gone.
 */
export function planRetitle(state: ListState, id: string, title: string): { ok: true, state: ListState } | { ok: false, takenBy: SavedList } {
  const entries = entriesOf(state)
  const entry = entries.find(one => isEntry(one) && one.id === id)
  const record = own(recordsOf(state), id) ?? (entry ? recordFrom(entry, undefined, false) : undefined)
  const trimmed = typeof title === 'string' ? title.trim() : ''
  if (!record || record.title === trimmed)
    return { ok: true, state }
  const taken = titleTakenBy(trimmed, titled(allLists(state)), id)
  if (taken)
    return { ok: false, takenBy: taken.list }
  const tracked = entry
    ? { ...state.tracked, lists: entries.map(one => (one === entry ? { ...one, alias: trimmed } : one)) }
    : state.tracked
  return { ok: true, state: { tracked, saved: withRecord(state, { ...withoutMirror(record), title: trimmed }) } }
}

/**
 * Track list `id`: an entry made from its record, tracked from `today`, so
 * nothing from before is backfilled. The record already holds everything else.
 *
 * Refused, naming it, when another tracked list is the same search with the same
 * view filter: the review would read it twice. A list already tracked, or gone,
 * is left as it is.
 */
export function planTrack(state: ListState, id: string, today: Day): { ok: true, state: ListState } | { ok: false, twin: TrackedList } {
  const record = own(recordsOf(state), id)
  const entries = entriesOf(state)
  if (!record || entries.some(entry => isEntry(entry) && entry.id === id))
    return { ok: true, state }
  const key = trackedKey(record)
  const twin = key === null ? undefined : entries.find(entry => isEntry(entry) && trackedKey(entry) === key)
  if (twin)
    return { ok: false, twin }
  const entry: TrackedList = { id, ...queryOf(record), alias: record.title, tracked: true, since: today }
  return {
    ok: true,
    state: {
      tracked: { ...state.tracked, lists: [...entries, entry] },
      saved: record.mirror ? withRecord(state, withoutMirror(record)) : state.saved,
    },
  }
}

/** A search tracked as a list ({@link planTrackSearch}), or why it can't be, naming the list responsible. */
export type TrackSearchPlan
  = | { ok: true, state: ListState, id: string }
    | { ok: false, twin: TrackedList }
    | { ok: false, takenBy: SavedList }

/**
 * Track the search `query` under `title`, trimmed. The saved list that is
 * exactly that search ({@link savedListAt}) is the one tracked, under its own
 * id, taking `query` and the title; with none, it is a new list, a record and
 * its entry under one new id. Either way the record is this browser's own.
 *
 * Refused when another tracked list is the same search (`twin`), and when
 * another list has the title (`takenBy`).
 */
export function planTrackSearch(state: ListState, query: TrackedQuery, title: string, today: Day): TrackSearchPlan {
  const existing = savedListAt(state, trackedKey(query))
  const id = existing?.id ?? newTrackedListId(allLists(state))
  const trimmed = typeof title === 'string' ? title.trim() : ''
  const taken = titleTakenBy(trimmed, titled(allLists(state)), id)
  if (taken)
    return { ok: false, takenBy: taken.list }
  const record: SavedList = withoutMirror({ ...withQueryOf(existing ?? {}, query), id, title: trimmed })
  const plan = planTrack({ tracked: state.tracked, saved: withRecord(state, record) }, id, today)
  return plan.ok ? { ok: true, state: plan.state, id } : plan
}

/**
 * Track the list a stored copy is: the saved list that is exactly its search,
 * under its own id, title and query — or with none, a new one, made as the
 * planner makes one for a copy. A list with no title takes the search's
 * default, made unique.
 *
 * Null for a copy that isn't a saved list's: undescribed, from a view that
 * keeps no saved lists, or not at an address on the archive.
 */
export function planTrackCopy(state: ListState, copy: StoredListRef, today: Day): TrackSearchPlan | null {
  const normalized = SAVED_LIST_SOURCE_IDS.includes(copy.sourceId ?? '') ? normalizeTrackedUrl(copy.listUrl ?? '') : null
  if (!normalized)
    return null
  const existing = savedListAt(state, normalized.key)
  const query = existing ? queryOf(existing) : copyQuery(normalized, copy.label)
  const title = (typeof existing?.title === 'string' ? existing.title.trim() : '')
    || uniqueTitle(defaultTitle(trackedMeta(query) ?? storedListMeta(normalized.url, copy.label ?? '')), titled(allLists(state)), existing?.id)
  return planTrackSearch(state, query, title, today)
}

/**
 * Stop tracking list `id`: its entry goes, so it no longer syncs, and its record
 * stays on this browser as a saved list. An entry with no record yet gets one
 * first, so nothing of it is lost.
 */
export function planStopTracking(state: ListState, id: string): ListState {
  const entries = entriesOf(state)
  const entry = entries.find(one => isEntry(one) && one.id === id)
  if (!entry)
    return state
  const record = own(recordsOf(state), id)
  return {
    tracked: { ...state.tracked, lists: entries.filter(one => !(isEntry(one) && one.id === id)) },
    saved: record && !record.mirror ? state.saved : withRecord(state, record ? withoutMirror(record) : recordFrom(entry, undefined, false)),
  }
}

/**
 * Remove list `id` altogether: its record and its entry. `dropCopies` are the
 * keys of every stored list at its address, newest first, for the caller to
 * delete, unless another record at that address still claims them. One search
 * stored in several sort orders is several copies at one address, and a copy
 * left behind would come back as an untitled list of its own.
 */
export function planRemoveList(state: ListState, id: string, stored: readonly StoredListRef[]): { state: ListState, dropCopies: string[] } {
  const records = recordsOf(state)
  const record = own(records, id)
  const entries = entriesOf(state)
  const entry = entries.find(one => isEntry(one) && one.id === id)
  if (!record && !entry)
    return { state, dropCopies: [] }

  const rest = { ...records }
  delete rest[id]
  const address = addressOf((record ?? entry)!.url)
  const shared = address !== null && listed(rest).some(other => addressOf(other.url) === address)
  return {
    state: {
      tracked: entry ? { ...state.tracked, lists: entries.filter(one => !(isEntry(one) && one.id === id)) } : state.tracked,
      saved: record ? { ...state.saved, lists: rest } : state.saved,
    },
    dropCopies: shared ? [] : copiesAt(address, addressed(stored)).map(copy => copy.key),
  }
}

/** The search a refined page is, for {@link planSaveBack}. */
export interface SaveBackPage {
  /** The page's address, as the reader has it; normalized on the way in. */
  url: string
  kind: TrackedKind
  /** What the page says the list now is. */
  meta: TrackedMeta
  filter?: TrackedFilter
  /** `tag-works` only: what checking the page's tag afresh found. Absent, the list keeps its own. */
  scan?: boolean
  /** A title typed for the list; blank means the new search's default. Absent, see {@link titleAfterUpdate}. */
  title?: string
}

/** A save-back that can be made, or why it can't, naming the list responsible. */
export type SaveBackPlan
  = | { ok: true, state: ListState, dropCopies: string[], absorbed: SavedList | null }
    | { ok: false, reason: 'missing' | 'invalid' }
    | { ok: false, reason: 'duplicate', other: TrackedList }
    | { ok: false, reason: 'title', other: SavedList }

/**
 * Save a refined search back to list `id`: the same list, searching what the
 * page does. Its record is rewritten in place under the same id, and its entry
 * too while it is tracked, keeping its tracking start. Nothing syncs for a list
 * that isn't tracked.
 *
 * - **The title** stays, unless it was the default for a root the search has
 *   left ({@link titleAfterUpdate}), or the caller passes one.
 * - **`absorbed`**: opening the search view on the refined page stored a copy
 *   at its address, and that copy got a record of its own — untitled, untracked,
 *   with no view filter. That record is removed, so the list doesn't show twice.
 *   A record at the address that is any more than that is a list of its own,
 *   and stays.
 * - **`dropCopies`**: when the address changed, every copy at the old one,
 *   newest first, for the caller to detach, unless another list is still there.
 *   A copy left behind would come back as an untitled list at the old address.
 *   A change of view filter alone keeps the address, so it drops nothing.
 *
 * Refused when the list is gone (`missing`), when the page isn't a list of the
 * kind given (`invalid`), when a tracked list would become another tracked
 * list's twin (`duplicate`), and when a title typed for it is another list's
 * (`title`).
 */
export function planSaveBack(state: ListState, id: string, page: SaveBackPage, stored: readonly StoredListRef[]): SaveBackPlan {
  const records = recordsOf(state)
  const before = own(records, id)
  if (!before)
    return { ok: false, reason: 'missing' }
  const query = requery(before, { url: page.url, filter: page.filter, meta: page.meta, scan: page.scan })
  if (!query || query.kind !== page.kind)
    return { ok: false, reason: 'invalid' }

  const entries = entriesOf(state)
  const entry = entries.find(one => isEntry(one) && one.id === id)
  if (entry) {
    const key = trackedKey(query)
    const twin = entries.find(one => isEntry(one) && one.id !== id && trackedKey(one) === key)
    if (twin)
      return { ok: false, reason: 'duplicate', other: twin }
  }

  const oldAddress = addressOf(before.url)
  const newAddress = addressOf(query.url)
  const absorbed = oldAddress === newAddress
    ? null
    : listed(records).find(other => other.id !== id
      && addressOf(other.url) === newAddress
      && sameTitle(other.title, '')
      && !other.filter
      && !entries.some(one => isEntry(one) && one.id === other.id)) ?? null

  const others = titled(listed(records).filter(other => other !== absorbed))
  const title = typeof page.title === 'string'
    ? page.title.trim() || uniqueTitle(defaultTitle(page.meta), others, id)
    : titleAfterUpdate({ ...before, alias: before.title }, query.url, page.meta, others)
  if (!sameTitle(title, before.title)) {
    const taken = titleTakenBy(title, others, id)
    if (taken)
      return { ok: false, reason: 'title', other: taken.list }
  }

  const lists = { ...records, [id]: withoutMirror(withQueryOf({ ...before, title }, query)) }
  if (absorbed)
    delete lists[absorbed.id]
  const stillThere = listed(lists).some(other => addressOf(other.url) === oldAddress)
  const dropCopies = oldAddress !== newAddress && !stillThere
    ? copiesAt(oldAddress, addressed(stored)).map(copy => copy.key)
    : []
  return {
    ok: true,
    state: {
      tracked: entry
        ? { ...state.tracked, lists: entries.map(one => (one === entry ? { ...withQueryOf(entry, query), alias: title } : one)) }
        : state.tracked,
      saved: { ...state.saved, lists },
    },
    dropCopies,
    absorbed,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function recordsOf(state: ListState): { [id: string]: SavedList } {
  const lists = state.saved?.lists
  return typeof lists === 'object' && lists !== null ? lists : {}
}

function entriesOf(state: ListState): readonly TrackedList[] {
  const lists = state.tracked?.lists
  return Array.isArray(lists) ? lists : []
}

/** An entry with an id a record can be filed under. Anything else in the entries is left where it is. */
function isEntry(value: unknown): value is TrackedList {
  return typeof value === 'object' && value !== null && isListId((value as TrackedList).id)
}

/** The records, leaving out anything else storage handed back under the option. */
function listed(records: { [id: string]: SavedList }): SavedList[] {
  return Object.values(records).filter(isRecord)
}

function isRecord(value: unknown): value is SavedList {
  return typeof value === 'object' && value !== null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Every saved list's record, and the record each entry with none yet will have: what titles and new ids are unique among. */
function allLists(state: ListState): SavedList[] {
  return savedListsOf(state).map(({ list }) => list)
}

/** What a stored copy at `normalized` searches, for a saved list made from it. */
function copyQuery(normalized: NormalizedTrackedUrl, label: string | undefined): TrackedQuery {
  const meta = storedListMeta(normalized.url, label ?? '')
  return { kind: normalized.kind, url: normalized.url, type: meta.type, ...(meta.entity ? { entity: meta.entity } : {}) }
}

/** The record filed under `id`, never something inherited, whatever the id spells. */
function own(records: { [id: string]: SavedList }, id: string): SavedList | undefined {
  return Object.hasOwn(records, id) ? records[id] : undefined
}

/** The record an entry makes: its query and title, over whatever else `existing` holds. */
function recordFrom(entry: TrackedList, existing: SavedList | undefined, mirror: boolean): SavedList {
  const record: SavedList = withQueryOf({ ...existing, id: entry.id, title: typeof entry.alias === 'string' ? entry.alias : '' }, entry)
  return mirror ? { ...record, mirror: true } : withoutMirror(record)
}

function withoutMirror(record: SavedList): SavedList {
  const out = { ...record }
  delete out.mirror
  return out
}

/** The records with `record` filed under its id. */
function withRecord(state: ListState, record: SavedList): SavedListsOption {
  return { ...state.saved, lists: { ...recordsOf(state), [record.id]: record } }
}

/** Records as the title helpers read lists, their title as an alias, each with its record. */
function titled(records: readonly SavedList[]): { id: string, alias: string, list: SavedList }[] {
  return records.map(list => ({ id: list.id, alias: list.title, list }))
}

interface AddressedCopy { copy: StoredListRef, address: string | null }

function addressed(stored: readonly StoredListRef[]): AddressedCopy[] {
  return stored.map(copy => ({ copy, address: addressOf(copy.listUrl) }))
}

/** Every copy stored at `address`, newest first: the first is the one a list there claims. */
function copiesAt(address: string | null, copies: readonly AddressedCopy[]): StoredListRef[] {
  return address === null ? [] : copies.filter(one => one.address === address).sort(newestFirst).map(one => one.copy)
}

/** Whether `a` was read after `b`, or by key between two read at once, so the order never depends on the input's. */
function newer(a: StoredListRef, b: StoredListRef): boolean {
  return a.scrapedAt !== b.scrapedAt ? a.scrapedAt > b.scrapedAt : a.key < b.key
}

function newestFirst(a: AddressedCopy, b: AddressedCopy): number {
  return newer(a.copy, b.copy) ? -1 : newer(b.copy, a.copy) ? 1 : 0
}

function sameRecords(a: { [id: string]: SavedList }, b: { [id: string]: SavedList }): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length
    && keys.every(key => Object.hasOwn(b, key) && signature(a[key]) === signature(b[key]))
}

function signature(record: unknown): string {
  return isRecord(record) ? entrySignature(record) : JSON.stringify(record) ?? ''
}
