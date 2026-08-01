import { Unit } from '#content_script/Unit.js'
import { recordReadNow } from '#content_script/workMarks.js'

/**
 * Records a work as read when you press **AO3's own** "Mark as Read" button —
 * the one in a work's header (and anywhere else AO3 renders it). Our menu's read
 * action writes the mark directly; this covers the native path, so the read list
 * fills up as you use the site normally instead of only when you remember to use
 * the extension.
 *
 * AO3 renders the control as a `button_to` form that POSTs to
 * `/works/:id/mark_as_read` and redirects back, so pressing it navigates away.
 * The handler therefore has to be race-free without awaiting anything:
 * {@link recordReadNow} computes the new value from the already-loaded options
 * and dispatches the `storage.set` immediately. That write completes in the
 * browser process even though this frame is about to be torn down — only its
 * completion callback is lost. Nothing is prevented or delayed, so AO3's button
 * behaves exactly as it always has.
 */

/** AO3's mark-as-read control, wherever it appears. */
const FORM_SELECTOR = 'form.button_to[action*="/mark_as_read"]'

/**
 * Module-scoped so each run's `clean()` detaches the previous listener before
 * `ready()` attaches a fresh one — otherwise re-runs would stack handlers and
 * a disabled feature would keep recording.
 */
let submitHandler: ((e: Event) => void) | null = null

function detachHandler(): void {
  if (submitHandler) {
    document.removeEventListener('submit', submitHandler, true)
    submitHandler = null
  }
}

/** The work id from a `/works/:id/mark_as_read` form action, or null. */
function workIdFromAction(form: HTMLFormElement): string | null {
  // getAttribute, not `.action`: the property resolves to an absolute URL, and a
  // relative attribute is what AO3 actually emits.
  const action = form.getAttribute('action') ?? ''
  return action.match(/\/works\/(\d+)\/mark_as_read/)?.[1] ?? null
}

export class CaptureMarkAsRead extends Unit {
  static override get name() { return 'CaptureMarkAsRead' }

  override get enabled() { return this.options.workMarks.enabled }

  static override async clean(): Promise<void> {
    detachHandler()
  }

  override async ready(): Promise<void> {
    detachHandler()
    // Delegated + capture-phase, so it sees the submit regardless of when AO3
    // rendered the form (and works for forms added after this run).
    submitHandler = (e: Event) => {
      const form = (e.target as Element | null)?.closest?.(FORM_SELECTOR)
      if (!(form instanceof HTMLFormElement))
        return
      const id = workIdFromAction(form)
      if (!id)
        return
      if (recordReadNow(this.options.workMarks, id))
        this.logger.debug(`Recorded work ${id} as read from AO3's Mark as Read button.`)
    }
    document.addEventListener('submit', submitHandler, true)
  }
}
