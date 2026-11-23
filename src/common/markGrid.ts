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

import { localMarkIds, markClears, markLabel, offeredMarkIds } from './workMarks.ts'

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

/** One mark to set or clear on the grid's work. */
export interface MarkGridChange {
  markId: MarkId
  on: boolean
}

/**
 * The marks a pinned grid has its work carrying, in table order. A pinned grid
 * writes nothing until it is dismissed, so the marks chosen meanwhile are held
 * here, and the grid draws from this rather than from what the work carries.
 */
export type MarkGridDraft = readonly MarkId[]

/** A draft of what the work carries now. */
export function startDraft(marks: Record<MarkId, MarkConfig>, carries: (id: MarkId) => boolean): MarkGridDraft {
  return localMarkIds(marks).filter(id => carries(id))
}

/**
 * Choose a mark in a draft: off if the draft has it, otherwise on, taking off
 * whatever it can't sit beside ({@link markClears}), as writing it would.
 */
export function toggleDraft(marks: Record<MarkId, MarkConfig>, draft: MarkGridDraft, id: MarkId): MarkGridDraft {
  if (draft.includes(id))
    return draft.filter(other => other !== id)
  const next = new Set([...draft.filter(other => !markClears(marks, id, other)), id])
  return localMarkIds(marks).filter(other => next.has(other))
}

/**
 * The writes that take the work from what it carries to the draft, in the order
 * to make them: each mark added, then each one taken off that no added mark
 * takes off by itself. Written one after another, they leave the work carrying
 * exactly the draft.
 */
export function draftChanges(marks: Record<MarkId, MarkConfig>, carries: (id: MarkId) => boolean, draft: MarkGridDraft): MarkGridChange[] {
  const added = draft.filter(id => !carries(id))
  const removed = localMarkIds(marks).filter(id => carries(id) && !draft.includes(id) && !added.some(on => markClears(marks, on, id)))
  return [...added.map(markId => ({ markId, on: true })), ...removed.map(markId => ({ markId, on: false }))]
}

/**
 * What marking a work says: the marks set, the marks cleared, and whether that
 * took the work off the reader's Marked for Later list.
 */
export function markChangesMessage(marks: Record<MarkId, MarkConfig>, changes: readonly MarkGridChange[], removedFromList: boolean): string {
  const names = (on: boolean): string => changes.filter(c => c.on === on).map(c => markLabel(marks, c.markId).toLowerCase()).join(', ')
  const parts = [names(true) && `marked as ${names(true)}`, names(false) && `unmarked as ${names(false)}`].filter(Boolean)
  const said = parts.join('; ')
  const end = removedFromList ? ' — removed from your Marked for Later list.' : '.'
  return said && `${said[0]!.toUpperCase()}${said.slice(1)}${end}`
}

/** The parts of a box the tooltip placement reads; a `DOMRect` is one. */
export interface MarkGridBox {
  left: number
  top: number
  bottom: number
  width: number
}

/** How far a tile's tooltip sits from the tile, and keeps from the screen's edge, in px. */
const TIP_GAP_PX = 6

/**
 * Where a tile's tooltip goes: centred under the tile, or over it where the
 * screen ends first, and kept on screen beside either edge.
 */
export function markGridTipPlacement(
  tile: MarkGridBox,
  tip: { width: number, height: number },
  viewport: { width: number, height: number },
): { left: number, top: number } {
  const centred = tile.left + tile.width / 2 - tip.width / 2
  const left = Math.max(TIP_GAP_PX, Math.min(centred, viewport.width - TIP_GAP_PX - tip.width))
  const below = tile.bottom + TIP_GAP_PX
  const top = below + tip.height <= viewport.height - TIP_GAP_PX ? below : tile.top - TIP_GAP_PX - tip.height
  return { left, top }
}
