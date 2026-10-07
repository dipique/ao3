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
  /**
   * Unique among the records, compared trimmed and in any case, except where
   * sync, or two searches with one default title, have brought two together.
   * Never blank: a list is made under its search's default title
   * ({@link defaultTitleOf}), and a blank title is that default. Only a list
   * whose address yields none can be without one.
   */
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

/** The search view of a filtered listing, and the source its copy is stored under: the listing's own kind. */
export const FILTERED_LISTING_SOURCE_ID = 'works-filter'

/**
 * The search views whose stored lists are saved lists. Marked for Later and the
 * read list aren't: their works are the reader's own choices, not a search's.
 * Nor is the review's window, which is gathered from every tracked list at once.
 */
export const SAVED_LIST_SOURCE_IDS: readonly string[] = ['text-search', 'tag-works', 'series-works', FILTERED_LISTING_SOURCE_ID]

/**
 * A list's address: its normalized key without the view filter. Copies join
 * records by it, so a filtered list and the copy of its page are one list, and
 * two lists filtering one search share that copy. Null when the URL isn't a list
 * on the archive.
 */
export function addressOf(url: string | undefined): string | null {
  return typeof url === 'string' ? normalizeTrackedUrl(url)?.key ?? null : null
}

/** A filtered listing as its search view stores it ({@link filteredListing}). */
export interface FilteredListing {
  /** Where its copy is stored: its address, which starts with its source, as every stored list's key does. */
  key: string
  /** The listing as a saved list holds one, sort and all: a path, for the caller to make absolute. */
  url: string
  /** What it is a listing of, as a list made from it is titled. */
  label: string
}

/**
 * The page at `href` as a filtered listing's search view stores it, or null
 * for any other page: a tag's, an author's, a pseud's or a collection's works.
 *
 * The copy is keyed by the listing's address, so there is one copy of a
 * listing however its address is spelt — the path a link reaches, or the
 * query its Sort & Filter sidebar submits — and whatever it is sorted by or
 * whichever page it is on. A sort changes the order of the works, not which
 * they are. It is also the address its saved list joins it by.
 */
export function filteredListing(href: string): FilteredListing | null {
  const normalized = normalizeTrackedUrl(href)
  if (normalized?.kind !== FILTERED_LISTING_SOURCE_ID)
    return null
  return { key: normalized.key, url: normalized.url, label: defaultTitle(trackedMeta({ url: normalized.url })!) }
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

/**
 * A list's default title: what it is a search of, "Type: entity"
 * ({@link defaultTitle}), as every list is titled when it is made, and wherever
 * it has no title of its own. Not made unique: two searches of one thing share
 * it until the reader retitles one. `''` for an address that isn't a list on
 * the archive, which yields none.
 */
export function defaultTitleOf(list: Pick<SavedList, 'url' | 'type' | 'entity'>): string {
  const meta = trackedMeta(list)
  return meta ? defaultTitle(meta) : ''
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
 *    record has, gets a record: a new id, under its search's default title. Of
 *    several copies at one address, the newest says what the record searches.
 * 5. A list with no title, entry or record, takes its default
 *    ({@link defaultTitleOf}); an entry's syncs. Two lists may so share one: the
 *    reader tells them apart, since nothing is numbered or renamed here.
 *
 * Nothing else is removed. A legacy state (no `v`) is migrated: it makes no
 * mirrors, because its entries may well have been made on this browser, and
 * comes out stamped with {@link SAVED_LISTS_VERSION}.
 */
export function planSavedLists(state: ListState, stored: readonly StoredListRef[]): SavedListsPlan {
  const legacy = typeof state.saved?.v !== 'number'
  const before = recordsOf(state)
  const given = entriesOf(state)
  const entries = given.map(withDefaultAlias)
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

  for (const [id, record] of Object.entries(next)) {
    if (isListId(id) && isRecord(record))
      next[id] = withDefaultTitle(record)
  }

  const taken = new Set(Object.values(next).map(record => addressOf(record?.url)))
  const ids = [...Object.keys(next), ...entries.filter(isEntry).map(entry => entry.id)].map(id => ({ id }))
  for (const { copy, address } of [...copies].sort(newestFirst)) {
    if (address === null || taken.has(address) || !SAVED_LIST_SOURCE_IDS.includes(copy.sourceId ?? ''))
      continue
    const id = newTrackedListId(ids)
    const query = copyQuery(normalizeTrackedUrl(copy.listUrl!)!, copy.label)
    next[id] = { id, ...query, title: defaultTitleOf(query) }
    ids.push({ id })
    taken.add(address)
  }

  const changed = {
    tracked: synced.length !== given.length || synced.some((entry, at) => entry !== given[at]),
    saved: legacy || !sameRecords(before, next),
  }
  return {
    state: {
      tracked: changed.tracked ? { ...state.tracked, lists: synced } : state.tracked,
      saved: changed.saved ? { ...state.saved, v: legacy ? SAVED_LISTS_VERSION : state.saved.v, lists: next } : state.saved,
    },
    changed,
  }
}

/** Where {@link createSavedListsReconciler} reads the lists from, and writes back what the planner changed. */
export interface SavedListsStorage {
  read: () => Promise<{ trackedLists: TrackedListsOption, savedLists: SavedListsOption, searchLists: unknown }>
  write: (update: { trackedLists?: TrackedListsOption, savedLists?: SavedListsOption }) => Promise<void>
}

/**
 * The planner as a background runs it: against what `storage` holds at the
 * time, writing back only the halves it changed, and nothing when nothing did.
 * One run at a time, since each is a read, a plan and a write, and two at once
 * would each write what the other hadn't seen. A run that fails rejects its own
 * promise and leaves the next to run.
 */
export function createSavedListsReconciler(storage: SavedListsStorage): () => Promise<void> {
  let chain: Promise<unknown> = Promise.resolve()
  async function reconcile(): Promise<void> {
    const { trackedLists, savedLists, searchLists } = await storage.read()
    const state = { tracked: trackedLists, saved: savedLists }
    const update = savedListsWrite(state, planSavedLists(state, storedListRefs(searchLists)).state)
    if (Object.keys(update).length)
      await storage.write(update)
  }
  return () => {
    const run = chain.then(reconcile, reconcile)
    chain = run.then(() => {}, () => {})
    return run
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
 * tracked one's. A list with no title is read under its default, as the
 * planner will file it.
 */
export function savedListsOf(state: ListState): SavedListState[] {
  const records = recordsOf(state)
  const entries = entriesOf(state).map(withDefaultAlias)
  const tracked = new Map<string, TrackedList>()
  for (const entry of entries) {
    if (isEntry(entry) && entry.tracked === true && !tracked.has(entry.id))
      tracked.set(entry.id, entry)
  }
  const out: SavedListState[] = []
  const seen = new Set<string>()
  for (const [id, record] of Object.entries(records)) {
    if (!isListId(id) || !isRecord(record))
      continue
    seen.add(id)
    out.push({ list: withDefaultTitle(record), entry: tracked.get(id) ?? null })
  }
  for (const entry of entries) {
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

/** A saved list as it is shown: its entry while tracked, its address, and the offline copy it has there. */
export interface JoinedSavedList {
  list: SavedList
  entry: TrackedList | null
  /** Null for a URL that isn't a list on the archive, which shares an address with nothing. */
  address: string | null
  /** The newest stored list at its address: the list's offline copy, shared with every other list there. */
  copy: StoredListRef | null
  /** The ids of the other saved lists at the same address. */
  sameAddress: string[]
}

/** Every saved list with its copy, and what else is stored: {@link joinSavedLists}. */
export interface SavedListJoin {
  lists: JoinedSavedList[]
  /**
   * Stored lists no saved list is at, the review's window and the profile lists
   * shown on their own aside, newest first: each a list of its own, with no
   * record. An undescribed one, which no visit has given an address; one at no
   * address on the archive; another account's profile list; and a search the
   * planner has yet to give its record.
   */
  copies: StoredListRef[]
  /** The reader's own profile lists ({@link joinSavedLists} says which are theirs). */
  builtins: { markedForLater: StoredListRef | null, readWorks: StoredListRef | null }
  /** The review's own window. */
  review: StoredListRef | null
}

/** The source id of the review's own stored window: gathered from every tracked list at once, it is no saved list. */
export const REVIEW_SOURCE_ID = 'tracked-review'

/**
 * Join the saved lists to what is stored. A list's copy is whatever is stored
 * at its address, which leaves its view filter out: so a filtered list has the
 * copy of its page, and every list at one address shares it. Of several copies
 * there (one search in several sort orders), the newest is the list's, and the
 * rest are its too, so none of them is a list of its own.
 *
 * Marked for Later and Read works are the reader's own when stored under
 * `userId`; with no `userId`, the newest copy of each stands in. Either way an
 * undescribed copy is left among the copies, with any other account's: it can't
 * be refreshed or cached until a visit describes it.
 */
export function joinSavedLists(state: ListState, stored: readonly StoredListRef[], userId?: string): SavedListJoin {
  const known = savedListsOf(state).map(({ list, entry }) => ({ list, entry, address: addressOf(list.url) }))
  const copies = addressed(stored)
  const lists = known.map(one => ({
    ...one,
    copy: copiesAt(one.address, copies)[0] ?? null,
    sameAddress: one.address === null ? [] : known.filter(other => other !== one && other.address === one.address).map(other => other.list.id),
  }))

  const claimed = new Set(known.map(one => one.address))
  const loose = [...copies].sort(newestFirst).filter(one => one.address === null || !claimed.has(one.address)).map(one => one.copy)
  const builtin = (sourceId: string): StoredListRef | null => {
    const all = loose.filter(copy => sourceOf(copy) === sourceId)
    const described = all.filter(copy => copy.sourceId !== undefined)
    return (userId ? described.find(copy => copy.key === `${sourceId}:${userId}`) : described[0]) ?? null
  }
  const builtins = { markedForLater: builtin('marked-for-later'), readWorks: builtin('read-works') }
  const review = loose.find(copy => sourceOf(copy) === REVIEW_SOURCE_ID) ?? null
  const shown = new Set([builtins.markedForLater, builtins.readWorks, review])
  return { lists, copies: loose.filter(copy => !shown.has(copy)), builtins, review }
}

/**
 * The saved list a stored copy stands for, where the copy is shown as a list
 * of its own: of the lists at its address, a tracked one, else the one that is
 * exactly its search, else the first. Null when it is at no list's address.
 */
export function copyOwner(join: SavedListJoin, copy: Pick<StoredListRef, 'listUrl'>): JoinedSavedList | null {
  const address = addressOf(copy.listUrl)
  if (address === null)
    return null
  const at = join.lists.filter(one => one.address === address)
  return at.find(one => one.entry) ?? at.find(one => trackedKey(one.list) === address) ?? at[0] ?? null
}

/**
 * Give list `id` a title, trimmed: on its record, and on its entry while it is
 * tracked, since the entry is what carries a title to the other browsers. It
 * never tracks or stops tracking anything. An entry with no record yet gets one.
 * A blank title is the list's default ({@link defaultTitleOf}).
 *
 * Refused, naming the list, when another list has the title. Committing the
 * title the list already has changes nothing, so a mirror stays one; and a list
 * that is gone is left gone.
 */
export function planRetitle(state: ListState, id: string, title: string): { ok: true, state: ListState } | { ok: false, takenBy: SavedList } {
  const entries = entriesOf(state)
  const entry = entries.find(one => isEntry(one) && one.id === id)
  const record = own(recordsOf(state), id) ?? (entry ? recordFrom(entry, undefined, false) : undefined)
  if (!record)
    return { ok: true, state }
  const trimmed = (typeof title === 'string' ? title.trim() : '') || defaultTitleOf(record)
  if (record.title === trimmed)
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
 * Track list `id`: an entry made from its record, under its title, tracked from
 * `today`, so nothing from before is backfilled. The record already holds
 * everything else; one with no title yet takes its default, as the entry does.
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
  const titled = withDefaultTitle(record)
  const entry: TrackedList = { id, ...queryOf(titled), alias: titled.title, tracked: true, since: today }
  return {
    ok: true,
    state: {
      tracked: { ...state.tracked, lists: [...entries, entry] },
      saved: record.mirror || titled !== record ? withRecord(state, withoutMirror(titled)) : state.saved,
    },
  }
}

/** A search tracked as a list ({@link planTrackSearch}), or why it can't be, naming the list responsible. */
export type TrackSearchPlan
  = | { ok: true, state: ListState, id: string }
    | { ok: false, twin: TrackedList }
    | { ok: false, takenBy: SavedList }

/**
 * Track the search `query` under `title`, trimmed, or blank, its default. The
 * saved list that is exactly that search ({@link savedListAt}) is the one
 * tracked, under its own id, taking `query` and the title; with none, it is a
 * new list, a record and its entry under one new id. Either way the record is
 * this browser's own.
 *
 * Refused when another tracked list is the same search (`twin`), and when the
 * title is a new one for the list and another list has it (`takenBy`): a list
 * keeps its own title as it is tracked, even one it shares.
 */
export function planTrackSearch(state: ListState, query: TrackedQuery, title: string, today: Day): TrackSearchPlan {
  const existing = savedListAt(state, trackedKey(query))
  const id = existing?.id ?? newTrackedListId(allLists(state))
  const trimmed = (typeof title === 'string' ? title.trim() : '') || defaultTitleOf(query)
  const taken = existing && sameTitle(trimmed, existing.title) ? null : titleTakenBy(trimmed, titled(allLists(state)), id)
  if (taken)
    return { ok: false, takenBy: taken.list }
  const record: SavedList = withoutMirror({ ...withQueryOf(existing ?? {}, query), id, title: trimmed })
  const plan = planTrack({ tracked: state.tracked, saved: withRecord(state, record) }, id, today)
  return plan.ok ? { ok: true, state: plan.state, id } : plan
}

/**
 * Track the list a stored copy is ({@link copyOwner}), under its own id, title
 * and query, its view filter included — or with none, a new one, made as the
 * planner makes one for a copy, under the search's default made unique, so the
 * click isn't refused for a title the reader never typed. Refused, naming it,
 * when that list is tracked already.
 *
 * Null for a copy that isn't a saved list's: undescribed, from a view that
 * keeps no saved lists, or not at an address on the archive.
 */
export function planTrackCopy(state: ListState, copy: StoredListRef, today: Day): TrackSearchPlan | null {
  const normalized = SAVED_LIST_SOURCE_IDS.includes(copy.sourceId ?? '') ? normalizeTrackedUrl(copy.listUrl ?? '') : null
  if (!normalized)
    return null
  const owner = copyOwner(joinSavedLists(state, []), copy)
  if (owner?.entry)
    return { ok: false, twin: owner.entry }
  const existing = owner?.list ?? null
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
 * delete, unless another list is still at that address, filed or not. One search
 * stored in several sort orders is several copies at one address, and a copy
 * left behind would come back as a list of its own.
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
  const next: ListState = {
    tracked: entry ? { ...state.tracked, lists: entries.filter(one => !(isEntry(one) && one.id === id)) } : state.tracked,
    saved: record ? { ...state.saved, lists: rest } : state.saved,
  }
  const address = addressOf((record ?? entry)!.url)
  const shared = address !== null && allLists(next).some(other => addressOf(other.url) === address)
  return { state: next, dropCopies: shared ? [] : copiesAt(address, addressed(stored)).map(copy => copy.key) }
}

/**
 * Every copy stored at saved list `id`'s address, newest first: the offline
 * copy its row shows, and any older sort order of its search, which no row
 * shows. Removing the list's offline copy takes them all, or the next newest
 * would stand in for the one removed. A list at no address on the archive, or
 * gone, has none.
 */
export function listCopies(state: ListState, id: string, stored: readonly StoredListRef[]): string[] {
  const list = allLists(state).find(one => one.id === id)
  return copiesAt(addressOf(list?.url), addressed(stored)).map(copy => copy.key)
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
 * that isn't tracked. An entry with no record yet gets one.
 *
 * - **The title** stays, unless it was the default for a root the search has
 *   left ({@link titleAfterUpdate}), or the caller passes one.
 * - **`absorbed`**: opening the search view on the refined page stored a copy
 *   at its address, and that copy got a record of its own — under its default
 *   title, untracked, with no view filter. That record is removed, so the list
 *   doesn't show twice. A record at the address that is any more than that is a
 *   list of its own, and stays.
 * - **`dropCopies`**: when the address changed, every copy at the old one,
 *   newest first, for the caller to detach, unless another list is still there.
 *   A copy left behind would come back as a list of its own at the old address.
 *   A change of view filter alone keeps the address, so it drops nothing.
 *
 * Refused when the list is gone (`missing`), when the page isn't a list of the
 * kind given (`invalid`), when a tracked list would become another tracked
 * list's twin (`duplicate`), and when a title typed for it is another list's
 * (`title`).
 */
export function planSaveBack(state: ListState, id: string, page: SaveBackPage, stored: readonly StoredListRef[]): SaveBackPlan {
  const records = recordsOf(state)
  const entries = entriesOf(state)
  const entry = entryWithId(entries, id)
  const filed = own(records, id) ?? (entry ? recordFrom(entry, undefined, false) : undefined)
  if (!filed)
    return { ok: false, reason: 'missing' }
  const before = withDefaultTitle(filed)
  const query = requery(before, { url: page.url, filter: page.filter, meta: page.meta, scan: page.scan })
  if (!query || query.kind !== page.kind)
    return { ok: false, reason: 'invalid' }

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
      && (sameTitle(other.title, '') || sameTitle(other.title, defaultTitleOf(other)))
      && !other.filter
      && !entries.some(one => isEntry(one) && one.id === other.id)) ?? null

  const others = titled(allLists(state).filter(other => other.id !== absorbed?.id))
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
  const next: ListState = {
    tracked: entry
      ? { ...state.tracked, lists: entries.map(one => (one === entry ? { ...withQueryOf(entry, query), alias: title } : one)) }
      : state.tracked,
    saved: { ...state.saved, lists },
  }
  const stillThere = allLists(next).some(other => addressOf(other.url) === oldAddress)
  const dropCopies = oldAddress !== newAddress && !stillThere
    ? copiesAt(oldAddress, addressed(stored)).map(copy => copy.key)
    : []
  return { ok: true, state: next, dropCopies, absorbed }
}

/** What a save-back of list `id` changed: the lists as it found and left them, and the record it absorbed. */
export interface SaveBackDone {
  id: string
  before: ListState
  after: ListState
  absorbed: SavedList | null
}

/** A save-back that can be taken back, or why it can't, naming the list responsible. */
export type SaveBackUndoPlan
  = | { ok: true, state: ListState }
    | { ok: false, reason: 'missing' | 'changed' }
    | { ok: false, reason: 'duplicate', other: TrackedList }
    | { ok: false, reason: 'title', other: SavedList }

/**
 * Take back the save-back `done` describes: the list's record as it was, its
 * entry as it was while it is tracked, and the record the save-back absorbed,
 * unless its id has been taken since. The record is this browser's own either
 * way, as the save-back left it. The copies it dropped are the caller's to put
 * back, after this is written, so that no moment has them at an address with
 * no record.
 *
 * Only while the list is exactly as the save-back left it: `changed` once it
 * has been retitled, saved back again, tracked or stopped since (here, in
 * another tab, or by a sync), and `missing` once it is gone. Refused, naming
 * the list responsible, when a tracked list would be another tracked list's
 * twin again (`duplicate`), or would take back a title another list has taken
 * since (`title`).
 */
export function planUndoSaveBack(state: ListState, done: SaveBackDone): SaveBackUndoPlan {
  const { id } = done
  const records = recordsOf(state)
  const record = own(records, id)
  if (!record)
    return { ok: false, reason: 'missing' }
  const entries = entriesOf(state)
  const entry = entryWithId(entries, id)
  const left = own(recordsOf(done.after), id)
  const leftEntry = entryWithId(entriesOf(done.after), id)
  if (!left || signature(record) !== signature(left) || signature(entry ?? null) !== signature(leftEntry ?? null))
    return { ok: false, reason: 'changed' }

  const priorEntry = entryWithId(entriesOf(done.before), id)
  const filed = own(recordsOf(done.before), id) ?? (priorEntry ? recordFrom(priorEntry, undefined, false) : undefined)
  if (!filed)
    return { ok: false, reason: 'missing' }
  const prior = withoutMirror(filed)

  if (entry && priorEntry) {
    const key = trackedKey(priorEntry)
    const twin = key === null ? undefined : entries.find(one => isEntry(one) && one.id !== id && trackedKey(one) === key)
    if (twin)
      return { ok: false, reason: 'duplicate', other: twin }
  }
  if (!sameTitle(prior.title, record.title)) {
    const taken = titleTakenBy(prior.title, titled(allLists(state)), id)
    if (taken)
      return { ok: false, reason: 'title', other: taken.list }
  }

  const lists = { ...records, [id]: prior }
  if (done.absorbed && !Object.hasOwn(records, done.absorbed.id))
    lists[done.absorbed.id] = done.absorbed
  return {
    ok: true,
    state: {
      tracked: entry && priorEntry
        ? { ...state.tracked, lists: entries.map(one => (one === entry ? priorEntry : one)) }
        : state.tracked,
      saved: { ...state.saved, lists },
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entryWithId(entries: readonly TrackedList[], id: string): TrackedList | undefined {
  return entries.find(one => isEntry(one) && one.id === id)
}

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

/** Which search view stored a copy: its descriptor's say, else the start of its key, which every view keys its copies by. */
function sourceOf(copy: StoredListRef): string {
  if (copy.sourceId !== undefined)
    return copy.sourceId
  const colon = copy.key.indexOf(':')
  return colon < 0 ? copy.key : copy.key.slice(0, colon)
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

/** The record an entry makes: its query and title, or its default title, over whatever else `existing` holds. */
function recordFrom(entry: TrackedList, existing: SavedList | undefined, mirror: boolean): SavedList {
  const record: SavedList = withDefaultTitle(withQueryOf({ ...existing, id: entry.id, title: typeof entry.alias === 'string' ? entry.alias : '' }, entry))
  return mirror ? { ...record, mirror: true } : withoutMirror(record)
}

/** The record itself when it has a title, else with its default ({@link defaultTitleOf}), where there is one. */
function withDefaultTitle(record: SavedList): SavedList {
  if (typeof record.title === 'string' && record.title.trim())
    return record
  const title = defaultTitleOf(record)
  return title ? { ...record, title } : record
}

/** The entry itself when it has a title, else with its default, where there is one. Anything that isn't an entry, as it is. */
function withDefaultAlias<T>(entry: T): T {
  if (!isEntry(entry) || (typeof entry.alias === 'string' && entry.alias.trim()))
    return entry
  const alias = defaultTitleOf(entry)
  return alias ? { ...entry, alias } : entry
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
