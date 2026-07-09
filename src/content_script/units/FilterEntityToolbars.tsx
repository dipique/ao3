import MdiClockCheck from '~icons/mdi/clock-check.jsx'
import MdiClockPlusOutline from '~icons/mdi/clock-plus-outline.jsx'
import MdiCloseCircleOutline from '~icons/mdi/close-circle-outline.jsx'
import MdiEyeCheck from '~icons/mdi/eye-check.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiStar from '~icons/mdi/star.jsx'

import type { MenuItem } from '#content_script/contextMenu.js'

import { DEFAULT_SERIES_HIGHLIGHT_COLOR, DEFAULT_WORK_HIGHLIGHT_COLOR, fetchAndParseDocument, fetchToken, getArchiveLink, options, toast } from '#common'
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

/**
 * A decorated work/series entity and the indicator currently shown after it.
 * `link` is usually the blurb/series link, but on an individual work page it's the
 * bare `<h2>` title (not a link) — see {@link workPageTitle}.
 */
interface EntityEntry {
  link: HTMLElement
  id: string
  indicator: HTMLElement | null
}

// ---------------------------------------------------------------------------
// Mark for later (works only). Session-scoped per work, shared across every
// blurb showing the same work, and folded into the work menu. The state can't be
// read from a blurb, so a work starts un-saved and reflects whatever you last did
// to it this page load.
// ---------------------------------------------------------------------------

/**
 * Per-work Marked-for-Later state. `known` marks a state we actually trust — set
 * once a work has been seeded (a listing that knows its works are saved), acted
 * on this session, or checked via {@link fetchWorkMarkState}. Until then the menu
 * treats the state as unknown and checks it on open rather than assuming un-saved.
 */
interface MarkState { saved: boolean, busy: boolean, known: boolean }
const markState = new Map<string, MarkState>()

/**
 * Seed the shared session mark-for-later state for works already known to be
 * saved. The state normally starts empty (it can't be read from a blurb), but
 * some listings know every work on them is marked for later — the Search Marked
 * for Later view above all — so seeding lets the work menu offer "Mark as read"
 * (not "Mark for later") and show the saved-clock indicator from the first
 * render. A work mid-request (busy) is left untouched.
 */
export function seedMarkedForLater(workIds: Iterable<string>): void {
  for (const id of workIds) {
    if (markState.get(id)?.busy)
      continue
    markState.set(id, { saved: true, busy: false, known: true })
  }
}

/**
 * Read a work's Marked-for-Later state from its fetched page. The work header
 * renders one mark button whose form action is `/works/:id/mark_as_read` when the
 * work is already marked for later, or `/works/:id/mark_for_later` when it isn't.
 * Returns null when neither is present (e.g. logged out or the markup changed).
 */
export function parseMarkedForLater(doc: Document): boolean | null {
  const form = doc.querySelector('form.button_to[action*="/mark_as_read"], form.button_to[action*="/mark_for_later"]')
  const action = form?.getAttribute('action') ?? ''
  if (action.includes('/mark_as_read'))
    return true
  if (action.includes('/mark_for_later'))
    return false
  return null
}

/** Fetch a work page and read its current Marked-for-Later state. */
async function fetchWorkMarkState(workId: string): Promise<boolean | null> {
  // view_adult skips the adult-content interstitial, which omits the mark button.
  const doc = await fetchAndParseDocument(getArchiveLink(`/works/${workId}?view_adult=true`))
  return parseMarkedForLater(doc)
}

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
  protected links(): { id: string, link: HTMLElement }[] {
    const idRe = new RegExp(`^/${this.kind}/(\\d+)(?:/|$)`)
    const out: { id: string, link: HTMLElement }[] = []
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

  async buildMenu(id: string, link: HTMLElement): Promise<MenuItem[]> {
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

    if (this.markEnabled())
      items.push(this.markItem(id))

    // The work-page title isn't a link, so the copy/open-link rows don't apply.
    if (link instanceof HTMLAnchorElement)
      items.push(...standardLinkItems(link))
    return items
  }

  /**
   * The Mark for Later / Mark as Read row. When the work's saved state is already
   * known (acted on this session, or seeded by a listing that knows its works are
   * saved — the Search Marked for Later view), it renders directly. Otherwise it
   * renders a disabled "Checking…" placeholder that opens *with* the menu and
   * patches itself once a background fetch of the work page reveals the real
   * state — so opening the menu never waits on the network.
   */
  private markItem(id: string): MenuItem {
    const known = markState.get(id)
    if (known?.known)
      return this.markAction(id, known.saved, known.busy)
    return {
      icon: () => <MdiClockPlusOutline />,
      label: 'Checking Marked for Later…',
      separatorBefore: true,
      disabled: true,
      resolve: async () => {
        const saved = await this.checkMarked(id)
        if (saved === null)
          return { icon: () => <MdiClockPlusOutline />, label: 'Mark for later (unavailable)', disabled: true }
        return this.markAction(id, saved, markState.get(id)?.busy ?? false)
      },
    }
  }

  /** The resolved, actionable Mark for Later / Mark as Read row. */
  private markAction(id: string, saved: boolean, busy: boolean): MenuItem {
    return {
      icon: () => (saved ? <MdiClockCheck /> : <MdiClockPlusOutline />),
      label: saved ? 'Mark as read' : 'Mark for later',
      separatorBefore: true,
      disabled: busy,
      onSelect: () => this.onMark(id),
    }
  }

  /**
   * Fetch the work page to read its current Marked-for-Later state, record it in
   * the shared session state (unless a toggle is mid-flight), and refresh the
   * saved-clock indicator on every blurb showing this work. Returns the saved
   * state, or null if it couldn't be determined.
   */
  private async checkMarked(id: string): Promise<boolean | null> {
    let saved: boolean | null
    try {
      saved = await fetchWorkMarkState(id)
    }
    catch (err) {
      this.logger.warn(`Could not load Marked for Later state for work ${id}.`, err)
      return null
    }
    if (saved === null)
      return null
    const state = markState.get(id) ?? { saved: false, busy: false, known: false }
    // A toggle in flight is the freshest intent — don't overwrite it.
    if (state.busy)
      return state.saved
    state.saved = saved
    state.known = true
    markState.set(id, state)
    for (const entry of this.entries) {
      if (entry.id === id)
        this.syncIndicator(entry)
    }
    return saved
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
      this.insertIndicator(entry, next)

    entry.indicator = next
  }

  /**
   * Place a freshly built indicator relative to its anchor. Blurb/series titles are
   * links, so the indicator sits right after them, inline in the heading. The work
   * page's own title is a bare `<h2>` block — append inside it so the indicator
   * stays on the title's line instead of dropping to the next.
   */
  protected insertIndicator(entry: EntityEntry, indicator: HTMLElement): void {
    if (entry.link instanceof HTMLAnchorElement)
      entry.link.after(indicator)
    else
      entry.link.append(indicator)
  }

  async onMark(id: string): Promise<void> {
    const state = markState.get(id) ?? { saved: false, busy: false, known: false }
    if (state.busy)
      return
    const save = !state.saved
    state.busy = true
    markState.set(id, state)
    try {
      await submitMark(id, save)
      state.saved = save
      // We now know this work's state first-hand, so future opens skip the check.
      state.known = true
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

/** The work id from a `/works/:id` URL, or null when we're not on a work page. */
function workPageId(): string | null {
  return location.pathname.match(/^\/works\/(\d+)(?:\/|$)/)?.[1] ?? null
}

/**
 * The individual work page's own title heading — a bare `<h2>`, not a link, so the
 * blurb-link selector misses it. Null on any other page.
 */
function workPageTitle(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>('#workskin > .preface.group > h2.title.heading')
}

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

  override async ready(): Promise<void> {
    this.seedWorkPageMark()
    await super.ready()
  }

  /**
   * On the blurb-less work page the title link doesn't exist, so decorate the
   * page's own `<h2>` title with the same work menu (and indicator).
   */
  protected override links(): { id: string, link: HTMLElement }[] {
    const found = super.links()
    const title = workPageTitle(this.root)
    const id = workPageId()
    if (title && id)
      found.push({ id, link: title })
    return found
  }

  /**
   * The work page carries its own Mark for Later / Mark as Read button, so read the
   * saved state straight from it — no background page-fetch the way a blurb needs.
   * Seeded before {@link ready} builds the menu so the title's action label and
   * saved indicator are right from the first render.
   */
  private seedWorkPageMark(): void {
    if (!this.markEnabled())
      return
    const id = workPageId()
    // Don't clobber a toggle already in flight for this work this session.
    if (!id || markState.get(id)?.busy)
      return
    const saved = parseMarkedForLater(document)
    if (saved !== null)
      markState.set(id, { saved, busy: false, known: true })
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
