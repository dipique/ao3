/**
 * The rating grid: every mark a work can take, laid out at once with its icon in
 * colour and its name, opened from a work with a key press. Marking a work three
 * or four ways is then a key and a few large targets, rather than a menu opened
 * and read through again for each mark.
 *
 * What it shows and when it opens are decided here; `content_script/markGrid.tsx`
 * draws it. Pure, so `node --test` reaches it.
 */

import type { MarkConfig, MarkId } from './workMarks.ts'

import { offeredMarkIds } from './workMarks.ts'

/** How long a chosen mark takes to move between the grid and the selected row, in ms. */
export const MARK_GRID_MOVE_MS = 260

/**
 * The grid's two parts: the marks the work carries, in a row of their own at the
 * top, and every other mark it can take below. Both in table order, and between
 * them exactly what the work's menu offers ({@link offeredMarkIds}).
 */
export interface MarkGridLayout {
  selected: MarkId[]
  available: MarkId[]
}

export function markGridLayout(marks: Record<MarkId, MarkConfig>, carries: (id: MarkId) => boolean): MarkGridLayout {
  const offered = offeredMarkIds(marks, carries)
  return {
    selected: offered.filter(id => carries(id)),
    available: offered.filter(id => !carries(id)),
  }
}

/** The parts of a key press the grid reads; a `KeyboardEvent` is one. */
export interface MarkGridKeyPress {
  key: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  repeat: boolean
  isComposing: boolean
}

/** Where the page stands when a key is pressed. */
export interface MarkGridKeyState {
  open: boolean
  /** Focus is in something that takes text, where the key is the reader's typing. */
  typing: boolean
}

/**
 * What a key press does to the grid: R opens it, or closes it when open, and
 * Escape closes it. Null for anything else, which the page is left to handle.
 *
 * Shift is let through, so Caps Lock doesn't stop R working; Ctrl, Alt and Meta
 * aren't, since those make it someone else's shortcut. A held key's repeats are
 * ignored, or holding R would open and close the grid until it was let go.
 */
export function markGridKeyAction(press: MarkGridKeyPress, state: MarkGridKeyState): 'open' | 'close' | null {
  if (press.isComposing || press.repeat || press.ctrlKey || press.altKey || press.metaKey)
    return null
  if (press.key === 'Escape')
    return state.open ? 'close' : null
  if (press.key.toLowerCase() !== 'r' || state.typing)
    return null
  return state.open ? 'close' : 'open'
}
