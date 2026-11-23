import MdiDragVariant from '~icons/mdi/drag-variant.jsx'
import MdiPinOutline from '~icons/mdi/pin-outline.jsx'
import MdiPin from '~icons/mdi/pin.jsx'

import type { MarkConfig, MarkGridChange, MarkGridDraft, MarkId } from '#common'

import { draftChanges, MARK_GRID_MOVE_MS, markDescription, markGridKeyAction, markGridLayout, markGridTipPlacement, markIsReorderable, markLabel, startDraft, toggleDraft } from '#common'
import React from '#dom'

import { closeFloating } from './contextMenu.tsx'
import { extensionAlive } from './extensionAlive.ts'
import { markIcon } from './markIcons.tsx'
import { ensureSurfaceTheme } from './theme.ts'

/**
 * The rating grid on a work: R opens it over the page, every mark the work can
 * take is a tile with its icon in colour, and choosing one moves it up into the
 * selected row at the top. What is offered, and what a key does, are decided in
 * `#common`'s `markGrid` module; this draws it and keeps it open.
 *
 * Keeping it open is most of the work. Each mark written is an options change,
 * and on AO3 an options change re-runs every unit, whose clean-up takes every
 * `.AO3E` element off the page — so the grid isn't one. It outlives the run
 * instead: the unit that knows the work hands over a {@link MarkGridHost} on
 * every run, and an open grid redraws from whichever host is current. Choosing
 * three marks in a row is then three clicks on one grid, not a grid opened three
 * times.
 *
 * Pinned, it writes nothing until it is dismissed: the marks chosen are held in
 * a draft and written together when it closes, so a work on Marked for Later is
 * taken off the list, and its page reloaded, once rather than at the first pick.
 * In edit mode a click marks nothing, and a tile dragged onto another moves its
 * mark there in the mark order.
 */

const CLASS = 'AO3E--mark-grid'
const cx = (suffix: string): string => `${CLASS}--${suffix}`

/** What the grid needs from the page's work, handed over by the unit that decorates it. */
export interface MarkGridHost {
  workId: string
  /** The work's title, for the grid's accessible name. */
  title: string
  /** The title element the work's menu hangs off; a host whose title isn't on screen is over. */
  anchor: HTMLElement
  /** The mark table, as this run read it. */
  marks: () => Record<MarkId, MarkConfig>
  /** Whether the work carries a mark right now, including writes made since the run began. */
  carries: (markId: MarkId) => boolean
  /**
   * Set or clear a mark, as choosing it from the work's menu does. `at` is the
   * chosen tile's centre, for anything that opens from there.
   */
  choose: (markId: MarkId, on: boolean, at: { x: number, y: number }) => void
  /** Set and clear several marks at once: what a pinned grid writes when it is dismissed. */
  chooseAll: (changes: MarkGridChange[]) => void
  /** Whether the grid opens pinned. */
  pinned: boolean
  /** Keep the pin for the next time the grid opens. */
  setPinned: (on: boolean) => void
  /** Move a mark to just before or after another in the mark order; whether the order changed. */
  move: (markId: MarkId, target: MarkId, side: 'before' | 'after') => boolean
  /** Whether choosing this mark opens something of its own rather than setting it, which closes the grid. */
  opensEditor: (markId: MarkId) => boolean
}

/** How far, in px, a tile has to be pulled before it is being dragged rather than pressed. */
const DRAG_THRESHOLD_PX = 4

let host: MarkGridHost | null = null
/** The page's units have been cleaned up since `host` was handed over: it can serve an open grid, not open one. */
let retired = false
let grid: HTMLElement | null = null
let selectedRow: HTMLElement | null = null
let availableRow: HTMLElement | null = null
let pinButton: HTMLButtonElement | null = null
let editButton: HTMLButtonElement | null = null
/** A tile's description, shown the moment the pointer is over it, which a native tooltip is not. */
let tip: HTMLElement | null = null
const tiles = new Map<MarkId, HTMLButtonElement>()
let restoreFocus: HTMLElement | null = null
let listening = false
/** What a pinned grid has the work carrying; null while unpinned. */
let draft: MarkGridDraft | null = null
let editing = false
/** The pin as last toggled here, until a host hands over a setting that agrees with it. */
let pinChoice: boolean | null = null

interface Drag {
  markId: MarkId
  tile: HTMLButtonElement
  startX: number
  startY: number
  moving: boolean
  target: { markId: MarkId, tile: HTMLElement, side: 'before' | 'after' } | null
}
let drag: Drag | null = null

/**
 * Hand the grid the work this page shows. An open grid redraws for it, or closes
 * if it is a different work.
 */
export function setMarkGridHost(next: MarkGridHost): void {
  const sameWork = host?.workId === next.workId
  if (grid && !sameWork)
    closeMarkGrid()
  host = next
  if (pinChoice === next.pinned)
    pinChoice = null
  retired = false
  listen()
  if (grid)
    render(null)
}

/**
 * The page's units are being cleaned up. An open grid stays, still writing
 * through the host it has until the next run hands over a new one; but R opens
 * nothing until then, so a page whose grid has just been switched off stops
 * offering it.
 */
export function retireMarkGridHost(): void {
  retired = true
}

function listen(): void {
  if (listening)
    return
  listening = true
  document.addEventListener('keydown', onKeyDown)
}

/**
 * Whether the work's title is drawn at all. Not just in the page: a site
 * export keeps the work it last showed under its list, hidden, and that work
 * is no longer the one being read.
 */
function shown(anchor: HTMLElement): boolean {
  return anchor.isConnected && anchor.getClientRects().length > 0
}

function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement))
    return false
  return target.isContentEditable || target.matches('input, textarea, select')
}

function onKeyDown(event: KeyboardEvent): void {
  const action = markGridKeyAction(event, { open: grid !== null, typing: typingIn(event.target) })
  if (action === 'close') {
    event.preventDefault()
    closeMarkGrid()
  }
  else if (action === 'open' && host && !retired && shown(host.anchor)) {
    event.preventDefault()
    openMarkGrid()
  }
}

function onPointerDown(event: PointerEvent): void {
  if (grid && !grid.contains(event.target as Node))
    closeMarkGrid()
}

function openMarkGrid(): void {
  if (!host)
    return
  closeFloating()
  ensureSurfaceTheme()
  restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  selectedRow = (<div class={`${cx('row')}  ${cx('selected')}`} data-ao3e-row="selected" />) as HTMLElement
  availableRow = (<div class={`${cx('row')}  ${cx('available')}`} data-ao3e-row="available" />) as HTMLElement
  editButton = (
    <button type="button" class={cx('toggle')} data-ao3e-action="edit-order" aria-label="Rearrange marks" title="Rearrange marks">
      <MdiDragVariant />
    </button>
  ) as HTMLElement as HTMLButtonElement
  pinButton = (<button type="button" class={cx('toggle')} data-ao3e-action="pin" aria-label="Pin" title="Pin: stay open, and save marks on closing" />) as HTMLElement as HTMLButtonElement
  editButton.addEventListener('click', toggleEditing)
  pinButton.addEventListener('click', togglePinned)
  grid = (
    <div class={CLASS} role="dialog" aria-modal="true" data-ao3e-mark-grid="">
      <div class={cx('bar')}>
        {editButton}
        {pinButton}
      </div>
      {selectedRow}
      {availableRow}
    </div>
  ) as HTMLElement
  grid.setAttribute('aria-label', `Marks for ${host.title}`)
  tip = (<div class={cx('tip')} data-ao3e-mark-tip="" aria-hidden="true" hidden />) as HTMLElement
  editing = false
  draft = (pinChoice ?? host.pinned) ? startDraft(host.marks(), host.carries) : null
  paintToggles()
  render(null)
  document.body.append(grid, tip)
  document.addEventListener('pointerdown', onPointerDown, true)
  const first = selectedRow.firstElementChild ?? availableRow.firstElementChild
  if (first instanceof HTMLElement)
    first.focus()
}

/**
 * Close the grid, if it is open, and put focus back where it was. A pinned
 * grid's marks are written now.
 */
export function closeMarkGrid(): void {
  if (!grid)
    return
  endDrag()
  commitDraft()
  draft = null
  editing = false
  document.removeEventListener('pointerdown', onPointerDown, true)
  grid.remove()
  grid = null
  tip?.remove()
  tip = null
  selectedRow = null
  availableRow = null
  pinButton = null
  editButton = null
  tiles.clear()
  const target = restoreFocus
  restoreFocus = null
  if (target?.isConnected)
    target.focus()
}

function tileFor(markId: MarkId): HTMLButtonElement {
  let tile = tiles.get(markId)
  if (!tile) {
    tile = (<button type="button" class={cx('tile')} data-ao3e-value={markId} />) as HTMLElement as HTMLButtonElement
    tile.addEventListener('click', () => choose(markId, tile!))
    tile.addEventListener('pointerdown', event => startDrag(event, markId, tile!))
    tile.addEventListener('pointerenter', () => showTip(tile!))
    tile.addEventListener('pointerleave', hideTip)
    tiles.set(markId, tile)
  }
  return tile
}

function paint(tile: HTMLButtonElement, marks: Record<MarkId, MarkConfig>, markId: MarkId, selected: boolean): void {
  const config = marks[markId]!
  tile.dataset.ao3eAction = selected ? 'unmark' : 'mark'
  tile.setAttribute('aria-pressed', String(selected))
  if (markIsReorderable(marks, markId))
    tile.dataset.ao3eMovable = ''
  else
    delete tile.dataset.ao3eMovable
  if (config.color)
    tile.style.setProperty('--ao3e-mark-color', config.color)
  else
    tile.style.removeProperty('--ao3e-mark-color')
  const description = markDescription(marks, markId)
  if (description)
    tile.setAttribute('aria-description', description)
  else
    tile.removeAttribute('aria-description')
  tile.replaceChildren(
    <span class={cx('icon')} aria-hidden="true">{markIcon(config.icon)()}</span>,
    <span class={cx('label')}>{markLabel(marks, markId)}</span>,
  )
}

/**
 * Lay the tiles out from the host's current state. Tiles are kept per mark and
 * moved between the rows rather than rebuilt, so each can be slid from where it
 * was to where it now is; `chosen`, the one just clicked, jumps rather than slides.
 * `from` says where a tile was drawn when that isn't where it sits now, as for
 * one just dropped.
 */
function render(chosen: MarkId | null, from?: ReadonlyMap<MarkId, DOMRect>): void {
  if (!grid || !selectedRow || !availableRow || !host)
    return
  const marks = host.marks()
  const layout = markGridLayout(marks, carries())
  const before = new Map([...tiles].map(([id, tile]) => [id, from?.get(id) ?? tile.getBoundingClientRect()]))
  const focused = document.activeElement
  hideTip()

  const shown = new Set([...layout.selected, ...layout.available])
  for (const [id, tile] of tiles) {
    if (!shown.has(id)) {
      tile.remove()
      tiles.delete(id)
    }
  }
  const place = (row: HTMLElement, ids: MarkId[], selected: boolean): void => {
    for (const id of ids) {
      const tile = tileFor(id)
      paint(tile, marks, id, selected)
      row.append(tile)
    }
  }
  place(selectedRow, layout.selected, true)
  place(availableRow, layout.available, false)
  if (!layout.selected.length)
    grid.dataset.ao3eEmpty = ''
  else
    delete grid.dataset.ao3eEmpty

  if (focused instanceof HTMLElement && focused !== document.activeElement && focused.isConnected)
    focused.focus()
  animate(before, chosen)
}

function animate(before: Map<MarkId, DOMRect>, chosen: MarkId | null): void {
  if (!grid?.isConnected || matchMedia('(prefers-reduced-motion: reduce)').matches)
    return
  for (const [id, tile] of tiles) {
    const from = before.get(id)
    if (!from)
      continue
    const to = tile.getBoundingClientRect()
    const dx = from.left - to.left
    const dy = from.top - to.top
    if (!dx && !dy)
      continue
    const frames: Keyframe[] = id === chosen
      ? [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: `translate(${dx / 2}px, ${dy / 2 - 14}px) scale(1.12)`, offset: 0.5 },
          { transform: 'none' },
        ]
      : [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }]
    tile.animate(frames, { duration: MARK_GRID_MOVE_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
  }
}

/** Whether the grid has its work carrying a mark: the draft's answer while pinned. */
function carries(): (markId: MarkId) => boolean {
  const held = draft
  return held ? markId => held.includes(markId) : markId => host?.carries(markId) ?? false
}

function choose(markId: MarkId, tile: HTMLButtonElement): void {
  if (!host || !grid || editing)
    return
  // An orphaned page can't write the mark table; the menu refuses the same rows.
  if (!shown(host.anchor) || !extensionAlive()) {
    closeMarkGrid()
    return
  }
  const on = !carries()(markId)
  const rect = tile.getBoundingClientRect()
  const at = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  if (on && host.opensEditor(markId)) {
    const opener = host
    closeMarkGrid()
    opener.choose(markId, on, at)
    return
  }
  if (draft)
    draft = toggleDraft(host.marks(), draft, markId)
  else
    host.choose(markId, on, at)
  render(markId)
}

/** Write what a pinned grid has chosen, and start its draft again from there. */
function commitDraft(): void {
  // An orphaned page can't write the mark table, and would toast as if it had.
  if (!host || !draft || !extensionAlive())
    return
  const changes = draftChanges(host.marks(), host.carries, draft)
  if (changes.length)
    host.chooseAll(changes)
  draft = startDraft(host.marks(), host.carries)
}

function togglePinned(): void {
  if (!host)
    return
  const pinned = !draft
  pinChoice = pinned
  host.setPinned(pinned)
  if (pinned) {
    draft = startDraft(host.marks(), host.carries)
  }
  else {
    commitDraft()
    draft = null
  }
  paintToggles()
  render(null)
}

function toggleEditing(): void {
  editing = !editing
  paintToggles()
}

function paintToggles(): void {
  if (!grid || !pinButton || !editButton)
    return
  pinButton.setAttribute('aria-pressed', String(draft !== null))
  pinButton.replaceChildren(draft ? <MdiPin /> : <MdiPinOutline />)
  editButton.setAttribute('aria-pressed', String(editing))
  if (editing)
    grid.dataset.ao3eEditing = ''
  else
    delete grid.dataset.ao3eEditing
}

/** Show a tile's description beside it, if it has one. */
function showTip(tile: HTMLElement): void {
  const text = tile.getAttribute('aria-description')
  if (!tip || !text || drag?.moving) {
    hideTip()
    return
  }
  tip.textContent = text
  tip.hidden = false
  const at = markGridTipPlacement(tile.getBoundingClientRect(), tip.getBoundingClientRect(), { width: innerWidth, height: innerHeight })
  tip.style.left = `${at.left}px`
  tip.style.top = `${at.top}px`
}

function hideTip(): void {
  if (tip)
    tip.hidden = true
}

// ---------------------------------------------------------------------------
// Dragging a tile in edit mode. Pointer events on the document rather than
// native drag and drop, so the tile itself follows the pointer and the drop
// lands beside whichever tile is under it.
// ---------------------------------------------------------------------------

function startDrag(event: PointerEvent, markId: MarkId, tile: HTMLButtonElement): void {
  if (!editing || !host || event.button !== 0 || !markIsReorderable(host.marks(), markId))
    return
  event.preventDefault()
  endDrag()
  drag = { markId, tile, startX: event.clientX, startY: event.clientY, moving: false, target: null }
  document.addEventListener('pointermove', onDragMove)
  document.addEventListener('pointerup', onDragEnd)
  document.addEventListener('pointercancel', endDrag)
}

function onDragMove(event: PointerEvent): void {
  if (!drag || !host)
    return
  const dx = event.clientX - drag.startX
  const dy = event.clientY - drag.startY
  if (!drag.moving && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX)
    return
  drag.moving = true
  hideTip()
  drag.tile.dataset.ao3eDragging = ''
  drag.tile.style.transform = `translate(${dx}px, ${dy}px)`

  const under = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(`.${cx('tile')}`)
  const markId = under?.dataset.ao3eValue
  const target = under && markId && under !== drag.tile && grid?.contains(under) && markIsReorderable(host.marks(), markId) ? under : null
  const rect = target?.getBoundingClientRect()
  const side = rect && event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
  if (drag.target && (drag.target.tile !== target || drag.target.side !== side))
    delete drag.target.tile.dataset.ao3eDrop
  drag.target = target && markId ? { markId, tile: target, side } : null
  if (drag.target)
    drag.target.tile.dataset.ao3eDrop = side
}

function onDragEnd(): void {
  const ended = drag
  if (!ended?.moving || !ended.target || !host) {
    endDrag()
    return
  }
  const dropped = ended.tile.getBoundingClientRect()
  endDrag()
  if (host.move(ended.markId, ended.target.markId, ended.target.side))
    render(null, new Map([[ended.markId, dropped]]))
}

/** Put a dragged tile back and stop following the pointer. */
function endDrag(): void {
  document.removeEventListener('pointermove', onDragMove)
  document.removeEventListener('pointerup', onDragEnd)
  document.removeEventListener('pointercancel', endDrag)
  if (!drag)
    return
  drag.tile.style.removeProperty('transform')
  delete drag.tile.dataset.ao3eDragging
  if (drag.target)
    delete drag.target.tile.dataset.ao3eDrop
  drag = null
}
