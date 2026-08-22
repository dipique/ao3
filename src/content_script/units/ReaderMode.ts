import { ADDON_CLASS } from '#common'
import { Unit } from '#content_script/Unit.js'

/**
 * ReaderMode — makes the work text (`#workskin`) comfortable to resize.
 *
 * - **Zoom to font size.** A zoom gesture over the work text — Ctrl+scroll, or a
 *   trackpad pinch (which browsers deliver as a `wheel` with `ctrlKey`) — grows
 *   or shrinks the text's font size and reflows it, instead of zooming the whole
 *   page. Anywhere outside the work text, normal browser zoom is untouched.
 * - **Drag to width.** Two thin handles hug the left/right edges of the reading
 *   column; dragging either one narrows or widens the (centred) column, down to a
 *   {@link MIN_WIDTH_REM} floor.
 *
 * Both values persist in the page's own `localStorage` (see {@link LS_SCALE} /
 * {@link LS_WIDTH}), so they're per-device and never travel through the synced
 * options. The `readerMode` option is just the on/off switch.
 *
 * The saved width is the user's *target*. When the window is too narrow to honour
 * it the column shrinks to fit, but the saved target is left alone — widening the
 * window grows the column back up to it. Only a handle drag rewrites the target.
 */

const HANDLE_CLASS = `${ADDON_CLASS}--reader-handle`
const LEFT_HANDLE_CLASS = `${ADDON_CLASS}--reader-handle-left`
const RIGHT_HANDLE_CLASS = `${ADDON_CLASS}--reader-handle-right`
/** Body class set while any of our handles is being dragged (kills text selection page-wide). */
const RESIZING_CLASS = `${ADDON_CLASS}--resizing`

/** localStorage keys. Namespaced so they don't collide with AO3's own storage. */
const LS_SCALE = 'ao3e:reader:fontScale'
const LS_WIDTH = 'ao3e:reader:widthRem'

/** Reading column can't be dragged narrower than this (root-em, i.e. ~20 chars). */
const MIN_WIDTH_REM = 20
const MIN_SCALE = 0.6
const MAX_SCALE = 3
/** Maps wheel/pinch delta to a multiplicative font-size change; gentle enough for pinch. */
const ZOOM_SENSITIVITY = 0.0015

/**
 * Everything a single active instance sets up, kept at module scope so the static
 * `clean()` (which runs before every re-run) can fully tear it down — mirrors the
 * pattern used by {@link FilterToolbar}. Re-runs depend on `clean()` leaving no
 * trace: our listeners, handles and the inline styles we put on `#workskin`.
 */
interface ReaderState {
  workskin: HTMLElement
  handles: HTMLElement[]
  detach: Array<() => void>
}
let active: ReaderState | null = null

function teardown(): void {
  if (!active)
    return

  const { workskin, handles, detach } = active
  active = null

  detach.forEach(fn => fn())
  handles.forEach(h => h.remove())
  document.body.classList.remove(RESIZING_CLASS)

  for (const prop of ['font-size', 'width', 'max-width', 'margin-left', 'margin-right'])
    workskin.style.removeProperty(prop)
}

/** Pixels per root em — the reference for width (kept independent of the text's own scaled font). */
function rootFontPx(): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
}

/** Content width available to the reading column (its container minus that container's padding). */
function availableWidthPx(workskin: HTMLElement): number {
  const parent = workskin.parentElement
  if (!parent)
    return window.innerWidth
  const cs = getComputedStyle(parent)
  const pad = Number.parseFloat(cs.paddingLeft) + Number.parseFloat(cs.paddingRight)
  return parent.clientWidth - pad
}

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

export class ReaderMode extends Unit {
  static override get name() { return 'ReaderMode' }
  override get enabled() { return this.options.readerMode }

  static override async clean(): Promise<void> {
    teardown()
  }

  override async ready(): Promise<void> {
    const workskin = document.querySelector<HTMLElement>('#workskin')
    if (!workskin) {
      // Not a work page — nothing to enhance.
      return
    }

    // Defensive: a previous instance should already be gone via clean().
    teardown()

    // ---- Font scale (zoom gesture) --------------------------------------
    let scale = clampScale(Number.parseFloat(localStorage.getItem(LS_SCALE) ?? '') || 1)
    const applyScale = (): void => {
      // em is relative to the inherited size, so 1em leaves the page's size as-is.
      workskin.style.fontSize = `${scale.toFixed(3)}em`
    }
    applyScale()

    const onWheel = (e: WheelEvent): void => {
      // Only hijack the zoom gesture; plain scrolling is left alone.
      if (!e.ctrlKey)
        return
      e.preventDefault()
      scale = clampScale(scale * Math.exp(-e.deltaY * ZOOM_SENSITIVITY))
      applyScale()
      localStorage.setItem(LS_SCALE, scale.toFixed(3))
    }
    workskin.addEventListener('wheel', onWheel, { passive: false })

    // ---- Width (centred column + drag handles) --------------------------
    workskin.style.marginLeft = 'auto'
    workskin.style.marginRight = 'auto'
    workskin.style.maxWidth = '100%'

    // Saved target width in root-em. If nothing's stored yet, start from the
    // column's current width so enabling the feature doesn't jump the layout;
    // that starting value is deliberately NOT persisted — only a drag writes one.
    const stored = Number.parseFloat(localStorage.getItem(LS_WIDTH) ?? '')
    let savedWidthRem = Number.isFinite(stored) && stored >= MIN_WIDTH_REM
      ? stored
      : workskin.clientWidth / rootFontPx()

    const leftHandle = this.makeHandle(LEFT_HANDLE_CLASS)
    const rightHandle = this.makeHandle(RIGHT_HANDLE_CLASS)
    document.body.append(leftHandle, rightHandle)

    // The chapter text region; grips are kept within it vertically so they never
    // drift up over the work's header/preface (falls back to the whole column).
    const chapters = workskin.querySelector<HTMLElement>('#chapters')

    // Re-place the handles on the column's current screen edges, and pin their
    // centre to the viewport's vertical middle — clamped to the #chapters region
    // so a grip never rises above the work text (nor floats below its end).
    const positionHandles = (): void => {
      const rect = workskin.getBoundingClientRect()
      leftHandle.style.left = `${rect.left}px`
      rightHandle.style.left = `${rect.right}px`
      const region = (chapters ?? workskin).getBoundingClientRect()
      const y = Math.min(Math.max(window.innerHeight / 2, region.top), region.bottom)
      leftHandle.style.top = `${y}px`
      rightHandle.style.top = `${y}px`
    }

    // Apply the effective width = min(target, what currently fits) and re-place
    // handles. Called on load and whenever the container resizes. `lastWidthPx`
    // guards against re-writing an unchanged width — the ResizeObserver below sees
    // the height reflow our own write causes, so an idempotent write keeps it from
    // churning.
    let lastWidthPx = Number.NaN
    const applyWidth = (): void => {
      const appliedPx = Math.min(savedWidthRem * rootFontPx(), availableWidthPx(workskin))
      if (appliedPx !== lastWidthPx) {
        lastWidthPx = appliedPx
        workskin.style.width = `${appliedPx}px`
      }
      positionHandles()
    }
    applyWidth()

    // Container resizes (window resize, sidebar toggles, …) reflow the column.
    const ro = new ResizeObserver(() => applyWidth())
    if (workskin.parentElement)
      ro.observe(workskin.parentElement)

    // Scrolling and viewport changes move the #chapters region relative to the
    // viewport, so re-run the vertical clamp on both.
    const onViewportChange = (): void => positionHandles()
    window.addEventListener('scroll', onViewportChange, { passive: true })
    window.addEventListener('resize', onViewportChange)

    const beginDrag = (side: 'left' | 'right') => (e: PointerEvent): void => {
      e.preventDefault()
      const handle = e.currentTarget as HTMLElement
      handle.setPointerCapture(e.pointerId)
      document.body.classList.add(RESIZING_CLASS)

      const onMove = (ev: PointerEvent): void => {
        const parent = workskin.parentElement
        if (!parent)
          return
        const pr = parent.getBoundingClientRect()
        const cs = getComputedStyle(parent)
        const padL = Number.parseFloat(cs.paddingLeft)
        const avail = parent.clientWidth - padL - Number.parseFloat(cs.paddingRight)
        // The column stays centred, so a handle at distance d from the centre
        // means a total width of 2d — that keeps the dragged edge under the pointer.
        const centreX = pr.left + padL + avail / 2
        const half = side === 'right' ? ev.clientX - centreX : centreX - ev.clientX
        const widthPx = Math.min(Math.max(half * 2, MIN_WIDTH_REM * rootFontPx()), avail)
        savedWidthRem = widthPx / rootFontPx()
        // Re-use applyWidth so the drag and any concurrent resize agree on the width.
        applyWidth()
      }
      const onUp = (): void => {
        if (handle.hasPointerCapture(e.pointerId))
          handle.releasePointerCapture(e.pointerId)
        document.body.classList.remove(RESIZING_CLASS)
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onUp)
        handle.removeEventListener('lostpointercapture', onUp)
        // A handle drag is the ONLY thing that rewrites the persisted target.
        localStorage.setItem(LS_WIDTH, savedWidthRem.toFixed(2))
      }
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
      handle.addEventListener('lostpointercapture', onUp)
    }

    const leftDown = beginDrag('left')
    const rightDown = beginDrag('right')
    leftHandle.addEventListener('pointerdown', leftDown)
    rightHandle.addEventListener('pointerdown', rightDown)

    active = {
      workskin,
      handles: [leftHandle, rightHandle],
      detach: [
        () => workskin.removeEventListener('wheel', onWheel),
        () => ro.disconnect(),
        () => window.removeEventListener('scroll', onViewportChange),
        () => window.removeEventListener('resize', onViewportChange),
        () => leftHandle.removeEventListener('pointerdown', leftDown),
        () => rightHandle.removeEventListener('pointerdown', rightDown),
      ],
    }

    this.logger.debug(`Reader mode active (scale ${scale.toFixed(2)}, width ${savedWidthRem.toFixed(1)}rem).`)
  }

  private makeHandle(sideClass: string): HTMLElement {
    const handle = document.createElement('div')
    handle.className = `${ADDON_CLASS} ${HANDLE_CLASS} ${sideClass}`
    handle.title = 'Drag to adjust reading width'
    handle.setAttribute('aria-hidden', 'true')
    return handle
  }
}
