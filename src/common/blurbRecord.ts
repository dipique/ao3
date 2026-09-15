import type { StoredList } from './cache.ts'

import { hash } from './syncCodec.ts'
import { fromShortId, packOrderedIds, toShortId, unpackOrderedIds } from './workId.ts'

/**
 * The shared blurb store's decidable half: what a stored blurb is, when a new
 * copy should replace it, which blurbs nothing holds any more, and how a list
 * stored the old way — blurbs inline — comes apart into lists and blurbs.
 *
 * The layout, in `storage.local`:
 *
 *     blurb.48x79      ->  { html: '<li id="work_7134741" class="work blurb group">…' }
 *     blurbData.48x79  ->  { pv, seenAt, src, hash, size, work, blurb }
 *     blurbIndex       ->  '1b90uz,…'   (packIds form: every stored work id)
 *     cache.searchLists -> { 'marked-for-later:me': { v: 3, scrapedAt, ids: '48x79,…', ctx } }
 *
 * **Why a blurb is stored once, under its work.** Lists overlap: the same work
 * on Marked for Later, the read list and a tag search was three copies of its
 * markup, and — all lists being one storage value — every list write rewrote
 * every copy, and handed the old and new value of all of it to every open tab.
 * A list now keeps short ids ({@link file://./workId.ts}), which are also what
 * a work's cached text is found by.
 *
 * **Why two keys per work.** Most readers want the parsed half and not the
 * markup: the hide pass, the Status facet, sorting, the export job's context,
 * the options rows. Both are written in one `set`, so they cannot disagree.
 *
 * **Why an index.** Counting what nothing references means listing what is
 * stored, and `storage.local.getKeys` is newer than the browsers this extension
 * supports; its fallback reads every stored value, work text included. The
 * index only changes when a work is added or removed — not when a stored blurb
 * is refreshed — and is advisory: an explicit discard reconciles it by key.
 *
 * Pure apart from {@link file://./syncCodec.ts}'s hash, so it loads under a
 * plain `node --test`, and in the background, which has no DOM: this is all the
 * migration there can do without one.
 */

/** Prefix of the per-work blurb markup. Nothing else may use it. */
export const BLURB_PREFIX = 'blurb.'

/** Prefix of the per-work parsed half. Nothing else may use it. */
export const BLURB_DATA_PREFIX = 'blurbData.'

/** The one key listing every stored blurb's work id. */
export const BLURB_INDEX_KEY = 'blurbIndex'

/** Where lists were stored before this layout — read only to migrate them. */
export const LEGACY_SNAPSHOTS_KEY = 'cache.searchSnapshots'

/** {@link StoredList.v}: the first version holding ids rather than blurbs. */
export const LIST_VERSION = 3

/**
 * Parser version. **Bump it whenever what `parseWork`, `getBlurb` or the
 * blurb normalization produce changes shape** — every record written before is
 * then re-derived from its markup the next time it is read. The markup is the
 * source of truth and the parsed half is a cache of it, which is what makes a
 * bump safe: it costs parsing, never a request.
 *
 * 0 is what a migrated record carries: markup moved across without a DOM to
 * parse it in.
 */
export const PARSE_VERSION = 1

/** How stale a stored blurb's `seenAt` may get before an identical re-scrape rewrites it anyway. */
export const TOUCH_MS = 24 * 60 * 60 * 1000

/**
 * How recently a blurb must have been seen to be spared by an orphan sweep.
 *
 * A list is written after its blurbs, so that a list never names a blurb that
 * isn't there. The other side of that order is a moment in which another tab's
 * fresh blurbs are referenced by nothing yet; a sweep that ran then would take
 * them. Ten minutes is far longer than that moment, and a real orphan loses
 * nothing by waiting.
 */
export const ORPHAN_GRACE_MS = 10 * 60 * 1000

/** Where a blurb's markup came from. A reconstruction from the work page is second-best. */
export type BlurbSource = 'listing' | 'workPage'

/** The three blurb facts a replacement is judged on. `Work` satisfies this structurally. */
export interface WorkFacts {
  /** Epoch seconds from the blurb's `updated_at` comment, or 0. */
  dateUpdated: number
  chapters: { written: number }
  words: number
}

/** Everything about a stored blurb except what was parsed out of it. */
export interface BlurbMeta {
  /** {@link PARSE_VERSION} when written. */
  pv: number
  /** Epoch ms the markup was read off AO3 — when it was fetched, not when it was stored. */
  seenAt: number
  src: BlurbSource
  /** Hash of the stored markup, so an identical re-scrape can skip rewriting it. */
  hash: string
  /** UTF-8 bytes of the stored markup, for totals that don't read it. */
  size: number
}

/** What a `blurb.<sid>` key holds: the markup alone. */
export interface StoredBlurbHtml {
  html: string
}

/** A blurb about to be stored, as far as deciding whether to store it goes. */
export interface IncomingBlurb {
  seenAt: number
  src: BlurbSource
  hash: string
  work: WorkFacts
}

export type BlurbWrite = 'insert' | 'replace' | 'touch' | 'skip'

export const blurbKey = (id: string): string => `${BLURB_PREFIX}${toShortId(id)}`
export const blurbDataKey = (id: string): string => `${BLURB_DATA_PREFIX}${toShortId(id)}`

/** The markup's hash, as {@link BlurbMeta.hash} records it. */
export function hashBlurbHtml(html: string): string {
  return hash(html)
}

export function htmlBytes(html: string): number {
  return new TextEncoder().encode(html).length
}

const DAY_SECONDS = 24 * 60 * 60

/**
 * Whether a blurb should be written over the one stored for its work, and how.
 *
 * - `insert` / `replace` write markup and parsed half both.
 * - `touch` rewrites the parsed half only, to move `seenAt` on an unchanged
 *   blurb that hasn't been seen in a while.
 * - `skip` writes nothing.
 *
 * In order: a parser version decides first (an older one is replaced, a newer
 * one — written by a newer build — is left alone); then a copy fetched *before*
 * the stored one loses, since a refresh that started earlier can finish later;
 * then a work-page reconstruction only replaces a real listing blurb when it
 * knows something newer (its date is to the day, and it has no series); and an
 * identical blurb is only touched when it was seen {@link TOUCH_MS} after the
 * stored copy — a work re-stored from the store itself carries the stored
 * `seenAt`, and must cost nothing.
 */
export function decideBlurbWrite(
  stored: (BlurbMeta & { work?: WorkFacts }) | undefined,
  incoming: IncomingBlurb,
): BlurbWrite {
  if (!stored)
    return 'insert'
  if (stored.pv > PARSE_VERSION)
    return 'skip'
  if (stored.pv < PARSE_VERSION)
    return 'replace'
  if (incoming.seenAt < stored.seenAt)
    return 'skip'
  if (incoming.src === 'workPage' && stored.src === 'listing') {
    const facts = stored.work
    if (!facts)
      return 'replace'
    const newerDay = Math.floor(incoming.work.dateUpdated / DAY_SECONDS) > Math.floor(facts.dateUpdated / DAY_SECONDS)
    const changed = (incoming.work.chapters.written > 0 && incoming.work.chapters.written !== facts.chapters.written)
      || (incoming.work.words > 0 && incoming.work.words !== facts.words)
    return newerDay || changed ? 'replace' : 'skip'
  }
  if (incoming.hash === stored.hash)
    return incoming.seenAt - stored.seenAt >= TOUCH_MS ? 'touch' : 'skip'
  return 'replace'
}

// ---------------------------------------------------------------------------
// The reading-history block.
// ---------------------------------------------------------------------------

/** The block a readings page ends every blurb with, through to the `</li>`. */
const READING_MODULE_RE = /<div class="user module group">[\s\S]*<\/div>(?=\s*<\/li>\s*$)/
const FORM_RE = /<form\b[\s\S]*?<\/form>/g
const LI_OPEN_RE = /^(\s*<li\s(?:[^>]*?\s)?class=")([^"]*)(")/

/** Take every `<form>` out of some markup — the readings block's carries the reader's session token. */
export function stripForms(html: string): string {
  return html.replace(FORM_RE, '')
}

/**
 * Split a stored readings blurb into the work's blurb and this list's block,
 * without a DOM: the migration runs where there is none. On AO3's readings
 * markup the block is always the `<li>`'s last child; markup without it comes
 * back unchanged. The DOM-side equivalent, used everywhere else, is
 * `normalizeBlurb` in the search view's store.
 */
export function splitReadingModule(html: string): { html: string, ctx?: string } {
  const opened = html.replace(LI_OPEN_RE, (_, start: string, classes: string, end: string) =>
    `${start}${classes.split(/\s+/).filter(name => name && name !== 'reading').join(' ')}${end}`)
  const match = READING_MODULE_RE.exec(opened)
  if (!match)
    return { html: opened }
  return {
    html: opened.slice(0, match.index) + opened.slice(match.index + match[0].length),
    ctx: stripForms(match[0]),
  }
}

// ---------------------------------------------------------------------------
// What the lists hold.
// ---------------------------------------------------------------------------

/** The `id="work_123"` a stored blurb carries. */
const BLURB_ID_RE = /\bid="work_(\d+)"/

/** A legacy blurb's work id, or null. */
export function legacyBlurbId(html: string): string | null {
  return BLURB_ID_RE.exec(html)?.[1] ?? null
}

/**
 * Every work id any stored list holds, in either layout — and whatever its
 * version. A list this build can't draw is still one the reader kept, and what
 * it holds is not an orphan.
 */
export function listedIds(lists: { [key: string]: StoredList }, legacy?: unknown): Set<string> {
  const ids = new Set<string>()
  for (const list of Object.values(lists ?? {})) {
    for (const id of unpackOrderedIds(typeof list?.ids === 'string' ? list.ids : ''))
      ids.add(id)
  }
  for (const snapshot of legacySnapshots(legacy)) {
    for (const html of snapshot.blurbsHtml) {
      const id = legacyBlurbId(html)
      if (id)
        ids.add(id)
    }
  }
  return ids
}

/**
 * The ids a list write stops referencing that no other list holds either — the
 * blurbs it would strand.
 */
export function droppedIds(previous: readonly string[], next: readonly string[], others: Iterable<StoredList>): string[] {
  const kept = new Set(next)
  const candidates = previous.filter(id => !kept.has(id))
  if (!candidates.length)
    return []
  const elsewhere = listedIds(Object.fromEntries([...others].map((list, i) => [String(i), list])))
  return candidates.filter(id => !elsewhere.has(id))
}

export interface BlurbOrphanPlan {
  /** Work ids whose blurbs nothing holds and which are past {@link ORPHAN_GRACE_MS}. */
  ids: string[]
  /** Their markup, totalled from {@link BlurbMeta.size}. */
  bytes: number
}

/**
 * Which stored blurbs no list holds any more.
 *
 * `meta` is the parsed half of the *candidates* only — the caller reads it for
 * the ids that aren't referenced, never for the whole store. A candidate with no
 * meta at all (markup whose parsed half was lost) has nothing to be spared by,
 * and goes.
 */
export function planBlurbOrphans(
  stored: Iterable<string>,
  meta: { [id: string]: Pick<BlurbMeta, 'seenAt' | 'size'> | undefined },
  referenced: ReadonlySet<string>,
  now: number,
  graceMs: number = ORPHAN_GRACE_MS,
): BlurbOrphanPlan {
  const plan: BlurbOrphanPlan = { ids: [], bytes: 0 }
  for (const id of new Set(stored)) {
    if (referenced.has(id))
      continue
    const entry = meta[id]
    if (entry && now - entry.seenAt < graceMs)
      continue
    plan.ids.push(id)
    plan.bytes += entry?.size ?? 0
  }
  return plan
}

// ---------------------------------------------------------------------------
// Migrating lists stored the old way.
// ---------------------------------------------------------------------------

interface LegacyEntry {
  key: string
  version: number
  scrapedAt: number
  blurbsHtml: string[]
  descriptor?: StoredList['descriptor']
}

/** The well-formed entries of a legacy `cache.searchSnapshots` value, whatever their version. */
function legacySnapshots(legacy: unknown): LegacyEntry[] {
  if (!legacy || typeof legacy !== 'object')
    return []
  const out: LegacyEntry[] = []
  for (const [key, raw] of Object.entries(legacy as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object')
      continue
    const entry = raw as Record<string, unknown>
    if (!Array.isArray(entry.blurbsHtml))
      continue
    out.push({
      key,
      version: typeof entry.version === 'number' ? entry.version : 0,
      scrapedAt: typeof entry.scrapedAt === 'number' ? entry.scrapedAt : 0,
      blurbsHtml: entry.blurbsHtml.filter((html): html is string => typeof html === 'string'),
      descriptor: entry.descriptor as StoredList['descriptor'],
    })
  }
  return out
}

/** Oldest and newest legacy versions this build can migrate. */
const LEGACY_VERSIONS = [1, 2] as const

export interface LegacyMigrationPlan {
  /** Lists to add, keyed as before. Never includes a key already in the new layout. */
  lists: { [key: string]: StoredList }
  /** One blurb per work id — the newest copy any migrated list held — and when it was scraped. */
  blurbs: Map<string, { html: string, seenAt: number }>
  /**
   * Keys of entries this build could not migrate (an unknown version). While
   * any remain, the legacy value stays where it is.
   */
  skipped: string[]
}

/**
 * Take a legacy `cache.searchSnapshots` value apart into lists and blurbs.
 *
 * Entries are walked oldest first, so for a work several lists held, the copy
 * scraped last wins. A list already in the new layout is left alone — new code
 * wrote it, and it knows better than a copy from before the upgrade — and so
 * are its blurbs. Each readings blurb is split from its list's block
 * ({@link splitReadingModule}), and an entry with no work id is dropped.
 */
export function planLegacyMigration(legacy: unknown, existing: { [key: string]: StoredList }): LegacyMigrationPlan {
  const plan: LegacyMigrationPlan = { lists: {}, blurbs: new Map(), skipped: [] }
  const entries = legacySnapshots(legacy).sort((a, b) => a.scrapedAt - b.scrapedAt)
  for (const entry of entries) {
    if (entry.key in existing)
      continue
    if (entry.version < LEGACY_VERSIONS[0] || entry.version > LEGACY_VERSIONS[1]) {
      plan.skipped.push(entry.key)
      continue
    }
    const ids: string[] = []
    const ctx: { [sid: string]: string } = {}
    for (const raw of entry.blurbsHtml) {
      const id = legacyBlurbId(raw)
      if (!id)
        continue
      const split = splitReadingModule(raw)
      ids.push(id)
      if (split.ctx)
        ctx[toShortId(id)!] = split.ctx
      plan.blurbs.set(id, { html: split.html, seenAt: entry.scrapedAt })
    }
    const list: StoredList = { v: LIST_VERSION, scrapedAt: entry.scrapedAt, ids: packOrderedIds(ids) }
    if (entry.descriptor)
      list.descriptor = entry.descriptor
    if (Object.keys(ctx).length)
      list.ctx = ctx
    plan.lists[entry.key] = list
  }
  return plan
}

/** The meta a migrated blurb is stored with: markup moved, nothing parsed yet. */
export function migratedBlurbMeta(html: string, seenAt: number): BlurbMeta {
  return { pv: 0, seenAt, src: 'listing', hash: hashBlurbHtml(html), size: htmlBytes(html) }
}

/** A short id back to decimal, for callers holding storage keys. Null on junk. */
export function idFromBlurbKey(key: string): string | null {
  const prefix = key.startsWith(BLURB_DATA_PREFIX) ? BLURB_DATA_PREFIX : key.startsWith(BLURB_PREFIX) ? BLURB_PREFIX : null
  return prefix ? fromShortId(key.slice(prefix.length)) : null
}
