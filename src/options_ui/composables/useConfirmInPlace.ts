import type { ConfirmState } from '../model/confirmInPlace.ts'

import { DISARMED, press as pressControl } from '../model/confirmInPlace.ts'

/**
 * Confirm-in-place for the whole page: which control is armed, and pressing
 * one. What a press does is {@link file://../model/confirmInPlace.ts}; this
 * holds the page's one state and reverts an armed control when its time is up.
 *
 * A control names itself by an id unique on the page, and does its action only
 * when `press` says it fires.
 */

const state = shallowRef<ConfirmState>(DISARMED)
let revert: ReturnType<typeof setTimeout> | undefined

export function useConfirmInPlace() {
  return {
    /** Whether the control `id` is armed: one more press fires it. */
    armed: (id: string) => state.value.armed === id,
    /** Press the control `id`; true when this press fires it. */
    press: (id: string): boolean => {
      const now = Date.now()
      const next = pressControl(state.value, id, now)
      state.value = next.state
      clearTimeout(revert)
      const armed = next.state
      if (armed.armed !== null) {
        revert = setTimeout(() => {
          if (state.value === armed)
            state.value = DISARMED
        }, armed.until - now)
      }
      return next.fire
    },
  }
}
