import MdiTrashCan from '~icons/mdi/trash-can.jsx'

import type { Work } from '#content_script/blurb.js'

import { ADDON_CLASS } from '#common'
import React from '#dom'

/** The badge a work AO3 has deleted carries after its title. */
export const DELETED_BADGE_CLASS = `${ADDON_CLASS}--deleted`

const DAY_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * Put the "Deleted" badge on a drawn work AO3 has deleted ({@link Work.deleted}),
 * or take it off one that isn't. Cheap enough to run on every draw of a page,
 * which is what catches a work found deleted while it was already on screen.
 */
export function syncDeletedBadge(work: Work): void {
  const badge = work.el.querySelector(`.${DELETED_BADGE_CLASS}`)
  if (!work.deleted) {
    badge?.remove()
    return
  }
  if (badge)
    return
  const heading = work.el.querySelector('.header h4.heading') ?? work.el
  heading.append(
    <span class={`${ADDON_CLASS}  ${DELETED_BADGE_CLASS}`} data-ao3e-deleted="" title={`Deleted from AO3 · noticed ${DAY_FORMAT.format(work.deleted.at)}`}>
      <MdiTrashCan aria-hidden="true" />
      Deleted
    </span>,
  )
}
