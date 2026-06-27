import MdiAccountOff from '~icons/mdi/account-off.jsx'

import type { AuthorFilter } from '#common'

import { ADDON_CLASS, options, toast } from '#common'
import { isOrphanAccount } from '#content_script/authorPage.js'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const TOOLBAR_CLASS = `${ADDON_CLASS}--hide-author-toolbar`
const ACTIVE_CLASS = `${ADDON_CLASS}--hide-author-toolbar--active`

/** Author byline links AO3 marks with rel="author" (blurbs, work pages, etc.). */
const AUTHOR_LINK_SELECTOR = 'a[rel=author]'

interface AuthorLink {
  userId: string
  pseud?: string
}

/**
 * Every button on the page, keyed by author, so toggling one byline reflects on
 * all of that author's bylines immediately. Rebuilt on each `ready()`.
 */
const buttons: { button: HTMLButtonElement, userId: string }[] = []

/**
 * Whether the author (by userId, across all pseuds) is currently hidden. Only a
 * hide-behavior filter counts: a force-show (`'invert'`) or `'highlight'` rule
 * doesn't hide the author — this mirrors the "Hide author" context menu's notion
 * of the author being hidden.
 */
function isAuthorHidden(filters: AuthorFilter[], userId: string): boolean {
  const filter = filters.find(f => f.userId === userId && f.pseud === undefined)
  return !!filter && (filter.behavior === undefined || filter.behavior === 'hide')
}

function setButtonState(button: HTMLButtonElement, userId: string, hidden: boolean): void {
  button.classList.toggle(ACTIVE_CLASS, hidden)
  button.setAttribute('aria-pressed', String(hidden))
  const label = hidden
    ? `Show works by "${userId}" (remove from hidden authors)`
    : `Hide all works by "${userId}"`
  button.title = label
  button.setAttribute('aria-label', label)
}

/** Pull the userId (and pseud, if present) out of a `/users/:id/pseuds/:pseud` link. */
function parseAuthorLink(link: HTMLAnchorElement): AuthorLink | null {
  const parts = new URL(link.href).pathname.split('/').filter(Boolean)
  if (parts[0] !== 'users' || !parts[1])
    return null
  return { userId: parts[1], pseud: parts[2] === 'pseuds' ? parts[3] : undefined }
}

export class HideAuthorToolbar extends Unit {
  static override get name() { return 'HideAuthorToolbar' }
  override get enabled() { return this.options.hideAuthorToolbar }

  static override async clean(): Promise<void> {
    buttons.length = 0
  }

  override async ready(): Promise<void> {
    buttons.length = 0

    const { filters } = this.options.hideAuthors
    const links = document.querySelectorAll(AUTHOR_LINK_SELECTOR)
    for (const link of links) {
      if (!(link instanceof HTMLAnchorElement))
        continue
      const author = parseAuthorLink(link)
      if (!author)
        continue
      // The orphan account isn't a real user; there's nobody to hide.
      if (isOrphanAccount(author.userId))
        continue
      // clean() already removed previous buttons, but guard against duplicates.
      if (link.nextElementSibling?.classList.contains(TOOLBAR_CLASS))
        continue

      link.after(this.buildButton(author, filters))
    }

    this.logger.debug(`Added hide-author buttons to ${buttons.length} author links.`)
  }

  buildButton(author: AuthorLink, filters: AuthorFilter[]): HTMLButtonElement {
    const button = (
      <button type="button" class={`${ADDON_CLASS} ${TOOLBAR_CLASS}`} aria-pressed="false">
        <MdiAccountOff />
      </button>
    ) as HTMLElement as HTMLButtonElement

    setButtonState(button, author.userId, isAuthorHidden(filters, author.userId))

    button.addEventListener('click', (e) => {
      e.preventDefault()
      void this.onClick(author.userId)
    })

    buttons.push({ button, userId: author.userId })
    return button
  }

  async onClick(userId: string): Promise<void> {
    // Read the freshest list so we don't clobber a concurrent change (e.g. the
    // options page or the context menu editing it at the same time).
    const { filters } = await options.get('hideAuthors')

    const wasHidden = isAuthorHidden(filters, userId)
    const index = filters.findIndex(f => f.userId === userId && f.pseud === undefined)
    if (index !== -1)
      filters.splice(index, 1)

    // Toggle "hide": if the author wasn't already hidden (no rule, or a
    // force-show/highlight rule we just removed), add a hide rule; otherwise the
    // splice above already unhid them.
    const nowHidden = !wasHidden
    if (nowHidden)
      filters.push({ userId })

    await options.set({ hideAuthors: { enabled: true, filters } })

    toast(
      `Author "${userId}" has been ${nowHidden ? 'hidden' : 'unhidden'}.`,
      { type: 'success' },
    )

    // Reflect the new state immediately. The options-change listener re-runs the
    // units (rebuilding these buttons) shortly after, but that is debounced, so
    // this avoids a visible lag and keeps every byline for this author in sync.
    for (const entry of buttons) {
      if (entry.userId === userId)
        setButtonState(entry.button, userId, nowHidden)
    }
  }
}
