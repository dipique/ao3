import type { MaybeRefOrGetter } from 'vue'

/**
 * Focus inside `root` that an update took away: the control that had it was
 * removed, as a button is when it turns into another, leaving the page's focus
 * on nothing, which sends a reader on the keyboard back to the top of the page.
 * Focus the reader moved themselves, to another control or to nothing by
 * clicking the page, isn't lost.
 *
 * `lost()` gives the control that lost it, while nothing else has focus, for
 * the caller to put focus somewhere near it.
 */
export function useLostFocus(root: MaybeRefOrGetter<HTMLElement | null | undefined>) {
  let last: HTMLElement | null = null

  useEventListener(root, 'focusin', (event: FocusEvent) => {
    last = event.target as HTMLElement
  })
  useEventListener(root, 'focusout', (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null
    if (next) {
      if (!toValue(root)?.contains(next))
        last = null
      return
    }
    // Focus went to nothing: the control was removed, or the reader clicked
    // the page, which leaves the control where it was.
    const left = event.target as HTMLElement
    setTimeout(() => {
      if (last === left && left.isConnected)
        last = null
    })
  })

  return {
    lost(): HTMLElement | null {
      const active = document.activeElement
      return last && !last.isConnected && (!active || active === document.body) ? last : null
    },
  }
}
