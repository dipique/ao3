import Error from '~icons/line-md/close-circle.jsx'
import Success from '~icons/line-md/confirm.jsx'

import React from '#dom'

import style from './toast.css?inline'

export interface ToastOptions {
  /** Milliseconds before it goes. `0` keeps it up until it is closed or {@link ToastHandle.hide}den. */
  timeout?: number
  type?: 'success' | 'error'
  /** A button under the message; clicking it runs `onClick` and dismisses the toast. */
  action?: { label: string, onClick: () => void }
  /** Called once when it goes, however it goes — timed out, closed, its action, or {@link ToastHandle.hide}. */
  onHide?: () => void
}

/** What {@link toast} hands back, for a caller that needs to change or withdraw it. */
export interface ToastHandle {
  /** Replace the message, leaving the icon and action as they are. */
  setMessage: (message: string) => void
  /** Take it down now. Safe to call more than once. */
  hide: () => void
}

let toastContainer: HTMLElement | null = null
const instances = new Set<Toast>()

function getContainer() {
  if (toastContainer)
    return toastContainer

  const wrapper = (<div />)
  const shadow = wrapper.attachShadow({ mode: 'open' })

  const sheet = new CSSStyleSheet()
  sheet.replaceSync(style)

  if (process.env.BROWSER === 'firefox' && 'wrappedJSObject' in shadow) {
    // @ts-expect-error https://bugzilla.mozilla.org/show_bug.cgi?id=1817675
    shadow.wrappedJSObject.adoptedStyleSheets.push(sheet)
  }
  else {
    shadow.adoptedStyleSheets = [sheet]
  }

  toastContainer = (
    <div
      class="container"
      onMouseEnter={() => instances.forEach(toast => toast.stop())}
      onMouseLeave={() => instances.forEach(toast => toast.start())}
    />
  )

  shadow.appendChild(toastContainer)
  document.body.appendChild(wrapper)
  return toastContainer
}

// Loosely based on https://github.com/2nthony/vercel-toast
class Toast {
  readonly el: HTMLElement
  private readonly timeout: number
  private readonly type: ToastOptions['type']
  private timeoutId: number | null = null
  private hidden = false
  private readonly onHide: ToastOptions['onHide']

  constructor(message: string, { timeout = 5000, type, action, onHide }: ToastOptions = {}) {
    this.el = (
      <div
        class="toast"
        data-type={type}
        aria-live="polite"
        aria-atomic="true"
        aria-role="alert"
      >
        <div class="inner">
          {
            type && (
              <div class="icon">
                {type === 'success' ? <Success /> : <Error />}
              </div>
            )
          }
          <div class="text">
            <span class="message">{message}</span>
            {
              action && (
                <button
                  type="button"
                  class="action"
                  onClick={() => {
                    action.onClick()
                    this.hide()
                  }}
                >
                  {action.label}
                </button>
              )
            }
          </div>
          {
            // A toast that never times out has to be closable by hand.
            timeout === 0 && (
              <button type="button" class="close" aria-label="Dismiss" onClick={() => this.hide()}>×</button>
            )
          }
        </div>
      </div>
    )
    this.timeout = timeout
    this.type = type
    this.onHide = onHide

    instances.add(this)
  }

  show() {
    getContainer().appendChild(this.el)

    this.start()

    setTimeout(sortToast, 50)
  }

  setMessage(message: string): void {
    const span = this.el.querySelector('.message')
    if (span)
      span.textContent = message
  }

  hide(): void {
    const { el } = this
    if (!el || this.hidden)
      return
    this.hidden = true
    this.onHide?.()

    el.style.opacity = '0'
    el.style.visibility = 'hidden'
    el.style.transform = 'translateY(10px)'

    this.stop()

    setTimeout(() => {
      getContainer().removeChild(el)
      instances.delete(this)
      sortToast()
    }, 150)
  }

  stop() {
    if (this.timeoutId !== null)
      globalThis.clearTimeout(this.timeoutId)
  }

  start() {
    if (this.timeout === 0 || this.hidden)
      return
    this.stop()
    this.timeoutId = globalThis.setTimeout(() => this.hide(), this.timeout) as unknown as number
  }
}

export function toast(message: string, options?: ToastOptions): ToastHandle {
  const instance = new Toast(message, options)
  instance.show()
  return instance
}

function sortToast(): void {
  const toasts = Array.from(instances).reverse().slice(0, 4)

  const heights: Array<number> = []

  toasts.forEach((toast, index) => {
    const sortIndex = index + 1
    const el = toast.el as HTMLDivElement
    const height = +(el.getAttribute('data-height') || 0) || el.clientHeight

    heights.push(height)

    el.className = `toast toast-${sortIndex}`
    el.dataset.height = `${height}`
    el.style.setProperty('--index', `${sortIndex}`)
    el.style.setProperty('--height', `${height}px`)
    el.style.setProperty('--front-height', `${heights[0]}px`)

    if (sortIndex > 1) {
      const hoverOffsetY = heights
        .slice(0, sortIndex - 1)
        .reduce((res, next) => (res += next), 0)
      el.style.setProperty('--hover-offset-y', `-${hoverOffsetY}px`)
    }
    else {
      el.style.removeProperty('--hover-offset-y')
    }
  })
}
