import MdiAccountCancelOutline from '~icons/mdi/account-cancel-outline.jsx'
import MdiAccountCancel from '~icons/mdi/account-cancel.jsx'
import MdiAccountMinus from '~icons/mdi/account-minus.jsx'
import MdiAccountOff from '~icons/mdi/account-off.jsx'
import MdiBellOutline from '~icons/mdi/bell-outline.jsx'
import MdiBell from '~icons/mdi/bell.jsx'
import MdiCloseCircleOutline from '~icons/mdi/close-circle-outline.jsx'
import MdiEyeCheck from '~icons/mdi/eye-check.jsx'
import MdiStar from '~icons/mdi/star.jsx'

import type { MenuItem } from '#content_script/contextMenu.js'

import { options, ruleTargetColor, toast } from '#common'
import { parseMuteState, parseSubscription, submitMuteForm, submitSubscription, type Subscription } from '#content_script/authorActions.js'
import { getAuthorPage, isOrphanAccount, resetAuthorPageCache } from '#content_script/authorPage.js'
import {
  attachMenuTrigger,
  buildIndicators,
  clearMenuTriggers,
  type IndicatorState,
  standardLinkItems,
} from '#content_script/contextTrigger.js'
import { authorKey, clearRule, ruleBehavior, toggleRuleBehavior } from '#content_script/persistentFilters.js'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

/** Author byline links AO3 marks with rel="author" (blurbs, work pages, etc.). */
const AUTHOR_LINK_SELECTOR = 'a[rel=author]'

interface AuthorLink {
  userId: string
  pseud?: string
  href: string
}

/** Which actions this author byline can offer (computed once per run). */
interface AuthorCaps {
  hide: boolean
  subscribe: boolean
  mute: boolean
}

/** A decorated byline and the indicator shown after it. */
interface AuthorEntry {
  link: HTMLAnchorElement
  author: AuthorLink
  highlightColor: string
  indicator: HTMLElement | null
}

const entries: AuthorEntry[] = []

/** Pull the userId (and pseud, if present) out of a `/users/:id/pseuds/:pseud` link. */
function parseAuthorLink(link: HTMLAnchorElement): AuthorLink | null {
  const parts = new URL(link.href).pathname.split('/').filter(Boolean)
  if (parts[0] !== 'users' || !parts[1])
    return null
  return { userId: parts[1], pseud: parts[2] === 'pseuds' ? parts[3] : undefined, href: link.href }
}

export class HideAuthorToolbar extends Unit {
  static override get name() { return 'HideAuthorToolbar' }

  // The author menu unit is enabled if any of its sub-features is on.
  override get enabled() {
    return this.options.hideAuthorToolbar || this.options.subscribeAuthorToolbar || this.options.muteAuthorToolbar
  }

  static override async clean(): Promise<void> {
    entries.length = 0
    clearMenuTriggers()
    resetAuthorPageCache()
  }

  /** Work out which actions a byline supports, given the current options/session. */
  private caps(userId: string): AuthorCaps {
    const orphan = isOrphanAccount(userId)
    const loggedIn = document.body.classList.contains('logged-in')
    const me = this.options.user?.userId?.toLowerCase()
    const self = !!me && userId.toLowerCase() === me
    return {
      hide: this.options.hideAuthorToolbar && !orphan,
      subscribe: this.options.subscribeAuthorToolbar && loggedIn && !self && !orphan,
      mute: this.options.muteAuthorToolbar && loggedIn && !self && !orphan,
    }
  }

  override async ready(): Promise<void> {
    entries.length = 0

    const highlightColor = ruleTargetColor('author', this.options.rules.colors)

    for (const link of this.root.querySelectorAll<HTMLAnchorElement>(AUTHOR_LINK_SELECTOR)) {
      const author = parseAuthorLink(link)
      if (!author)
        continue
      const caps = this.caps(author.userId)
      // Nothing to offer (e.g. the orphan account, or your own byline with only
      // subscribe/mute enabled) — leave the native menu alone.
      if (!caps.hide && !caps.subscribe && !caps.mute)
        continue

      const entry: AuthorEntry = { link, author, highlightColor, indicator: null }
      entries.push(entry)
      attachMenuTrigger(link, () => this.buildMenu(author, link), { clickToOpen: this.options.openMenuOnClick })
      this.syncIndicator(entry)
    }

    this.logger.debug(`Added author menus to ${entries.length} bylines.`)
  }

  async buildMenu(author: AuthorLink, link: HTMLAnchorElement): Promise<MenuItem[]> {
    const caps = this.caps(author.userId)
    const items: MenuItem[] = []

    if (caps.hide) {
      const { filters } = await options.get('rules')
      const key = authorKey(author.userId)
      const behavior = ruleBehavior(filters, key)
      // The active behaviour is shown disabled (current state); "Clear" removes it.
      items.push(
        {
          icon: () => <MdiAccountOff />,
          label: 'Hide author',
          scope: 'settings',
          danger: true,
          active: behavior === 'hide',
          disabled: behavior === 'hide',
          onSelect: () => toggleRuleBehavior(key, 'hide'),
        },
        {
          icon: () => <MdiEyeCheck />,
          label: 'Always show',
          scope: 'settings',
          active: behavior === 'invert',
          disabled: behavior === 'invert',
          onSelect: () => toggleRuleBehavior(key, 'invert'),
        },
        {
          icon: () => <MdiStar />,
          label: 'Highlight',
          scope: 'settings',
          active: behavior === 'highlight',
          disabled: behavior === 'highlight',
          onSelect: () => toggleRuleBehavior(key, 'highlight'),
        },
      )
      if (behavior) {
        items.push({
          icon: () => <MdiCloseCircleOutline />,
          label: 'Clear',
          scope: 'settings',
          onSelect: () => clearRule(key),
        })
      }
      if (author.pseud !== undefined) {
        items.push({
          icon: () => <MdiAccountMinus />,
          label: 'Hide this pseud',
          scope: 'settings',
          danger: true,
          active: ruleBehavior(filters, authorKey(author.userId, author.pseud)) === 'hide',
          onSelect: () => toggleRuleBehavior(authorKey(author.userId, author.pseud), 'hide'),
        })
      }
    }

    if (caps.subscribe)
      items.push(this.subscribeItem(author))
    if (caps.mute)
      items.push(this.muteItem(author))

    // standardLinkItems carries its own scope, so it opens its own group.
    items.push(...standardLinkItems(link))
    return items
  }

  /** The Subscribe/Unsubscribe row — a placeholder that resolves via a page fetch. */
  private subscribeItem(author: AuthorLink): MenuItem {
    return {
      icon: () => <MdiBellOutline />,
      label: 'Checking subscription…',
      scope: 'account',
      disabled: true,
      resolve: async () => {
        try {
          const sub = parseSubscription(await getAuthorPage(author.href))
          if (!sub)
            return { icon: () => <MdiBellOutline />, label: 'Subscribe (unavailable)', disabled: true }
          return {
            icon: () => (sub.subscribed ? <MdiBell /> : <MdiBellOutline />),
            label: sub.subscribed ? 'Unsubscribe' : 'Subscribe',
            active: sub.subscribed,
            onSelect: () => this.onSubscribe(author.userId, sub),
          }
        }
        catch (err) {
          this.logger.warn(`Could not load subscription state for "${author.userId}".`, err)
          return { icon: () => <MdiBellOutline />, label: 'Subscribe (unavailable)', disabled: true }
        }
      },
    }
  }

  /** The Mute/Unmute row — a placeholder that resolves via a page fetch. */
  private muteItem(author: AuthorLink): MenuItem {
    return {
      icon: () => <MdiAccountCancelOutline />,
      label: 'Checking mute…',
      scope: 'account',
      disabled: true,
      resolve: async () => {
        try {
          const state = parseMuteState(await getAuthorPage(author.href))
          if (!state)
            return { icon: () => <MdiAccountCancelOutline />, label: 'Mute (unavailable)', disabled: true }
          return {
            icon: () => (state.muted ? <MdiAccountCancel /> : <MdiAccountCancelOutline />),
            label: state.muted ? 'Unmute' : 'Mute',
            active: state.muted,
            danger: !state.muted,
            onSelect: () => this.onMute(author.userId, state.confirmUrl, state.muted),
          }
        }
        catch (err) {
          this.logger.warn(`Could not load mute state for "${author.userId}".`, err)
          return { icon: () => <MdiAccountCancelOutline />, label: 'Mute (unavailable)', disabled: true }
        }
      },
    }
  }

  async onSubscribe(userId: string, sub: Subscription): Promise<void> {
    try {
      const next = await submitSubscription(sub)
      toast(
        next.subscribed ? `Subscribed to "${userId}".` : `Unsubscribed from "${userId}".`,
        { type: 'success' },
      )
    }
    catch (err) {
      this.logger.error(`Failed to update subscription for "${userId}".`, err)
      toast(`Could not update your subscription to "${userId}".`, { type: 'error' })
    }
    finally {
      // The cached author page is now stale; drop it so the next open re-reads state.
      resetAuthorPageCache()
    }
  }

  async onMute(userId: string, confirmUrl: string, wasMuted: boolean): Promise<void> {
    try {
      await submitMuteForm(confirmUrl)
      toast(
        wasMuted
          ? `Unmuted "${userId}".`
          : `Muted "${userId}". Their works are now hidden from you.`,
        { type: 'success' },
      )
    }
    catch (err) {
      this.logger.error(`Failed to update mute for "${userId}".`, err)
      toast(`Could not update your mute of "${userId}".`, { type: 'error' })
    }
    finally {
      resetAuthorPageCache()
    }
  }

  private syncIndicator(entry: AuthorEntry): void {
    const states: IndicatorState[] = []
    const behavior = ruleBehavior(this.options.rules.filters, authorKey(entry.author.userId))
    if (behavior)
      states.push(behavior)

    const next = buildIndicators(states, { highlightColor: entry.highlightColor })
    if (next)
      attachMenuTrigger(next, () => this.buildMenu(entry.author, entry.link), { indicator: true })

    if (entry.indicator && next)
      entry.indicator.replaceWith(next)
    else if (entry.indicator && !next)
      entry.indicator.remove()
    else if (!entry.indicator && next)
      entry.link.after(next)

    entry.indicator = next
  }
}
