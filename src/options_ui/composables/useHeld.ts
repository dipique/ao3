import type { Ref } from 'vue'

/**
 * `view` as drawn: it follows `view`, except that while `held()` it keeps what
 * it showed, so a view about to change again in a moment changes once. A view
 * coming into sight, or leaving it, is never held.
 */
export function useHeld<T>(view: Ref<T>, held: () => boolean): Readonly<Ref<T>> {
  const shown = shallowRef(view.value)
  watchEffect(() => {
    const now = view.value
    if (now == null || shown.value == null || !held())
      shown.value = now
  })
  return shown
}
