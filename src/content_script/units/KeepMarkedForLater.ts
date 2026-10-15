import { parseUser } from '#common'
import { putOnMarkedForLater } from '#content_script/markedForLaterCopy.ts'
import { loadMarkedForLaterIndex, onSavedChange } from '#content_script/markedForLaterIndex.js'
import { blurbFromLivePage } from '#content_script/searchView/workPageBlurb.tsx'
import { Unit } from '#content_script/Unit.js'
import { parseMarkedForLater } from '#content_script/units/FilterEntityToolbars.tsx'
import { workPageId } from '#content_script/workPage.ts'

/** This run's subscription to the saved-work index, taken down by the next clean. */
let stopHearing: (() => void) | null = null

/** The visit has been kept: the page's own markup says the same on every re-run. */
let visitKept = false

/**
 * Keeps the stored copy of your Marked for Later list in step from a work's own
 * page, so the list opens with the work on it rather than waiting for its next
 * reload. A work goes first on the copy, with its blurb built from the page,
 * when the page is visited while it is on the list, and when it is saved for
 * later while the page is open — from the page, or from another tab.
 */
export class KeepMarkedForLater extends Unit {
  static override get name() { return 'KeepMarkedForLater' }
  override get enabled() { return this.options.searchMarkedForLater }

  static override async clean(): Promise<void> {
    stopHearing?.()
    stopHearing = null
  }

  override async ready(): Promise<void> {
    const id = workPageId()
    if (!id || !document.body.classList.contains('logged-in'))
      return
    const userId = parseUser(document)?.userId
    if (!userId)
      return
    // Before anything is awaited, so before the units after this one have
    // decorated the page.
    const blurb = blurbFromLivePage(id)
    if (!blurb)
      return

    const keep = (): Promise<void> => putOnMarkedForLater(userId, blurb, 'workPage')
      .catch(err => this.logger.error('Could not keep this work on your Marked for Later list', err))
    stopHearing?.()
    stopHearing = onSavedChange((changed, saved) => {
      if (changed === id && saved)
        void keep()
    })
    await loadMarkedForLaterIndex(userId).catch(err => this.logger.error('Could not read the saved-work index', err))

    if (!visitKept && parseMarkedForLater(document) === true) {
      visitKept = true
      await keep()
    }
  }
}
