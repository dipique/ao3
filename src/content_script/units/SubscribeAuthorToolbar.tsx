import MdiBellOutline from '~icons/mdi/bell-outline.jsx'
import MdiBell from '~icons/mdi/bell.jsx'

import { ADDON_CLASS, getArchiveLink, toast } from '#common'
import { getAuthorPage, isOrphanAccount, resetAuthorPageCache } from '#content_script/authorPage.js'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const TOOLBAR_CLASS = `${ADDON_CLASS}--subscribe-author-toolbar`
const ACTIVE_CLASS = `${ADDON_CLASS}--subscribe-author-toolbar--active`

/** The hide-author button's class, so we can slot in right after it when present. */
const HIDE_AUTHOR_CLASS = `${ADDON_CLASS}--hide-author-toolbar`

/** Author byline links AO3 marks with rel="author" (blurbs, work pages, etc.). */
const AUTHOR_LINK_SELECTOR = 'a[rel=author]'

/**
 * Everything needed to (un)subscribe to a user, scraped from the subscribe form
 * on their page. Mirrors what AO3's own `ajax-create-destroy` handler submits,
 * so toggling behaves exactly like clicking the native Subscribe button.
 */
interface Subscription {
  /** The create action, e.g. `/users/me/subscriptions` (never includes an id). */
  baseAction: string
  token: string
  subscribableId: string
  subscribableType: string
  /** The subscription's id, present (and used for the destroy URL) while subscribed. */
  subscriptionId?: string
  subscribed: boolean
}

/** Per-author state, shared by every byline showing the same author. */
interface AuthorEntry {
  userId: string
  /** A byline href (a user/pseud page) that carries the subscribe form. */
  href: string
  subscription: Subscription | null
  resolving: boolean
  /** No subscribe form available (e.g. your own works, or logged out). */
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
 * Find the user-subscription form on a fetched page and read its current state.
 * Already-subscribed pages render the destroy variant (action `.../subscriptions/:id`,
 * with a `_method=delete` field), which we detect so the toggle goes the right way.
 */
function parseSubscription(doc: Document): Subscription | null {
  for (const form of doc.querySelectorAll('form.ajax-create-destroy')) {
    const type = form.querySelector('input[name="subscription[subscribable_type]"]')
    const id = form.querySelector('input[name="subscription[subscribable_id]"]')
    const token = form.querySelector('input[name="authenticity_token"]')
    if (!(type instanceof HTMLInputElement) || !(id instanceof HTMLInputElement) || !(token instanceof HTMLInputElement))
      continue
    // Only user subscriptions — the same markup is used for tags, series, etc.
    if (type.value !== 'User')
      continue

    const action = form.getAttribute('action') ?? ''
    const method = form.querySelector('input[name="_method"]')
    const idMatch = action.match(/^(.*\/subscriptions)\/(\d+)\/?$/)
    const subscribed = !!idMatch
      || (method instanceof HTMLInputElement && method.value.toLowerCase() === 'delete')

    return {
      baseAction: idMatch?.[1] ?? action,
      token: token.value,
      subscribableId: id.value,
      subscribableType: type.value,
      subscriptionId: idMatch?.[2],
      subscribed,
    }
  }
  return null
}

/**
 * Submit the subscribe (or unsubscribe) request and return the updated state.
 * The JSON response carries `item_id` only when a subscription was created, which
 * is how AO3's own script tells the two apart.
 */
async function submitSubscription(sub: Subscription): Promise<Subscription> {
  const creating = !sub.subscribed
  const path = creating ? sub.baseAction : `${sub.baseAction}/${sub.subscriptionId}`

  const body = new URLSearchParams({
    'authenticity_token': sub.token,
    'subscription[subscribable_id]': sub.subscribableId,
    'subscription[subscribable_type]': sub.subscribableType,
    'commit': creating ? 'Subscribe' : 'Unsubscribe',
  })
  // Rails routes the POST to #destroy when this override is present.
  if (!creating)
    body.set('_method', 'delete')

  const res = await fetch(getArchiveLink(path), {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept': 'application/json',
      'X-CSRF-Token': sub.token,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body.toString(),
  })
  if (!res.ok)
    throw new Error(`Subscription request failed (${res.status})`)

  const data = await res.json() as { item_id?: number | string | null }
  const nowSubscribed = data.item_id != null
  return {
    ...sub,
    subscribed: nowSubscribed,
    subscriptionId: nowSubscribed ? String(data.item_id) : undefined,
  }
}

function setButtonState(button: HTMLButtonElement, entry: AuthorEntry): void {
  const subscribed = entry.subscription?.subscribed ?? false
  button.classList.toggle(ACTIVE_CLASS, subscribed)
  button.setAttribute('aria-pressed', String(subscribed))
  button.disabled = entry.busy || entry.unavailable
  button.replaceChildren(subscribed ? <MdiBell /> : <MdiBellOutline />)

  let label: string
  if (entry.unavailable)
    label = `Can't subscribe to "${entry.userId}" from here`
  else if (entry.busy)
    label = `Updating your subscription to "${entry.userId}"…`
  else if (entry.resolving)
    label = `Checking your subscription to "${entry.userId}"…`
  else if (subscribed)
    label = `Unsubscribe from "${entry.userId}"`
  else
    label = `Subscribe to "${entry.userId}"`

  button.title = label
  button.setAttribute('aria-label', label)
}

function refresh(entry: AuthorEntry): void {
  for (const button of entry.buttons)
    setButtonState(button, entry)
}

export class SubscribeAuthorToolbar extends Unit {
  static override get name() { return 'SubscribeAuthorToolbar' }
  override get enabled() { return this.options.subscribeAuthorToolbar }

  static override async clean(): Promise<void> {
    entries.clear()
    resetAuthorPageCache()
  }

  override async ready(): Promise<void> {
    entries.clear()

    // Subscribing requires a logged-in session; skip entirely otherwise.
    if (!document.body.classList.contains('logged-in')) {
      this.logger.debug('Not logged in; skipping subscribe-author buttons.')
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
      // The orphan account isn't a real user and has no subscribe control.
      if (isOrphanAccount(userId))
        continue
      // No point offering to subscribe to yourself.
      if (me && userId.toLowerCase() === me)
        continue

      // Slot in right after the hide-author button when it's there, so the two
      // author controls sit together; otherwise straight after the byline.
      let anchor: Element = link
      if (link.nextElementSibling?.classList.contains(HIDE_AUTHOR_CLASS))
        anchor = link.nextElementSibling
      // clean() already removed previous buttons, but guard against duplicates.
      if (anchor.nextElementSibling?.classList.contains(TOOLBAR_CLASS))
        continue

      let entry = entries.get(userId)
      if (!entry) {
        entry = {
          userId,
          href: link.href,
          subscription: null,
          resolving: false,
          unavailable: false,
          busy: false,
          buttons: [],
        }
        entries.set(userId, entry)
      }
      anchor.after(this.buildButton(entry))
    }

    this.logger.debug(`Added subscribe buttons for ${entries.size} authors.`)
  }

  buildButton(entry: AuthorEntry): HTMLButtonElement {
    const button = (
      <button type="button" class={`${ADDON_CLASS}  ${TOOLBAR_CLASS}`} aria-pressed="false" />
    ) as HTMLElement as HTMLButtonElement

    entry.buttons.push(button)
    setButtonState(button, entry)

    // Resolve the current subscription state lazily on first hover so the icon
    // reflects it and the click is unambiguous (subscribe vs unsubscribe).
    button.addEventListener('pointerenter', () => void this.resolve(entry))
    button.addEventListener('click', (e) => {
      e.preventDefault()
      void this.onClick(entry)
    })
    return button
  }

  /** Fetch the author's page once and read the current subscription state. */
  async resolve(entry: AuthorEntry): Promise<void> {
    if (entry.subscription || entry.resolving || entry.unavailable)
      return
    entry.resolving = true
    refresh(entry)
    try {
      const doc = await getAuthorPage(entry.href)
      const sub = parseSubscription(doc)
      if (sub)
        entry.subscription = sub
      else
        entry.unavailable = true
    }
    catch (err) {
      this.logger.warn(`Could not load subscription state for "${entry.userId}".`, err)
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
    if (!entry.subscription) {
      await this.resolve(entry)
      if (!entry.subscription) {
        toast(`Subscribing to "${entry.userId}" isn't available here.`, { type: 'error' })
        return
      }
    }

    entry.busy = true
    refresh(entry)
    try {
      entry.subscription = await submitSubscription(entry.subscription)
      toast(
        entry.subscription.subscribed
          ? `Subscribed to "${entry.userId}".`
          : `Unsubscribed from "${entry.userId}".`,
        { type: 'success' },
      )
    }
    catch (err) {
      this.logger.error(`Failed to update subscription for "${entry.userId}".`, err)
      toast(`Could not update your subscription to "${entry.userId}".`, { type: 'error' })
    }
    finally {
      entry.busy = false
      refresh(entry)
    }
  }
}
