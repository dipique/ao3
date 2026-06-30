import MdiClockCheck from '~icons/mdi/clock-check.jsx'
import MdiClockPlusOutline from '~icons/mdi/clock-plus-outline.jsx'
import MdiCloseCircleOutline from '~icons/mdi/close-circle-outline.jsx'
import MdiEyeCheck from '~icons/mdi/eye-check.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiStar from '~icons/mdi/star.jsx'

import type { MenuItem } from '#content_script/contextMenu.js'

import { DEFAULT_SERIES_HIGHLIGHT_COLOR, DEFAULT_WORK_HIGHLIGHT_COLOR, fetchToken, getArchiveLink, options, toast } from '#common'
import {
  attachMenuTrigger,
  buildIndicators,
  clearMenuTriggers,
  type IndicatorState,
  standardLinkItems,
} from '#content_script/contextTrigger.js'
import { clearEntityBehavior, entityBehavior, type EntityOptionKey, toggleEntityBehavior } from '#content_script/persistentFilters.js'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

/** A decorated work/series link and the indicator currently shown after it. */
interface EntityEntry {
  link: HTMLAnchorElement
  id: string
  indicator: HTMLElement | null
}

// ---------------------------------------------------------------------------
// Mark for later (works only). Session-scoped per work, shared across every
// blurb showing the same work, and folded into the work menu. The state can't be
// read from a blurb, so a work starts un-saved and reflects whatever you last did
// to it this page load.
// ---------------------------------------------------------------------------

interface MarkState { saved: boolean, busy: boolean }
const markState = new Map<string, MarkState>()

/** The page's own CSRF token, present in the head of any AO3 page. */
function pageToken(): string | null {
  return document.querySelector('meta[name="csrf-token"]')?.content ?? null
}

/**
 * Toggle a work's Marked for Later state with the same request AO3's own
 * "Mark for Later" / "Mark as Read" buttons make: a PATCH (tunnelled through
 * POST + `_method`) to `/works/:id/mark_for_later` or `/works/:id/mark_as_read`.
 */
export async function submitMark(workId: string, save: boolean): Promise<void> {
  const action = save ? 'mark_for_later' : 'mark_as_read'
  const token = pageToken() ?? await fetchToken()
  const res = await fetch(getArchiveLink(`/works/${workId}/${action}`), {
    method: 'POST',
    credentials: 'same-origin',
    // The action finishes by redirecting back to the listing. Keep the redirect
    // opaque (we don't want that page) and read it as success.
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ _method: 'patch', authenticity_token: token }).toString(),
  })
  if (res.type !== 'opaqueredirect' && !res.ok)
    throw new Error(`Mark request failed (${res.status})`)
}

// ---------------------------------------------------------------------------

abstract class FilterEntityToolbar extends Unit {
  /** `'work'` or `'series'` — used in labels. */
  protected abstract get noun(): 'work' | 'series'
  /** The path segment the entity's links use. */
  protected abstract get kind(): 'works' | 'series'
  /** The option key holding this kind's persistent filters. */
  protected abstract get optionKey(): EntityOptionKey
  /** Highlight colour shown on the star indicator when a highlight has no colour of its own. */
  protected abstract get defaultColor(): string
  /** Live registry of this kind's decorated links, shared across page runs. */
  protected abstract get entries(): EntityEntry[]
  /** Works fold in mark-for-later; series don't. */
  protected markEnabled(): boolean { return false }

  /**
   * Links to decorate: every `/works/:id` (or `/series/:id`) link, returning the
   * id and the link the menu/indicator hang off. Works use the blurb title;
   * series use each series link.
   */
  protected links(): { id: string, link: HTMLAnchorElement }[] {
    const idRe = new RegExp(`^/${this.kind}/(\\d+)(?:/|$)`)
    const out: { id: string, link: HTMLAnchorElement }[] = []
    const selector = this.kind === 'works'
      ? '.blurb .header h4.heading a[href*="/works/"]'
      : 'a[href*="/series/"]'
    for (const el of this.root.querySelectorAll<HTMLAnchorElement>(selector)) {
      let id: string | undefined
      try {
        id = new URL(el.href).pathname.match(idRe)?.[1]
      }
      catch {
        continue
      }
      if (id)
        out.push({ id, link: el })
    }
    return out
  }

  override async ready(): Promise<void> {
    this.entries.length = 0

    for (const { id, link } of this.links()) {
      const entry: EntityEntry = { link, id, indicator: null }
      this.entries.push(entry)
      attachMenuTrigger(link, () => this.buildMenu(id, link))
      this.syncIndicator(entry)
    }

    this.logger.debug(`Added ${this.noun} menus to ${this.entries.length} links.`)
  }

  async buildMenu(id: string, link: HTMLAnchorElement): Promise<MenuItem[]> {
    // Read the freshest filters so the checked state is current.
    const { filters } = await options.get(this.optionKey)
    const behavior = entityBehavior(filters, id)

    // The active behaviour is shown disabled (current state); "Clear" removes it.
    const items: MenuItem[] = [
      {
        icon: () => <MdiEyeOff />,
        label: `Hide ${this.noun}`,
        danger: true,
        active: behavior === 'hide',
        disabled: behavior === 'hide',
        onSelect: () => toggleEntityBehavior(this.optionKey, id, 'hide'),
      },
      {
        icon: () => <MdiEyeCheck />,
        label: 'Always show',
        active: behavior === 'invert',
        disabled: behavior === 'invert',
        onSelect: () => toggleEntityBehavior(this.optionKey, id, 'invert'),
      },
      {
        icon: () => <MdiStar />,
        label: 'Highlight',
        active: behavior === 'highlight',
        disabled: behavior === 'highlight',
        onSelect: () => toggleEntityBehavior(this.optionKey, id, 'highlight'),
      },
    ]
    if (behavior) {
      items.push({
        icon: () => <MdiCloseCircleOutline />,
        label: 'Clear',
        onSelect: () => clearEntityBehavior(this.optionKey, id),
      })
    }

    if (this.markEnabled()) {
      const state = markState.get(id) ?? { saved: false, busy: false }
      items.push({
        icon: () => (state.saved ? <MdiClockCheck /> : <MdiClockPlusOutline />),
        label: state.saved ? 'Mark as read' : 'Mark for later',
        separatorBefore: true,
        disabled: state.busy,
        onSelect: () => this.onMark(id),
      })
    }

    items.push(...standardLinkItems(link))
    return items
  }

  protected computeStates(id: string): IndicatorState[] {
    const states: IndicatorState[] = []
    const behavior = entityBehavior(this.options[this.optionKey].filters, id)
    if (behavior)
      states.push(behavior)
    if (this.markEnabled() && markState.get(id)?.saved)
      states.push('saved')
    return states
  }

  protected syncIndicator(entry: EntityEntry): void {
    const next = buildIndicators(this.computeStates(entry.id), { highlightColor: this.defaultColor })
    if (next)
      attachMenuTrigger(next, () => this.buildMenu(entry.id, entry.link), { indicator: true })

    if (entry.indicator && next)
      entry.indicator.replaceWith(next)
    else if (entry.indicator && !next)
      entry.indicator.remove()
    else if (!entry.indicator && next)
      entry.link.after(next)

    entry.indicator = next
  }

  async onMark(id: string): Promise<void> {
    const state = markState.get(id) ?? { saved: false, busy: false }
    if (state.busy)
      return
    const save = !state.saved
    state.busy = true
    markState.set(id, state)
    try {
      await submitMark(id, save)
      state.saved = save
      toast(
        save ? 'Saved for later.' : 'Marked as read — removed from your Marked for Later list.',
        { type: 'success' },
      )
    }
    catch (err) {
      this.logger.error(`Failed to update mark-for-later for work ${id}.`, err)
      toast('Could not update your Marked for Later list.', { type: 'error' })
    }
    finally {
      state.busy = false
      markState.set(id, state)
      // Reflect the saved-clock on every blurb showing this work.
      for (const entry of this.entries) {
        if (entry.id === id)
          this.syncIndicator(entry)
      }
    }
  }
}

const workEntries: EntityEntry[] = []
const seriesEntries: EntityEntry[] = []

export class FilterWorkToolbar extends FilterEntityToolbar {
  static override get name() { return 'FilterWorkToolbar' }

  // The work menu appears wherever its actions are useful: when work filters are
  // on (hide/highlight/always-show), or when mark-for-later is on.
  override get enabled() { return this.options.hideWorks.enabled || this.options.markForLaterToolbar }

  protected override get noun() { return 'work' as const }
  protected override get kind() { return 'works' as const }
  protected override get optionKey() { return 'hideWorks' as const }
  protected override get defaultColor() { return this.options.hideWorks.defaultHighlightColor || DEFAULT_WORK_HIGHLIGHT_COLOR }
  protected override get entries() { return workEntries }

  protected override markEnabled(): boolean {
    // Marking needs a logged-in session, and only when the feature is enabled.
    return this.options.markForLaterToolbar && document.body.classList.contains('logged-in')
  }

  static override async clean(): Promise<void> {
    workEntries.length = 0
    clearMenuTriggers()
  }
}

export class FilterSeriesToolbar extends FilterEntityToolbar {
  static override get name() { return 'FilterSeriesToolbar' }
  override get enabled() { return this.options.hideSeries.enabled }
  protected override get noun() { return 'series' as const }
  protected override get kind() { return 'series' as const }
  protected override get optionKey() { return 'hideSeries' as const }
  protected override get defaultColor() { return this.options.hideSeries.defaultHighlightColor || DEFAULT_SERIES_HIGHLIGHT_COLOR }
  protected override get entries() { return seriesEntries }

  static override async clean(): Promise<void> {
    seriesEntries.length = 0
    clearMenuTriggers()
  }
}
