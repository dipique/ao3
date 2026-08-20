import { noteMarkedForLater } from '#content_script/markedForLaterIndex.js'
import { Unit } from '#content_script/Unit.js'
import { applyMarkGroup } from '#content_script/workMarks.js'

/**
 * Keeps our own record in step with **AO3's own** mark buttons — the `li.mark`
 * form in a work's header, and anywhere else the archive renders one. Two things
 * ride on one of those being pressed: the local read mark, and the cached
 * Marked for Later index that puts the saved indicator on listings.
 *
 * Pressing one of those does exactly what the matching item in our work menu
 * does, because both end up in the same mark writers. Without this the two drift
 * apart the moment you use the archive's UI instead of ours: you'd mark a work
 * read on the work page and it would keep turning up in listings.
 *
 * Both directions are handled, because Read and Marked for Later are opposite
 * ends of one decision:
 *
 * - **Mark as Read** — you're done with it, so record the read mark. It also
 *   comes off the Marked for Later list, which the index has to hear about or
 *   every listing goes on showing the saved indicator on a work you just cleared.
 * - **Mark for Later** — it's back on the to-read pile, so clear the read mark
 *   and add it to the index. Otherwise hiding read works would go on hiding the
 *   very work you just chose to come back to.
 *
 * Both directions go through {@link applyMarkGroup}, not a specific mark: a work
 * you'd already called "gross" is read too, and AO3's blunt button must not
 * quietly downgrade that to a plain read mark.
 *
 * AO3 renders these as `button_to` forms that POST and redirect, so pressing one
 * navigates away. The handler therefore never awaits and never calls
 * `preventDefault` — it dispatches the storage writes and lets the form submit
 * exactly as it always has.
 */

/** AO3's mark controls, either direction. */
const FORM_SELECTOR = 'form.button_to[action*="/mark_as_read"], form.button_to[action*="/mark_for_later"]'

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

/** The work id and direction a mark form represents, or null if it isn't one. */
function parseMarkForm(form: HTMLFormElement): { id: string, read: boolean } | null {
  // getAttribute, not `.action`: the property resolves to an absolute URL, and a
  // relative attribute is what AO3 actually emits.
  const action = form.getAttribute('action') ?? ''
  const match = action.match(/\/works\/(\d+)\/(mark_as_read|mark_for_later)/)
  if (!match)
    return null
  return { id: match[1]!, read: match[2] === 'mark_as_read' }
}

export class CaptureMarkButtons extends Unit {
  static override get name() { return 'CaptureMarkButtons' }

  // Either record rides on these buttons, so one being on is enough (each side
  // effect below is gated on its own feature).
  override get enabled() { return this.options.workMarks.enabled || this.options.markForLaterToolbar }

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
      const mark = parseMarkForm(form)
      if (!mark)
        return
      // A no-op when our own menu already applied it before pressing this button.
      if (this.options.workMarks.enabled && applyMarkGroup(this.options.workMarks, mark.id, mark.read))
        this.logger.debug(`Work ${mark.id} marked ${mark.read ? 'read' : 'unread'} from AO3's own button.`)
      // Mark as Read takes the work off the list; Mark for Later puts it on.
      // (A no-op unless FilterWorkToolbar has loaded the index for this page.)
      noteMarkedForLater(mark.id, !mark.read)
    }
    document.addEventListener('submit', submitHandler, true)
  }
}
