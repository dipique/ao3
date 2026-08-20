/**
 * Per-work marks — a purely local record of what you've done with a work (read
 * it, loved it, bounced off it), independent of anything AO3 stores.
 *
 * The point of `read` is to break the marked-for-later loop: once a work is
 * marked read it can be collapsed out of every listing, so you stop re-adding a
 * work you already finished but don't remember. The finer dispositions
 * (`favorite`, `good`, `boring`, `bad`, `gross`) are the same decision said more
 * precisely — they declare themselves read via {@link MarkConfig.triggerAlias},
 * which is what makes them hide, unsave, and appear in menus exactly as `read`
 * does without any of that being written per-mark.
 *
 * ## Why the ids are packed
 *
 * These live in {@link Options} (so they ride along with backups/restore and the
 * sync engine) — but `storage.sync` has a hard 100 KB quota for *all* settings
 * combined, and a read list only ever grows. A naive `string[]` of eight-digit
 * ids costs ~11 bytes each before compression; delta-encoding the sorted ids in
 * base 36 costs ~4, because consecutive ids in a sorted list differ by far less
 * than their absolute value. On a 5 000-work list that's ~55 KB → ~20 KB before
 * the sync codec's own deflate pass ({@link file://./syncCodec.ts}) runs on top.
 *
 * The format is a comma-separated list of base-36 deltas against the previous
 * id, starting from 0 — so `"1a,2,5"` is 46, 48, 53. Ids are stored sorted and
 * de-duplicated, which also makes the packed string canonical: the same set
 * always produces the same string, so the sync engine's hash-based change
 * detection doesn't see a write that changed nothing.
 *
 * Everything here is pure (no browser APIs, no imports) so it can be unit-tested
 * headlessly with `node --test`.
 */

/** A mark's id — the key it lives under in {@link WorkMarks.marks}. */
export type MarkId = string

/**
 * One mark: what it looks like, how it behaves, and (for the marks that hold
 * their own ids) which works carry it.
 */
export interface MarkConfig {
  /**
   * Icon key. Resolved against a static registry per context — see
   * `content_script/markIcons.tsx` and the options UI's `MARK_ICON_CLASSES` —
   * because both ends need the icon to exist at build time.
   */
  icon: string
  /** Display noun, e.g. "Read", "Favorite". Menus read "Mark as <label>". */
  label: string
  /** Indicator colour (any CSS colour). Falls back to the muted default in CSS. */
  color?: string
  /**
   * Treat this mark as `triggerAlias` for UI and trigger purposes: it shows up
   * wherever that mark's action does, inherits its {@link hideSearchResult}, and
   * setting it takes the work off Marked for Later exactly as that mark would.
   * A work carries at most one mark from a trigger group — setting one clears
   * the rest, so `favorite` doesn't also sit in `read`.
   */
  triggerAlias?: MarkId
  /**
   * Collapse works carrying this mark out of listings (the normal hide/reason
   * UI). When unset, the trigger-alias root's value applies — read it through
   * {@link markHidesResults} rather than directly.
   */
  hideSearchResult?: boolean
  /**
   * Packed set of work ids carrying this mark (see {@link packIds}). Absent
   * means the mark holds no ids of its own — `saved` is only here to configure
   * how Marked for Later is drawn, since that list lives on AO3, not with us.
   */
  items?: string
}

/** The `workMarks` option: the feature switch plus the mark table. */
export interface WorkMarks {
  /** Track marks and offer them in the work context menu. */
  enabled: boolean
  /** Every mark, keyed by id. Insertion order is menu/indicator order. */
  marks: Record<MarkId, MarkConfig>
}

/**
 * The mark whose group means "done with this work". The one piece of behaviour
 * that isn't data: setting any mark in this group also takes the work off your
 * AO3 Marked for Later list, because that pairing is AO3's, not ours.
 */
export const READ_MARK: MarkId = 'read'

/** The mark that mirrors AO3's own Marked for Later state (no ids of its own). */
export const SAVED_MARK: MarkId = 'saved'

/**
 * The marks a fresh install gets. `read` is the root disposition; the five below
 * it are the same disposition said more precisely, so they alias it. `saved`
 * carries no ids — it only says how the Marked for Later state is drawn.
 */
export function createDefaultMarks(): Record<MarkId, MarkConfig> {
  return {
    read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: false, items: '' },
    favorite: { icon: 'favorite', label: 'Favorite', color: '#c2185b', triggerAlias: READ_MARK, items: '' },
    good: { icon: 'good', label: 'Good', color: '#2f8f4e', triggerAlias: READ_MARK, items: '' },
    boring: { icon: 'boring', label: 'Boring', color: '#8a8a8a', triggerAlias: READ_MARK, items: '' },
    bad: { icon: 'bad', label: 'Bad', color: '#b45309', triggerAlias: READ_MARK, items: '' },
    gross: { icon: 'gross', label: 'Gross', color: '#4d7c0f', triggerAlias: READ_MARK, items: '' },
    saved: { icon: 'saved', label: 'Marked for later', color: '#2f8f4e' },
  }
}

// ---------------------------------------------------------------------------
// Reading the mark table. All pure lookups over the stored map, so the content
// script can call them per blurb without touching storage.
// ---------------------------------------------------------------------------

/** Every mark id, in table order. */
export function markIds(marks: Record<MarkId, MarkConfig>): MarkId[] {
  return Object.keys(marks)
}

/** Whether a mark holds its own set of work ids (as opposed to `saved`, which doesn't). */
export function markIsLocal(marks: Record<MarkId, MarkConfig>, id: MarkId): boolean {
  return typeof marks[id]?.items === 'string'
}

/** The ids of every mark that holds its own work-id set, in table order. */
export function localMarkIds(marks: Record<MarkId, MarkConfig>): MarkId[] {
  return markIds(marks).filter(id => markIsLocal(marks, id))
}

/**
 * The mark a mark behaves as: its {@link MarkConfig.triggerAlias}, or itself.
 * One level only — an alias pointing at another alias resolves to the alias it
 * names, not further, so a malformed table can't loop.
 */
export function markRoot(marks: Record<MarkId, MarkConfig>, id: MarkId): MarkId {
  const alias = marks[id]?.triggerAlias
  return alias && alias !== id && marks[alias] ? alias : id
}

/**
 * Every mark that behaves as `id` does — the group's root plus each mark
 * aliasing it, in table order. A work carries at most one mark from a group.
 */
export function markGroup(marks: Record<MarkId, MarkConfig>, id: MarkId): MarkId[] {
  const root = markRoot(marks, id)
  return markIds(marks).filter(other => markRoot(marks, other) === root)
}

/** Whether works carrying this mark are collapsed out of listings (inherited from the group root). */
export function markHidesResults(marks: Record<MarkId, MarkConfig>, id: MarkId): boolean {
  const own = marks[id]?.hideSearchResult
  if (own !== undefined)
    return own
  const root = markRoot(marks, id)
  return root === id ? false : !!marks[root]?.hideSearchResult
}

/** The work ids carrying one mark. Empty for a mark that holds no ids. */
export function markItems(marks: Record<MarkId, MarkConfig>, id: MarkId): Set<string> {
  return unpackIds(marks[id]?.items ?? '')
}

/** Whether one work carries one mark. Prefer {@link markItems} when checking many. */
export function workHasMark(marks: Record<MarkId, MarkConfig>, id: MarkId, workId: string): boolean {
  return hasId(marks[id]?.items ?? '', workId)
}

/**
 * Every work id that some mark hides, mapped to the mark responsible (the first
 * one in table order, when a work somehow carries several). Unpacks each hiding
 * mark once, so HideWorks can test a whole listing against one map.
 */
export function hiddenByMarks(marks: Record<MarkId, MarkConfig>): Map<string, MarkId> {
  const out = new Map<string, MarkId>()
  for (const id of localMarkIds(marks)) {
    if (!markHidesResults(marks, id))
      continue
    for (const workId of markItems(marks, id)) {
      if (!out.has(workId))
        out.set(workId, id)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Writing. Both helpers return a *new* mark table (or the original, unchanged,
// when nothing moved) so callers can skip a redundant `options.set` — every
// option write wakes the sync engine and the daily-backup check.
// ---------------------------------------------------------------------------

/** Replace one mark's packed id set, leaving the rest of the table alone. */
function withItems(marks: Record<MarkId, MarkConfig>, id: MarkId, items: string): Record<MarkId, MarkConfig> {
  return { ...marks, [id]: { ...marks[id]!, items } }
}

/**
 * Set or clear one mark on one work. Setting a mark clears every *other* mark in
 * its trigger group — a work has one disposition, so marking it `favorite`
 * takes it out of `read` rather than sitting in both.
 *
 * Returns the original table (identity-equal) when nothing changed.
 */
export function setMark(
  marks: Record<MarkId, MarkConfig>,
  workId: string,
  id: MarkId,
  on: boolean,
): Record<MarkId, MarkConfig> {
  if (!markIsLocal(marks, id))
    return marks

  let next = marks
  const items = withId(next[id]!.items!, workId, on)
  if (items !== next[id]!.items)
    next = withItems(next, id, items)

  if (on) {
    for (const other of markGroup(marks, id)) {
      if (other === id || !markIsLocal(next, other))
        continue
      const cleared = withId(next[other]!.items!, workId, false)
      if (cleared !== next[other]!.items)
        next = withItems(next, other, cleared)
    }
  }

  return next
}

/**
 * Set or clear a work's disposition at the group level — what AO3's own "Mark as
 * Read" / "Mark for Later" buttons mean, as opposed to a specific choice from
 * our menu.
 *
 * Turning it *on* is a no-op when the work already carries any mark in the group:
 * pressing AO3's Mark as Read on a work you'd already called `gross` must not
 * quietly downgrade it to plain `read`. Turning it *off* clears the whole group,
 * since any of them meant "done with it".
 */
export function setMarkGroup(
  marks: Record<MarkId, MarkConfig>,
  workId: string,
  id: MarkId,
  on: boolean,
): Record<MarkId, MarkConfig> {
  const group = markGroup(marks, id)
  const carried = group.filter(other => workHasMark(marks, other, workId))

  if (on)
    return carried.length > 0 ? marks : setMark(marks, workId, markRoot(marks, id), true)

  let next = marks
  for (const other of carried)
    next = setMark(next, workId, other, false)
  return next
}

/** Which marks a work carries, in table order. */
export function marksForWork(marks: Record<MarkId, MarkConfig>, workId: string): MarkId[] {
  return localMarkIds(marks).filter(id => workHasMark(marks, id, workId))
}

// ---------------------------------------------------------------------------
// The packed id codec.
// ---------------------------------------------------------------------------

const SEPARATOR = ','
const RADIX = 36

/**
 * Pack work ids into the compact delta form. Input may be in any order and may
 * contain duplicates or junk; the result is sorted, de-duplicated, and canonical.
 * Non-numeric and negative values are dropped rather than throwing — a corrupt
 * entry should cost one id, not the whole list.
 */
export function packIds(ids: Iterable<string | number>): string {
  const seen = new Set<number>()
  for (const raw of ids) {
    // Digits-only, not `Number(raw)`: that coerces '', ' ' and null to 0, which
    // would silently invent a work id 0 out of an empty entry.
    const n = typeof raw === 'number' ? raw : (/^\d+$/.test(raw) ? Number(raw) : Number.NaN)
    if (Number.isSafeInteger(n) && n >= 0)
      seen.add(n)
  }
  if (seen.size === 0)
    return ''

  const sorted = [...seen].sort((a, b) => a - b)
  let prev = 0
  const parts = sorted.map((n) => {
    const delta = n - prev
    prev = n
    return delta.toString(RADIX)
  })
  return parts.join(SEPARATOR)
}

/**
 * Unpack a delta-encoded id string back into a set of id strings (matching the
 * string ids the rest of the extension parses out of `/works/:id` links).
 *
 * A malformed chunk stops the walk: every later id is relative to it, so
 * continuing would fabricate wrong ids. Returning the prefix we could read
 * degrades gracefully — some marks go missing, none are invented.
 */
export function unpackIds(packed: string): Set<string> {
  const out = new Set<string>()
  if (!packed)
    return out

  let prev = 0
  for (const part of packed.split(SEPARATOR)) {
    const delta = Number.parseInt(part, RADIX)
    if (!Number.isFinite(delta) || delta < 0)
      break
    prev += delta
    out.add(String(prev))
  }
  return out
}

/**
 * How many ids a packed string holds, without building the set. Cheap enough to
 * call from a render (the options page shows it as a count).
 */
export function countIds(packed: string): number {
  return packed ? packed.split(SEPARATOR).length : 0
}

/** Whether a packed set contains an id. Prefer {@link unpackIds} when checking many. */
export function hasId(packed: string, id: string): boolean {
  return unpackIds(packed).has(id)
}

/**
 * Add or remove one id, returning the new packed string. Returns the *original*
 * string (identity-equal) when nothing changed, so callers can skip a redundant
 * `options.set` — which matters here because every option write wakes the sync
 * engine and the daily-backup check.
 */
export function withId(packed: string, id: string, present: boolean): string {
  const ids = unpackIds(packed)
  if (ids.has(id) === present)
    return packed
  if (present)
    ids.add(id)
  else
    ids.delete(id)
  return packIds(ids)
}
