/**
 * Short work ids: a work's numeric id written in base 36, the spelling storage
 * keys and stored lists use (`7134741` → `48x79`).
 *
 * **Storage only.** In memory a work id stays the decimal string the rest of the
 * extension parses out of `/works/:id` links, unpacks marks into and carries on
 * `Work.workId`; converting happens at the edge of the stores that use this
 * spelling, and nowhere else. Base 36 is the radix the packed id codec in
 * {@link file://./workMarks.ts} already uses, so the two read the same way.
 *
 * Import-free, so it loads under a plain `node --test`.
 */

const RADIX = 36
const SEPARATOR = ','
const DECIMAL_RE = /^\d+$/
const SHORT_RE = /^[0-9a-z]+$/

/** `7134741` → `48x79`. Null for anything that isn't a safe non-negative integer. */
export function toShortId(id: string | number): string | null {
  const n = typeof id === 'number' ? id : (DECIMAL_RE.test(id) ? Number(id) : Number.NaN)
  return Number.isSafeInteger(n) && n >= 0 ? n.toString(RADIX) : null
}

/** `48x79` → `'7134741'`. Null on malformed input. */
export function fromShortId(sid: string): string | null {
  if (!SHORT_RE.test(sid))
    return null
  const n = Number.parseInt(sid, RADIX)
  return Number.isSafeInteger(n) && n >= 0 ? String(n) : null
}

/**
 * Pack decimal ids into an **ordered** short-id list: `'48x79,1b90uz,…'`.
 *
 * Not {@link file://./workMarks.ts}'s `packIds`, which sorts and delta-encodes —
 * a stored list's order is part of what it says (it is what the "listing order"
 * sort shows), so here order is kept and only duplicates and junk are dropped.
 */
export function packOrderedIds(ids: Iterable<string>): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const id of ids) {
    const sid = toShortId(id)
    if (sid === null || seen.has(sid))
      continue
    seen.add(sid)
    parts.push(sid)
  }
  return parts.join(SEPARATOR)
}

/** Unpack an ordered short-id list back into decimal ids, in list order. Junk entries are skipped. */
export function unpackOrderedIds(packed: string): string[] {
  if (!packed)
    return []
  const out: string[] = []
  for (const part of packed.split(SEPARATOR)) {
    const id = fromShortId(part)
    if (id !== null)
      out.push(id)
  }
  return out
}

/** How many ids an ordered list holds, without converting them. */
export function countOrderedIds(packed: string): number {
  return packed ? packed.split(SEPARATOR).length : 0
}
