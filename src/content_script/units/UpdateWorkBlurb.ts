import { parseWork } from '#content_script/blurb.js'
import { readRecords, storeWorks } from '#content_script/searchView/blurbStore.ts'
import { blurbFromLivePage } from '#content_script/searchView/workPageBlurb.tsx'
import { Unit } from '#content_script/Unit.js'
import { workPageId } from '#content_script/workPage.ts'

/** This page's blurb has been offered to the store: the page says the same on every re-run. */
let offered = false

/**
 * "Opportunistically update blurbs": a visit to a work's page brings the
 * work's stored blurb up to date from the page, when one is stored. The page's
 * blurb is second-best to a listing's, so it replaces one only where it knows
 * something newer (`decideBlurbWrite`); a work with no stored blurb gets none.
 */
export class UpdateWorkBlurb extends Unit {
  static override get name() { return 'UpdateWorkBlurb' }
  override get enabled() { return this.options.opportunisticBlurbs }

  override async ready(): Promise<void> {
    const id = workPageId()
    if (offered || !id)
      return
    // Before anything is awaited, so before the units after this one have
    // decorated the page.
    const blurb = blurbFromLivePage(id)
    if (!blurb)
      return
    offered = true
    if ((await readRecords([id])).get(id)?.html === undefined)
      return
    const work = parseWork(blurb, 0)
    work.src = 'workPage'
    work.seenAt = Date.now()
    await storeWorks([work]).catch(err => this.logger.error('Could not update this work\'s stored blurb', err))
  }
}
