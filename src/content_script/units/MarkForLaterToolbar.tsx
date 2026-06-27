import MdiClockCheck from '~icons/mdi/clock-check.jsx'
import MdiClockPlusOutline from '~icons/mdi/clock-plus-outline.jsx'

import { ADDON_CLASS, fetchToken, getArchiveLink, toast } from '#common'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const TOOLBAR_CLASS = `${ADDON_CLASS}--mark-for-later-toolbar`
const ACTIVE_CLASS = `${ADDON_CLASS}--mark-for-later-toolbar--active`

/**
 * A blurb's title link points at the work root (`/works/:id`); the author link
 * next to it goes to `/users/...`, so matching the works path selects only titles.
 */
const TITLE_LINK_SELECTOR = '.blurb .header h4.heading a[href^="/works/"]'

/** Per-work state, shared by every blurb showing the same work. Rebuilt each ready(). */
interface WorkEntry {
  workId: string
  /** Whether the work is currently in the user's Marked for Later list. */
  saved: boolean
  /** A request is in flight; block further clicks until it settles. */
  busy: boolean
  buttons: HTMLButtonElement[]
}

/** workId -> entry, so a work appearing in several blurbs stays in sync. */
const entries = new Map<string, WorkEntry>()

/**
 * The work id from a `/works/:id` title link (also matches a `/works/:id/chapters/…`
 * link, which some listings use), or null for non-work links like `/works/search`.
 */
function parseWorkId(link: HTMLAnchorElement): string | null {
  return new URL(link.href).pathname.match(/^\/works\/(\d+)(?:\/|$)/)?.[1] ?? null
}

/** The page's own CSRF token, present in the head of any AO3 page. */
function pageToken(): string | null {
  return document.querySelector('meta[name="csrf-token"]')?.content ?? null
}

/**
 * Toggle a work's Marked for Later state by making the same request AO3's own
 * "Mark for Later" / "Mark as Read" action buttons make: a PATCH (tunnelled
 * through POST + `_method`, with the CSRF token as a form field) to
 * `/works/:id/mark_for_later` or `/works/:id/mark_as_read`.
 */
async function submitMark(workId: string, save: boolean): Promise<void> {
  const action = save ? 'mark_for_later' : 'mark_as_read'
  const token = pageToken() ?? await fetchToken()
  const res = await fetch(getArchiveLink(`/works/${workId}/${action}`), {
    method: 'POST',
    credentials: 'same-origin',
    // The action finishes by redirecting back to the listing. We don't want to
    // download that page, so keep the redirect opaque and read it as success.
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ _method: 'patch', authenticity_token: token }).toString(),
  })
  if (res.type !== 'opaqueredirect' && !res.ok)
    throw new Error(`Mark request failed (${res.status})`)
}

function setButtonState(button: HTMLButtonElement, entry: WorkEntry): void {
  button.classList.toggle(ACTIVE_CLASS, entry.saved)
  button.setAttribute('aria-pressed', String(entry.saved))
  button.disabled = entry.busy
  button.replaceChildren(entry.saved ? <MdiClockCheck /> : <MdiClockPlusOutline />)

  const label = entry.busy
    ? 'Updating your Marked for Later list…'
    : entry.saved
      ? 'Marked for later — click to mark as read'
      : 'Save for later'
  button.title = label
  button.setAttribute('aria-label', label)
}

function refresh(entry: WorkEntry): void {
  for (const button of entry.buttons)
    setButtonState(button, entry)
}

/**
 * Adds a "Save for later" toggle next to each work title on listings, so a work
 * can be added to (or removed from) your Marked for Later list without opening it.
 * Marking is a session action, so the state can't be read from the blurb — the
 * button starts as "save", then reflects whatever you last did to it this run.
 */
export class MarkForLaterToolbar extends Unit {
  static override get name() { return 'MarkForLaterToolbar' }
  override get enabled() { return this.options.markForLaterToolbar }

  static override async clean(): Promise<void> {
    entries.clear()
  }

  override async ready(): Promise<void> {
    entries.clear()

    // Marking for later requires a logged-in session; skip entirely otherwise.
    if (!document.body.classList.contains('logged-in')) {
      this.logger.debug('Not logged in; skipping mark-for-later buttons.')
      return
    }

    const links = document.querySelectorAll(TITLE_LINK_SELECTOR)
    for (const link of links) {
      if (!(link instanceof HTMLAnchorElement))
        continue
      const workId = parseWorkId(link)
      if (!workId)
        continue
      // clean() already removed previous buttons, but guard against duplicates.
      if (link.nextElementSibling?.classList.contains(TOOLBAR_CLASS))
        continue

      let entry = entries.get(workId)
      if (!entry) {
        entry = { workId, saved: false, busy: false, buttons: [] }
        entries.set(workId, entry)
      }
      link.after(this.buildButton(entry))
    }

    this.logger.debug(`Added mark-for-later buttons for ${entries.size} works.`)
  }

  buildButton(entry: WorkEntry): HTMLButtonElement {
    const button = (
      <button type="button" class={`${ADDON_CLASS} ${TOOLBAR_CLASS}`} aria-pressed="false" />
    ) as HTMLElement as HTMLButtonElement

    entry.buttons.push(button)
    setButtonState(button, entry)

    button.addEventListener('click', (e) => {
      e.preventDefault()
      void this.onClick(entry)
    })
    return button
  }

  async onClick(entry: WorkEntry): Promise<void> {
    if (entry.busy)
      return
    const save = !entry.saved
    entry.busy = true
    refresh(entry)
    try {
      await submitMark(entry.workId, save)
      entry.saved = save
      toast(
        save
          ? 'Saved for later.'
          : 'Marked as read — removed from your Marked for Later list.',
        { type: 'success' },
      )
    }
    catch (err) {
      this.logger.error(`Failed to update mark-for-later for work ${entry.workId}.`, err)
      toast('Could not update your Marked for Later list.', { type: 'error' })
    }
    finally {
      entry.busy = false
      refresh(entry)
    }
  }
}
