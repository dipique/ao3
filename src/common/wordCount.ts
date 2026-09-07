/**
 * Word-count ranges: the quick picks offered by the word-count menu on listings
 * ({@link file://../content_script/units/WordCountToolbar.tsx}) and the default
 * range applied alongside the default search language
 * ({@link file://../content_script/units/DefaultSearchWordCount.ts}).
 *
 * Pure — no `browser` APIs, no DOM — so the validation below is the single
 * authority for both the options editor and the content scripts, and unit-tests
 * headlessly.
 */

/**
 * One quick pick. Either bound may be `null`, meaning "unbounded that way" —
 * AO3's own filter accepts a one-sided range, so "100,000+" is expressible. Both
 * null is not a range at all (that's "no filter"), and {@link rangeError}
 * rejects it.
 */
export interface WordCountRange {
  from: number | null
  to: number | null
}

/** The ranges a fresh install offers, before the user edits the list. */
export const DEFAULT_WORD_COUNT_RANGES: WordCountRange[] = [
  { from: 1000, to: 3000 },
  { from: 1500, to: 5000 },
  { from: 2500, to: 10_000 },
  { from: 3000, to: 25_000 },
  { from: 5000, to: 100_000 },
]

/**
 * Coerce a stored/typed bound to a usable number, or null for "unbounded".
 * Anything that isn't a non-negative integer — blank, NaN, a fraction, a
 * negative — becomes null, so a bad value degrades to "no bound" rather than
 * silently filtering to nothing.
 */
export function normalizeBound(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() === '')
    return null
  const n = typeof value === 'string' ? Number(value.replace(/[\s,]/g, '')) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n) || n < 0)
    return null
  return n
}

/**
 * Parse one bound as the *editor* sees it: blank means unbounded (null), but a
 * value that isn't a non-negative integer is an error the user must fix rather
 * than something to quietly drop. `undefined` = invalid.
 */
export function parseBoundInput(text: string): number | null | undefined {
  const trimmed = text.trim()
  if (trimmed === '')
    return null
  if (!/^\d[\d,]*$/.test(trimmed))
    return undefined
  const n = Number(trimmed.replace(/,/g, ''))
  return Number.isSafeInteger(n) ? n : undefined
}

/**
 * Why this range can't be saved, or null when it's fine. The two rules asked
 * for: no negative numbers, and `to - from` may not be below zero. Both bounds
 * blank is rejected too — an empty range would be a menu row that does nothing.
 */
export function rangeError(range: WordCountRange): string | null {
  const { from, to } = range
  if (from !== null && (!Number.isInteger(from) || from < 0))
    return 'The lower bound must be a whole number of 0 or more.'
  if (to !== null && (!Number.isInteger(to) || to < 0))
    return 'The upper bound must be a whole number of 0 or more.'
  if (from === null && to === null)
    return 'Set at least one of the two bounds.'
  if (from !== null && to !== null && to - from < 0)
    return 'The upper bound must not be below the lower bound.'
  return null
}

export function isValidRange(range: WordCountRange): boolean {
  return rangeError(range) === null
}

export function sameRange(a: WordCountRange, b: WordCountRange): boolean {
  return a.from === b.from && a.to === b.to
}

/**
 * Index of the first *other* entry equal to `ranges[index]`, or -1. Overlaps are
 * fine (a work can legitimately fall in several ranges); only exact repeats are
 * rejected, since a duplicated row is a menu row you can't tell apart.
 */
export function duplicateOf(ranges: readonly WordCountRange[], index: number): number {
  const range = ranges[index]
  if (!range)
    return -1
  return ranges.findIndex((other, i) => i !== index && sameRange(other, range))
}

const NUMBER_FORMAT = new Intl.NumberFormat()

/** The menu/editor label for a range: "1,000 – 3,000", "5,000+", "up to 2,000". */
export function formatWordCountRange({ from, to }: WordCountRange): string {
  if (from !== null && to !== null)
    return `${NUMBER_FORMAT.format(from)} – ${NUMBER_FORMAT.format(to)}`
  if (from !== null)
    return `${NUMBER_FORMAT.format(from)}+`
  if (to !== null)
    return `up to ${NUMBER_FORMAT.format(to)}`
  return 'any length'
}

/**
 * The value AO3's advanced-search `work_search[word_count]` field takes — the
 * same one-field syntax a user would type there. The two-field sidebar filter
 * (`words_from` / `words_to`) uses the bounds directly instead.
 */
export function serializeWordCountQuery({ from, to }: WordCountRange): string {
  if (from !== null && to !== null)
    return from === to ? String(from) : `${from}-${to}`
  if (from !== null)
    return `>${from}`
  if (to !== null)
    return `<${to}`
  return ''
}

/**
 * Read back {@link serializeWordCountQuery}, plus the other spellings AO3
 * accepts in that field (`1000-5000`, `>1000`, `<5000`, `1000`, and the `to`
 * word form). Returns null when the field is blank or in a shape we can't map
 * onto two bounds — the menu then treats it as "no filter set", and picking a
 * range overwrites it wholesale.
 */
export function parseWordCountQuery(text: string): WordCountRange | null {
  const value = text.trim().toLowerCase().replace(/,/g, '')
  if (!value)
    return null

  const between = value.match(/^(\d+)\s*(?:-|–|to)\s*(\d+)$/)
  if (between)
    return { from: Number(between[1]), to: Number(between[2]) }

  const above = value.match(/^>=?\s*(\d+)$/)
  if (above)
    return { from: Number(above[1]), to: null }

  const below = value.match(/^<=?\s*(\d+)$/)
  if (below)
    return { from: null, to: Number(below[1]) }

  const exact = value.match(/^(\d+)$/)
  if (exact)
    return { from: Number(exact[1]), to: Number(exact[1]) }

  return null
}

// ---------------------------------------------------------------------------
// Single bounds. Besides the whole ranges, the word-count menu offers each
// configured bound on its own, so the reader can move one edge of the window
// without disturbing the other — the ranges are quick picks, these are nudges.
// ---------------------------------------------------------------------------

/** One end of a range: the lower (`from`) or upper (`to`) bound. */
export type WordCountBound = 'from' | 'to'

/**
 * The distinct `side` bounds across `ranges`, ascending. An unbounded side
 * contributes nothing — "no bound" is a value you clear, not one you set — and
 * invalid ranges are skipped, for the same reason the menu leaves them out.
 */
export function uniqueBounds(ranges: readonly WordCountRange[], side: WordCountBound): number[] {
  const values = new Set<number>()
  for (const range of ranges) {
    if (!isValidRange(range))
      continue
    const bound = range[side]
    if (bound !== null)
      values.add(bound)
  }
  return [...values].sort((a, b) => a - b)
}

/** The bound `side` doesn't name, as it stands in `current`. */
function otherBound(current: WordCountRange | null, side: WordCountBound): number | null {
  return (side === 'from' ? current?.to : current?.from) ?? null
}

/**
 * Whether setting `side` to `value` can leave the other bound alone. It can't
 * when the value crosses it — a lower bound above the standing upper one, or an
 * upper bound below the standing lower one — since that range would filter to
 * nothing.
 */
export function keepsOtherBound(current: WordCountRange | null, side: WordCountBound, value: number): boolean {
  const other = otherBound(current, side)
  return other === null || (side === 'from' ? other >= value : other <= value)
}

/**
 * `current` with one bound replaced and the other left as it stands — what
 * picking a single bound from the menu does, as against a whole range, which
 * replaces both.
 *
 * The exception is a value {@link keepsOtherBound} rejects: there the other
 * bound is dropped and the range goes open-ended that way instead.
 */
export function withBound(current: WordCountRange | null, side: WordCountBound, value: number): WordCountRange {
  const keep = keepsOtherBound(current, side, value) ? otherBound(current, side) : null
  return side === 'from' ? { from: value, to: keep } : { from: keep, to: value }
}

/** A single bound as the menu spells it: "5,000". */
export function formatWordCount(value: number): string {
  return NUMBER_FORMAT.format(value)
}

/**
 * The menu label for one single-bound row. Normally just the value, since that
 * is all the pick changes — but when it can't leave the other bound alone
 * ({@link keepsOtherBound}), the whole resulting range instead, so both numbers
 * that move are on the row rather than one of them arriving as a surprise.
 *
 * A lower bound the pick has to give up is spelled `0` rather than left
 * implicit: it's a real word count, and "up to 500" would hide the very change
 * this label exists to show. There is no number to write on the other side, so
 * an upper bound that goes keeps the open-ended "5,000+" form.
 */
export function formatBoundPick(current: WordCountRange | null, side: WordCountBound, value: number): string {
  if (keepsOtherBound(current, side, value))
    return formatWordCount(value)
  const next = withBound(current, side, value)
  return `${formatWordCountRange(next.from === null ? { ...next, from: 0 } : next)} words`
}
