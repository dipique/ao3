/**
 * Which of a long list's rows to draw: those in view and a few past either
 * edge, with the room the rows before and after them would take kept as
 * space, so the list scrolls as if every row were there. Drawing a few dozen
 * rows rather than hundreds keeps scrolling, opening and redrawing the list
 * cheap. Only the arithmetic is here; the frame measures and scrolls.
 */

/** Rows drawn: `start` up to but not including `end`, and the space kept before and after them, in px. */
export interface RowWindow {
  start: number
  end: number
  before: number
  after: number
}

/**
 * How many rows past each edge of the view are drawn, so a short scroll shows
 * rows already there; and the step the window moves in, so it holds still,
 * and the rows aren't drawn again, while the view moves within one.
 */
export const ROW_WINDOW = { overscan: 8, chunk: 8 } as const

/** The height taken for a row before any has been measured: a list row's on a wide screen. */
export const ROW_ESTIMATE = 32

/**
 * The rows to draw, given every row's height in order, how far the view is
 * scrolled and how tall it is: the rows in view and `overscan` more either
 * side, rounded out to whole `chunk`s.
 */
export function rowWindow(heights: readonly number[], scrollTop: number, viewport: number, { overscan, chunk }: { overscan: number, chunk: number } = ROW_WINDOW): RowWindow {
  const count = heights.length
  if (!count)
    return { start: 0, end: 0, before: 0, after: 0 }
  const top = Math.max(0, scrollTop)
  const bottom = top + viewport
  let first = count - 1
  let last = count - 1
  let edge = 0
  for (let i = 0; i < count; i++) {
    const next = edge + heights[i]!
    if (first === count - 1 && next > top)
      first = i
    if (next >= bottom) {
      last = i
      break
    }
    edge = next
  }
  first = Math.min(first, last)
  const start = Math.max(0, Math.floor((first - overscan) / chunk) * chunk)
  const end = Math.min(count, Math.ceil((last + 1 + overscan) / chunk) * chunk)
  return { start, end, before: rowOffset(heights, start), after: rowOffset(heights, count) - rowOffset(heights, end) }
}

/** Whether two windows draw the same rows in the same space. */
export function sameWindow(a: RowWindow | null, b: RowWindow | null): boolean {
  if (!a || !b)
    return a === b
  return a.start === b.start && a.end === b.end && a.before === b.before && a.after === b.after
}

/** How far down the list the row at `index` starts. */
export function rowOffset(heights: readonly number[], index: number): number {
  let offset = 0
  for (let i = 0; i < index; i++)
    offset += heights[i]!
  return offset
}

/**
 * Each row's height, by its key: as measured once drawn, or, for a row not
 * drawn yet, the average of those measured, or {@link ROW_ESTIMATE} while
 * none is.
 */
export function estimatedHeights<K>(keys: readonly K[], measured: ReadonlyMap<K, number>): number[] {
  let sum = 0
  for (const height of measured.values())
    sum += height
  const estimate = measured.size ? sum / measured.size : ROW_ESTIMATE
  return keys.map(key => measured.get(key) ?? estimate)
}
