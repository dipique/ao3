import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiEye from '~icons/mdi/eye.jsx'

import { ADDON_CLASS } from '#common'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const TOOLBAR_CLASS = `${ADDON_CLASS}--filter-toolbar`
const BUTTON_CLASS = `${ADDON_CLASS}--filter-toolbar--button`

/** Toggled on <body> to temporarily reveal tag-filtered works (see CSS). */
const PEEK_CLASS = `${ADDON_CLASS}--peek-tag-hidden`

/** Blurbs HideWorks hid (at least partly) because of a tag filter. */
const HIDDEN_BY_TAGS_SELECTOR = 'li[data-ao3e-hidden-by~="tags"]'

/**
 * A small floating control shown on listing pages where tag filters hid one or
 * more works. Clicking it toggles a body class that reveals those works (and
 * hides them again) without touching the saved filters — a quick "peek at what's
 * filtered" that resets on reload.
 *
 * It runs after HideWorks so the hidden markers it counts are already in place.
 */
export class FilterToolbar extends Unit {
  static override get name() { return 'FilterToolbar' }
  override get enabled() { return this.options.filterToolbar && this.options.hideTags.enabled }

  static override async clean(): Promise<void> {
    document.body.classList.remove(PEEK_CLASS)
  }

  override async ready(): Promise<void> {
    const count = document.querySelectorAll(HIDDEN_BY_TAGS_SELECTOR).length
    if (count === 0) {
      this.logger.debug('No tag-filtered works on this page; skipping filter toolbar.')
      return
    }

    document.body.append(this.buildToolbar(count))
    this.logger.debug(`Filter toolbar added for ${count} tag-filtered works.`)
  }

  buildToolbar(count: number): HTMLElement {
    const noun = count === 1 ? 'work' : 'works'
    const icon: HTMLElement = <span class={`${ADDON_CLASS}--filter-toolbar--icon`} />
    const text: HTMLElement = <span />
    const button: HTMLButtonElement = (
      <button type="button" class={BUTTON_CLASS} aria-pressed="false">
        {icon}
        {text}
      </button>
    ) as HTMLElement as HTMLButtonElement

    const sync = () => {
      const peeking = document.body.classList.contains(PEEK_CLASS)
      icon.replaceChildren(peeking ? <MdiEyeOff /> : <MdiEye />)
      text.textContent = `${peeking ? 'Hide' : 'Show'} ${count} filtered ${noun}`
      button.setAttribute('aria-pressed', String(peeking))
      const label = peeking
        ? 'Re-hide works your tag filters hid'
        : 'Temporarily show works your tag filters hid (does not change your filters)'
      button.title = label
      button.setAttribute('aria-label', label)
    }

    button.addEventListener('click', () => {
      document.body.classList.toggle(PEEK_CLASS)
      sync()
    })
    sync()

    return <div class={`${ADDON_CLASS} ${TOOLBAR_CLASS}`}>{button}</div>
  }
}
