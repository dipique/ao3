/**
 * Per-work "read" and "favourite" marks — a purely local record of works you've
 * finished with (or loved), independent of anything AO3 stores.
 *
 * The point of `read` is to break the marked-for-later loop: once a work is
 * marked read it can be collapsed out of every listing, so you stop re-adding a
 * work you already finished but don't remember.
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

/** The `workMarks` option: the feature switches plus the two packed id sets. */
export interface WorkMarks {
  /** Track read/favourite marks and offer them in the work context menu. */
  enabled: boolean
  /** Collapse works marked read out of listings (uses the normal hide/reason UI). */
  hideRead: boolean
  /** Packed set of work ids marked read. See {@link packIds}. */
  read: string
  /** Packed set of work ids marked favourite. See {@link packIds}. */
  favorite: string
}

/** Which of the two mark sets an action targets. */
export type MarkKind = 'read' | 'favorite'

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
