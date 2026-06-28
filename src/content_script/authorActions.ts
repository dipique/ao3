import { fetchAndParseDocument, getArchiveLink } from '#common'

/**
 * Network helpers for the author context menu's subscribe and mute rows.
 *
 * These read the current state out of a fetched author page and replay the exact
 * requests AO3's own Subscribe / Mute controls make, so a menu action behaves
 * identically to clicking the native button. Previously these lived inside the
 * `SubscribeAuthorToolbar` / `MuteAuthorToolbar` units; they were lifted out here
 * unchanged when those toolbars were folded into the single author menu.
 */

// ===========================================================================
// Subscriptions.
// ===========================================================================

/**
 * Everything needed to (un)subscribe to a user, scraped from the subscribe form
 * on their page. Mirrors what AO3's own `ajax-create-destroy` handler submits.
 */
export interface Subscription {
  /** The create action, e.g. `/users/me/subscriptions` (never includes an id). */
  baseAction: string
  token: string
  subscribableId: string
  subscribableType: string
  /** The subscription's id, present (and used for the destroy URL) while subscribed. */
  subscriptionId?: string
  subscribed: boolean
}

/**
 * Find the user-subscription form on a fetched page and read its current state.
 * Already-subscribed pages render the destroy variant (action `.../subscriptions/:id`,
 * with a `_method=delete` field), which we detect so the toggle goes the right way.
 */
export function parseSubscription(doc: Document): Subscription | null {
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
export async function submitSubscription(sub: Subscription): Promise<Subscription> {
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

// ===========================================================================
// Mutes.
// ===========================================================================

/**
 * The mute control on a user's page is a subnav link to a confirmation page
 * (`/users/:me/muted/users/confirm_mute?muted_id=:them`), which AO3 swaps for an
 * "Unmute" link once muted. We follow that link and submit the form it renders.
 */
const MUTE_LINK_SELECTOR = 'a[href*="/muted/users/confirm_"]'

/**
 * Read the mute control out of a fetched author page. Its href tells us both
 * where to drive the toggle and the current state (confirm_unmute ⇒ muted).
 */
export function parseMuteState(doc: Document): { confirmUrl: string, muted: boolean } | null {
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
export async function submitMuteForm(confirmUrl: string): Promise<void> {
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
