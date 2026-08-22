import { ADDON_CLASS } from '#common'
import React from '#dom'

import { ensureSurfaceTheme } from './theme.ts'

/**
 * The floating in-page context menu + popover layer.
 *
 * A single instance is shown at a time; opening one dismisses any other. Both the
 * menu and the popover share the same mount/positioning/dismiss machinery
 * ({@link mount} / {@link closeFloating}). Triggers (right-click, long-press, an
 * indicator click) live in `contextTrigger.tsx`; this module only renders and
 * positions what they ask for.
 */

const MENU_CLASS = `${ADDON_CLASS}--menu`
const ITEM_CLASS = `${ADDON_CLASS}--menu--item`
const ICON_CLASS = `${ADDON_CLASS}--menu--icon`
const LABEL_CLASS = `${ADDON_CLASS}--menu--label`
const ACTIVE_CLASS = `${ADDON_CLASS}--menu--active`
const DANGER_CLASS = `${ADDON_CLASS}--menu--danger`
const SEPARATOR_CLASS = `${ADDON_CLASS}--menu--separator`
const GROUP_CLASS = `${ADDON_CLASS}--menu--group`
const HEADING_CLASS = `${ADDON_CLASS}--menu--heading`
const POPOVER_CLASS = `${ADDON_CLASS}--popover`

/** Gap kept between the floating element and the viewport edge when clamping. */
const VIEWPORT_MARGIN = 6

/**
 * What a row reaches. A menu opened on a search page mixes rows that rewrite a
 * saved setting (every listing, from now on) with rows that only re-run the
 * search in front of you — identical-looking actions with very different
 * consequences, which is why each scope gets its own labelled group.
 *
 * - `search` — the search you're looking at, gone with the next one.
 * - `settings` — our settings, stored by the extension.
 * - `account` — settings that live on AO3 (your marks, subscriptions, mutes).
 * - `builtin` — what the browser's own menu would have offered: copy, open.
 *
 * A row with no scope (e.g. the symbols key) sits outside every group and keeps
 * its own {@link MenuItem.separatorBefore}.
 */
export type MenuScope = 'search' | 'settings' | 'account' | 'builtin'

/** The heading drawn above each scope's group, in the order the rows appear. */
const SCOPE_HEADINGS: Record<MenuScope, string> = {
  search: 'Search',
  settings: 'Settings (Extension)',
  account: 'Settings (AO3)',
  builtin: 'Built-in',
}

/** A single row in a {@link openMenu} menu. */
export interface MenuItem {
  /** Optional leading icon. A factory is called once at render time. */
  icon?: Node | (() => Node) | null
  /** The row's text. */
  label: string
  /**
   * How long this row's effect lasts. Consecutive rows sharing a scope are
   * grouped under one heading; see {@link MenuScope}.
   */
  scope?: MenuScope
  /** Show a check/accent indicating this action is the current state. */
  active?: boolean
  /** Render in a "destructive" accent (e.g. hide). */
  danger?: boolean
  /** Render disabled (not selectable) — used for "Checking…" placeholders. */
  disabled?: boolean
  /** Draw a separator line above this row. */
  separatorBefore?: boolean
  /** Run when the row is chosen. The menu closes first. */
  onSelect?: () => void | Promise<void>
  /**
   * Optional async resolver. When present, the row is rendered as given (a
   * "Checking…" placeholder), then `resolve()` is awaited and the row patched in
   * place with whatever it returns — or removed if it returns `null`. Used by the
   * subscribe/mute rows whose real state needs a network fetch.
   */
  resolve?: () => Promise<MenuItem | null>
}

/** The currently-mounted floating element (menu or popover), if any. */
let current: HTMLElement | null = null
/** Tear-down for the current element's dismiss listeners. */
let detach: (() => void) | null = null
/** Where focus was before a focus-taking popover opened, to put it back on close. */
let restoreFocus: HTMLElement | null = null
/** The point the last floating element was asked to open at. */
let lastPoint = { x: 0, y: 0 }

/**
 * Where the reader last opened a menu or popover — the gesture's own viewport
 * point. A menu row that goes on to open a second floating element (the ongoing
 * mark's editor) has no event of its own to position by, since the menu closes
 * before `onSelect` runs.
 */
export function lastFloatingPoint(): { x: number, y: number } {
  return { ...lastPoint }
}

/** Remove whichever floating element (menu or popover) is open. */
export function closeFloating(): void {
  if (detach) {
    detach()
    detach = null
  }
  if (current) {
    current.remove()
    current = null
  }
  // Only ever set by a popover that took focus, so this doesn't yank focus
  // around for the menus, which never move it in the first place.
  if (restoreFocus) {
    const target = restoreFocus
    restoreFocus = null
    if (target.isConnected)
      target.focus()
  }
}

function resolveIcon(icon: MenuItem['icon']): Node | null {
  const node = typeof icon === 'function' ? icon() : icon
  return node ?? null
}

/**
 * A menu row that can be re-rendered in place (for the `resolve` flow). `set`
 * paints the row from a {@link MenuItem}, replacing any prior content/handler.
 */
function makeRow(): { el: HTMLButtonElement, set: (item: MenuItem) => void } {
  const el = (
    <button type="button" class={ITEM_CLASS} role="menuitem" />
  ) as HTMLElement as HTMLButtonElement

  const set = (item: MenuItem): void => {
    el.classList.toggle(ACTIVE_CLASS, !!item.active)
    el.classList.toggle(DANGER_CLASS, !!item.danger)
    el.disabled = !!item.disabled
    el.replaceChildren(
      <span class={ICON_CLASS}>{resolveIcon(item.icon)}</span>,
      <span class={LABEL_CLASS}>{item.label}</span>,
    )
    el.onclick = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (item.disabled)
        return
      closeFloating()
      void item.onSelect?.()
    }
  }

  return { el, set }
}

/** Open a context menu listing `items`, positioned at the viewport point `at`. */
export function openMenu(items: MenuItem[], at: { x: number, y: number }): void {
  const menu = (
    <div class={`${ADDON_CLASS}  ${MENU_CLASS}`} role="menu" />
  ) as HTMLElement

  // Each run of same-scope rows becomes a labelled group — an ARIA one, so the
  // heading is announced rather than just seen. Unscoped rows (copy, open) go
  // straight into the menu.
  let scope: MenuScope | undefined
  let container: HTMLElement = menu
  for (const item of items) {
    const opensGroup = item.scope !== scope
    if (opensGroup) {
      scope = item.scope
      container = menu
      if (scope) {
        const label = SCOPE_HEADINGS[scope]
        const group = (<div class={GROUP_CLASS} role="group" aria-label={label} />) as HTMLElement
        // Visual only: the group's own aria-label already says this to a reader.
        group.append(<div class={HEADING_CLASS} aria-hidden="true">{label}</div>)
        menu.append(group)
        container = group
      }
    }

    // A group heading is its own divider; anywhere else, honour the row's ask.
    if ((!opensGroup || !scope) && item.separatorBefore && container.childElementCount > 0)
      container.append(<div class={SEPARATOR_CLASS} />)

    const { el, set } = makeRow()
    set(item)
    // On the row itself rather than in `set`, so a `resolve`d replacement (which
    // carries no scope of its own) stays in the group it was rendered under.
    if (item.scope)
      el.classList.add(`${ITEM_CLASS}--${item.scope}`)
    container.append(el)

    if (item.resolve) {
      void item.resolve()
        .then((resolved) => {
          // Bail if the menu was dismissed (or rebuilt) while we were fetching.
          if (!el.isConnected)
            return
          if (resolved === null)
            el.remove()
          else
            set(resolved)
        })
        .catch(() => {
          // Leave the placeholder as-is; it's disabled, so it's a harmless no-op.
        })
    }
  }

  mount(menu, at)
}

/**
 * How a popover should behave beyond "show this and dismiss it on the next
 * click". The defaults suit the informational popovers, which are read and
 * dismissed; anything the reader has to *type into* needs all three.
 */
export interface PopoverOptions {
  /**
   * Survive scroll and resize instead of closing on either. A popover holding
   * fields needs this on both counts: focusing an input the browser considers
   * off-screen scrolls it into view, and a mobile virtual keyboard opening fires
   * `resize` — so without it the editor closes the instant a field is tapped.
   */
  persistent?: boolean
  /** Accessible name, so the dialog role isn't announced as an unnamed dialog. */
  label?: string
  /**
   * Focus this once the popover is placed, and put focus back where it was on
   * close. `Escape` is otherwise the only keyboard affordance a popover has.
   */
  autoFocus?: HTMLElement | null
  /**
   * How much room the content needs. The caller knows this; the stylesheet
   * shouldn't have to guess it from what's inside (which is what a
   * `:has(.some-child)` rule amounts to — a width rule that silently stops
   * applying when its content is renamed).
   *
   * - `hint` — a line or two of text. The default.
   * - `form` — fields and buttons: a little wider, with room to breathe.
   * - `wide` — a whole help fragment, which scrolls rather than clipping.
   */
  size?: PopoverSize
}

/** @see {@link PopoverOptions.size} */
export type PopoverSize = 'hint' | 'form' | 'wide'

/** Open an informational popover showing `content`, positioned at `at`. */
export function openPopover(content: Node | string, at: { x: number, y: number }, opts: PopoverOptions = {}): void {
  const box = (
    <div
      class={`${ADDON_CLASS}  ${POPOVER_CLASS}  ${POPOVER_CLASS}--${opts.size ?? 'hint'}`}
      role="dialog"
    >
      {content}
    </div>
  ) as HTMLElement
  if (opts.label) {
    box.setAttribute('aria-label', opts.label)
    // Only a popover that takes focus behaves like a modal at all; saying so on
    // a hover hint would trap a screen reader inside a tooltip.
    if (opts.autoFocus)
      box.setAttribute('aria-modal', 'true')
  }
  mount(box, at, opts)
}

/**
 * Append `node` to the body, clamp it inside the viewport at `at`, and wire up the
 * shared dismiss handlers (outside pointerdown, Escape, and — unless the caller
 * opted out — scroll and resize). Replaces any currently-open floating element.
 */
function mount(node: HTMLElement, at: { x: number, y: number }, opts: PopoverOptions = {}): void {
  // Both surfaces read their colours from the `data-ao3e-theme` token block, so
  // make sure the page has been measured before the first one is painted.
  ensureSurfaceTheme()

  const previous = document.activeElement
  closeFloating()
  current = node
  lastPoint = { x: at.x, y: at.y }

  // Render hidden first so we can measure, then clamp into the viewport.
  node.style.position = 'fixed'
  node.style.left = '0'
  node.style.top = '0'
  node.style.visibility = 'hidden'
  document.body.append(node)

  const rect = node.getBoundingClientRect()
  const maxLeft = window.innerWidth - rect.width - VIEWPORT_MARGIN
  const maxTop = window.innerHeight - rect.height - VIEWPORT_MARGIN
  const left = Math.max(VIEWPORT_MARGIN, Math.min(at.x, maxLeft))
  const top = Math.max(VIEWPORT_MARGIN, Math.min(at.y, maxTop))
  node.style.left = `${left}px`
  node.style.top = `${top}px`
  node.style.visibility = ''

  // A global re-run removes every `.AO3E` node, ours included, without going
  // through closeFloating — so a handler that fires afterwards would be acting
  // on a detached element. Treat that as "already dismissed" and tidy up.
  const stale = (): boolean => {
    if (current?.isConnected)
      return false
    closeFloating()
    return true
  }
  const onPointerDown = (e: Event): void => {
    if (stale())
      return
    if (current && !current.contains(e.target as Node))
      closeFloating()
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape')
      closeFloating()
  }
  const onScrollOrResize = (): void => closeFloating()

  // Defer the outside-pointerdown listener a tick so the very event that opened
  // the menu (an indicator click) doesn't immediately dismiss it.
  const addOutside = (): void => document.addEventListener('pointerdown', onPointerDown, true)
  const timer = setTimeout(addOutside, 0)

  document.addEventListener('keydown', onKeyDown, true)
  if (!opts.persistent) {
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize, true)
  }

  detach = (): void => {
    clearTimeout(timer)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('scroll', onScrollOrResize, true)
    window.removeEventListener('resize', onScrollOrResize, true)
  }

  if (opts.autoFocus) {
    restoreFocus = previous instanceof HTMLElement ? previous : null
    opts.autoFocus.focus()
  }
}
