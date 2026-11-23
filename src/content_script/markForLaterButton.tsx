import type { MarkConfig } from '#common'

import { ADDON_CLASS } from '#common'
import React from '#dom'

import { markIcon, markOutlineIcon } from './markIcons.tsx'

const CLASS = `${ADDON_CLASS}--mark-for-later`

/**
 * The button beside a work's title that puts the work on Marked for Later in
 * one click: Marked for Later's own icon, outlined, in its colour. Once the work
 * is saved the title carries the filled icon instead, as a mark indicator.
 *
 * `saved` is the mark table's entry for Marked for Later, which is what says how
 * that state is drawn.
 */
export function buildMarkForLaterButton(saved: MarkConfig | undefined, { busy, onPress }: { busy: boolean, onPress: () => void }): HTMLButtonElement {
  const outline = markOutlineIcon(saved?.icon)
  const button = (
    <button
      type="button"
      class={`${ADDON_CLASS}  ${CLASS}${outline ? '' : `  ${CLASS}--traced`}`}
      data-ao3e-action="mark-for-later"
      title="Mark for later"
      aria-label="Mark for later"
    >
      {(outline ?? markIcon(saved?.icon))()}
    </button>
  ) as HTMLElement as HTMLButtonElement
  if (saved?.color)
    button.style.setProperty('--ao3e-indicator-color', saved.color)
  button.disabled = busy
  button.addEventListener('click', onPress)
  return button
}
