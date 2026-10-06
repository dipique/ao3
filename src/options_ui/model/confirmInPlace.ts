/**
 * Confirm-in-place: a control whose action can't be taken back asks a second
 * time in its own place rather than in a dialog. The first press arms it, and
 * a second press while it is armed fires it.
 *
 * One control on the page is armed at most, so arming one disarms any other:
 * a confirmation left standing over the wrong button is how the wrong thing
 * gets deleted. An armed control reverts on its own after five seconds, so one
 * left on screen can't be pressed into later either.
 */

export interface ConfirmState {
  /** The armed control's id. */
  armed: string | null
  /** When it reverts, in milliseconds since the epoch. */
  until: number
}

export const CONFIRM_MS = 5000

export const DISARMED: ConfirmState = Object.freeze({ armed: null, until: 0 })

/** The control armed at `now`, if one is. */
export function armedAt(state: ConfirmState, now: number): string | null {
  return state.armed !== null && now < state.until ? state.armed : null
}

/** A press of the control `id` at `now`: whether it fires, and the state after it. */
export function press(state: ConfirmState, id: string, now: number): { state: ConfirmState, fire: boolean } {
  if (armedAt(state, now) === id)
    return { state: DISARMED, fire: true }
  return { state: { armed: id, until: now + CONFIRM_MS }, fire: false }
}
