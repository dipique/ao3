import type { MarkConfig, MarkId } from '#common'

import { MARK_GRID_MOVE_MS, markDescription, markGridKeyAction, markGridLayout, markLabel } from '#common'
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
  /** Whether choosing this mark opens something of its own rather than setting it, which closes the grid. */
  opensEditor: (markId: MarkId) => boolean
}

let host: MarkGridHost | null = null
/** The page's units have been cleaned up since `host` was handed over: it can serve an open grid, not open one. */
let retired = false
let grid: HTMLElement | null = null
let selectedRow: HTMLElement | null = null
let availableRow: HTMLElement | null = null
const tiles = new Map<MarkId, HTMLButtonElement>()
let restoreFocus: HTMLElement | null = null
let listening = false

/**
 * Hand the grid the work this page shows. An open grid redraws for it, or closes
 * if it is a different work.
 */
export function setMarkGridHost(next: MarkGridHost): void {
  const sameWork = host?.workId === next.workId
  host = next
  retired = false
  listen()
  if (grid && !sameWork)
    closeMarkGrid()
  else if (grid)
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
  grid = (
    <div class={CLASS} role="dialog" aria-modal="true" data-ao3e-mark-grid="">
      {selectedRow}
      {availableRow}
    </div>
  ) as HTMLElement
  grid.setAttribute('aria-label', `Marks for ${host.title}`)
  render(null)
  document.body.append(grid)
  document.addEventListener('pointerdown', onPointerDown, true)
  const first = selectedRow.firstElementChild ?? availableRow.firstElementChild
  if (first instanceof HTMLElement)
    first.focus()
}

/** Close the grid, if it is open, and put focus back where it was. */
export function closeMarkGrid(): void {
  if (!grid)
    return
  document.removeEventListener('pointerdown', onPointerDown, true)
  grid.remove()
  grid = null
  selectedRow = null
  availableRow = null
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
    tiles.set(markId, tile)
  }
  return tile
}

function paint(tile: HTMLButtonElement, marks: Record<MarkId, MarkConfig>, markId: MarkId, selected: boolean): void {
  const config = marks[markId]!
  tile.dataset.ao3eAction = selected ? 'unmark' : 'mark'
  tile.setAttribute('aria-pressed', String(selected))
  if (config.color)
    tile.style.setProperty('--ao3e-mark-color', config.color)
  else
    tile.style.removeProperty('--ao3e-mark-color')
  const tip = markDescription(marks, markId)
  if (tip)
    tile.title = tip
  else
    tile.removeAttribute('title')
  tile.replaceChildren(
    <span class={cx('icon')} aria-hidden="true">{markIcon(config.icon)()}</span>,
    <span class={cx('label')}>{markLabel(marks, markId)}</span>,
  )
}

/**
 * Lay the tiles out from the host's current state. Tiles are kept per mark and
 * moved between the rows rather than rebuilt, so each can be slid from where it
 * was to where it now is; `chosen`, the one just clicked, jumps rather than slides.
 */
function render(chosen: MarkId | null): void {
  if (!grid || !selectedRow || !availableRow || !host)
    return
  const marks = host.marks()
  const layout = markGridLayout(marks, host.carries)
  const before = new Map([...tiles].map(([id, tile]) => [id, tile.getBoundingClientRect()]))
  const focused = document.activeElement

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

function choose(markId: MarkId, tile: HTMLButtonElement): void {
  if (!host || !grid)
    return
  // An orphaned page can't write the mark table; the menu refuses the same rows.
  if (!shown(host.anchor) || !extensionAlive()) {
    closeMarkGrid()
    return
  }
  const on = !host.carries(markId)
  const rect = tile.getBoundingClientRect()
  const at = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  if (on && host.opensEditor(markId)) {
    closeMarkGrid()
    host.choose(markId, on, at)
    return
  }
  host.choose(markId, on, at)
  render(markId)
}
