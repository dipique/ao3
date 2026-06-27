import MdiAccountCancelOutline from '~icons/mdi/account-cancel-outline.jsx'
import MdiAccountCancel from '~icons/mdi/account-cancel.jsx'

import { ADDON_CLASS, fetchAndParseDocument, getArchiveLink, toast } from '#common'
import { getAuthorPage, resetAuthorPageCache } from '#content_script/authorPage.js'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const TOOLBAR_CLASS = `${ADDON_CLASS}--mute-author-toolbar`
const ACTIVE_CLASS = `${ADDON_CLASS}--mute-author-toolbar--active`

/** The other author-byline buttons, so we slot in to the right of them. */
const HIDE_AUTHOR_CLASS = `${ADDON_CLASS}--hide-author-toolbar`
const SUBSCRIBE_CLASS = `${ADDON_CLASS}--subscribe-author-toolbar`

/** Author byline links AO3 marks with rel="author" (blurbs, work pages, etc.). */
const AUTHOR_LINK_SELECTOR = 'a[rel=author]'

/**
 * The mute control on a user's page is a subnav link to a confirmation page
 * (`/users/:me/muted/users/confirm_mute?muted_id=:them`), which AO3 swaps for an
 * "Unmute" link once muted. We follow that link and submit the form it renders,
 * so a click does exactly what the native confirm → submit flow does.
 */
const MUTE_LINK_SELECTOR = 'a[href*="/muted/users/confirm_"]'

/** Per-author state, shared by every byline showing the same author. */
interface AuthorEntry {
  userId: string
  /** A byline href (a user/pseud page) whose subnav carries the mute link. */
  href: string
  resolved: boolean
  muted: boolean
  /**
   * Absolute URL of the confirm_mute / confirm_unmute page that drives the next
   * toggle. Null once unknown or gone stale (after a toggle the page must be
   * reloaded before the opposite action is possible).
   */
  confirmUrl: string | null
  resolving: boolean
  /** No mute control available (e.g. your own works, or logged out). */
  unavailable: boolean
  /** A request is in flight; block further clicks until it settles. */
  busy: boolean
  buttons: HTMLButtonElement[]
}

/** userId -> entry, so every byline for one author stays in sync. Rebuilt each ready(). */
const entries = new Map<string, AuthorEntry>()

/** Pull the userId out of a `/users/:id` or `/users/:id/pseuds/:pseud` link. */
function parseAuthorUserId(link: HTMLAnchorElement): string | null {
  const parts = new URL(link.href).pathname.split('/').filter(Boolean)
  return parts[0] === 'users' && parts[1] ? parts[1] : null
}

/**
 * Read the mute control out of a fetched author page. Its href tells us both
 * where to drive the toggle and the current state (confirm_unmute ⇒ muted).
 */
function parseMuteState(doc: Document): { confirmUrl: string, muted: boolean } | null {
  const link = doc.querySelector(MUTE_LINK_SELECTOR)
  if (!(link instanceof HTMLAnchorElement))
    return null
  const href = link.getAttribute('href') ?? ''
  if (!href)
    return null
  const muted = /confirm_unmute/.test(href) || link.textContent?.trim().toLowerCase() === 'unmute'
  return { confirmUrl: getArchiveLink(href), muted }
}

/**
 * Drive the mute (or unmute) by fetching its confirmation page and submitting the
 * form it renders — the same request the native "Yes, Mute User" button makes.
 * The form carries everything we need (CSRF token, target id, and a `_method`
 * override for the unmute/destroy case).
 */
async function submitMuteForm(confirmUrl: string): Promise<void> {
  const doc = await fetchAndParseDocument(confirmUrl)
  const form = doc.querySelector('form[action*="/muted/users"]')
  if (!(form instanceof HTMLFormElement))
    throw new Error('Could not find the mute confirmation form.')

  const action = form.getAttribute('action') ?? ''
  const token = form.querySelector('input[name="authenticity_token"]')
  const body = new URLSearchParams()
  for (const input of form.querySelectorAll('input[name]'))
    body.append(input.name, input.value)

  const res = await fetch(getArchiveLink(action), {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-CSRF-Token': token instanceof HTMLInputElement ? token.value : '',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body.toString(),
  })
  if (!res.ok)
    throw new Error(`Mute request failed (${res.status})`)
}

function setButtonState(button: HTMLButtonElement, entry: AuthorEntry): void {
  button.classList.toggle(ACTIVE_CLASS, entry.muted)
  button.setAttribute('aria-pressed', String(entry.muted))
  button.disabled = entry.busy || entry.unavailable
  button.replaceChildren(entry.muted ? <MdiAccountCancel /> : <MdiAccountCancelOutline />)

  let label: string
  if (entry.unavailable)
    label = `Can't mute "${entry.userId}" from here`
  else if (entry.busy)
    label = `Updating your mute of "${entry.userId}"…`
  else if (entry.resolving)
    label = `Checking whether "${entry.userId}" is muted…`
  else if (entry.muted)
    label = `Unmute "${entry.userId}" (show their works again)`
  else
    label = `Mute "${entry.userId}" (hide all their works from you)`

  button.title = label
  button.setAttribute('aria-label', label)
}

function refresh(entry: AuthorEntry): void {
  for (const button of entry.buttons)
    setButtonState(button, entry)
}

export class MuteAuthorToolbar extends Unit {
  static override get name() { return 'MuteAuthorToolbar' }
  override get enabled() { return this.options.muteAuthorToolbar }

  static override async clean(): Promise<void> {
    entries.clear()
    resetAuthorPageCache()
  }

  override async ready(): Promise<void> {
    entries.clear()

    // Muting requires a logged-in session; skip entirely otherwise.
    if (!document.body.classList.contains('logged-in')) {
      this.logger.debug('Not logged in; skipping mute-author buttons.')
      return
    }

    const me = this.options.user?.userId?.toLowerCase()
    const links = document.querySelectorAll(AUTHOR_LINK_SELECTOR)
    for (const link of links) {
      if (!(link instanceof HTMLAnchorElement))
        continue
      const userId = parseAuthorUserId(link)
      if (!userId)
        continue
      // No point offering to mute yourself.
      if (me && userId.toLowerCase() === me)
        continue

      // Slot in to the right of the hide/subscribe buttons so the author controls
      // sit together in a stable order; otherwise straight after the byline.
      let anchor: Element = link
      while (anchor.nextElementSibling
        && (anchor.nextElementSibling.classList.contains(HIDE_AUTHOR_CLASS)
          || anchor.nextElementSibling.classList.contains(SUBSCRIBE_CLASS))) {
        anchor = anchor.nextElementSibling
      }
      // clean() already removed previous buttons, but guard against duplicates.
      if (anchor.nextElementSibling?.classList.contains(TOOLBAR_CLASS))
        continue

      let entry = entries.get(userId)
      if (!entry) {
        entry = {
          userId,
          href: link.href,
          resolved: false,
          muted: false,
          confirmUrl: null,
          resolving: false,
          unavailable: false,
          busy: false,
          buttons: [],
        }
        entries.set(userId, entry)
      }
      anchor.after(this.buildButton(entry))
    }

    this.logger.debug(`Added mute buttons for ${entries.size} authors.`)
  }

  buildButton(entry: AuthorEntry): HTMLButtonElement {
    const button = (
      <button type="button" class={`${ADDON_CLASS} ${TOOLBAR_CLASS}`} aria-pressed="false" />
    ) as HTMLElement as HTMLButtonElement

    entry.buttons.push(button)
    setButtonState(button, entry)

    // Resolve the current mute state lazily on first hover so the icon reflects
    // it and the click is unambiguous (mute vs unmute).
    button.addEventListener('pointerenter', () => void this.resolve(entry))
    button.addEventListener('click', (e) => {
      e.preventDefault()
      void this.onClick(entry)
    })
    return button
  }

  /** Fetch the author's page once and read whether they're currently muted. */
  async resolve(entry: AuthorEntry): Promise<void> {
    if (entry.resolved || entry.resolving || entry.unavailable)
      return
    entry.resolving = true
    refresh(entry)
    try {
      const doc = await getAuthorPage(entry.href)
      const state = parseMuteState(doc)
      if (state) {
        entry.muted = state.muted
        entry.confirmUrl = state.confirmUrl
        entry.resolved = true
      }
      else {
        entry.unavailable = true
      }
    }
    catch (err) {
      this.logger.warn(`Could not load mute state for "${entry.userId}".`, err)
      entry.unavailable = true
    }
    finally {
      entry.resolving = false
      refresh(entry)
    }
  }

  async onClick(entry: AuthorEntry): Promise<void> {
    if (entry.busy)
      return
    if (!entry.resolved) {
      await this.resolve(entry)
      if (!entry.resolved) {
        toast(`Muting "${entry.userId}" isn't available here.`, { type: 'error' })
        return
      }
    }
    if (!entry.confirmUrl) {
      // Stale after a prior toggle this run; the page state must be re-read.
      toast(`Reload the page to change your mute of "${entry.userId}" again.`, { type: 'error' })
      return
    }

    const wasMuted = entry.muted
    entry.busy = true
    refresh(entry)
    try {
      await submitMuteForm(entry.confirmUrl)
      // Reflect the new state, but drop the confirm URL: it now points the wrong
      // way and the cached page is stale, so a reload is needed to toggle again.
      entry.muted = !wasMuted
      entry.confirmUrl = null
      toast(
        wasMuted
          ? `Unmuted "${entry.userId}".`
          : `Muted "${entry.userId}". Their works are now hidden from you.`,
        { type: 'success' },
      )
    }
    catch (err) {
      this.logger.error(`Failed to update mute for "${entry.userId}".`, err)
      toast(`Could not update your mute of "${entry.userId}".`, { type: 'error' })
    }
    finally {
      entry.busy = false
      refresh(entry)
    }
  }
}
