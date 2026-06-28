import { ADDON_CLASS } from '#common'
import React from '#dom'

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
const POPOVER_CLASS = `${ADDON_CLASS}--popover`

/** Gap kept between the floating element and the viewport edge when clamping. */
const VIEWPORT_MARGIN = 6

/** A single row in a {@link openMenu} menu. */
export interface MenuItem {
  /** Optional leading icon. A factory is called once at render time. */
  icon?: Node | (() => Node) | null
  /** The row's text. */
  label: string
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

  for (const item of items) {
    if (item.separatorBefore && menu.childElementCount > 0)
      menu.append(<div class={SEPARATOR_CLASS} />)

    const { el, set } = makeRow()
    set(item)
    menu.append(el)

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

/** Open an informational popover showing `content`, positioned at `at`. */
export function openPopover(content: Node | string, at: { x: number, y: number }): void {
  const box = (
    <div class={`${ADDON_CLASS}  ${POPOVER_CLASS}`} role="dialog">{content}</div>
  ) as HTMLElement
  mount(box, at)
}

/**
 * Append `node` to the body, clamp it inside the viewport at `at`, and wire up the
 * shared dismiss handlers (outside pointerdown, Escape, scroll, resize). Replaces
 * any currently-open floating element.
 */
function mount(node: HTMLElement, at: { x: number, y: number }): void {
  closeFloating()
  current = node

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

  const onPointerDown = (e: Event): void => {
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
  window.addEventListener('scroll', onScrollOrResize, true)
  window.addEventListener('resize', onScrollOrResize, true)

  detach = (): void => {
    clearTimeout(timer)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('scroll', onScrollOrResize, true)
    window.removeEventListener('resize', onScrollOrResize, true)
  }
}
