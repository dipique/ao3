import MdiBookCheck from '~icons/mdi/book-check.jsx'
import MdiBookOutline from '~icons/mdi/book-outline.jsx'
import MdiClockCheck from '~icons/mdi/clock-check.jsx'
import MdiClockPlusOutline from '~icons/mdi/clock-plus-outline.jsx'
import MdiCloseCircleOutline from '~icons/mdi/close-circle-outline.jsx'
import MdiEyeCheck from '~icons/mdi/eye-check.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiHeartOutline from '~icons/mdi/heart-outline.jsx'
import MdiHeart from '~icons/mdi/heart.jsx'
import MdiStar from '~icons/mdi/star.jsx'

import type { MenuItem } from '#content_script/contextMenu.js'

import { DEFAULT_SERIES_HIGHLIGHT_COLOR, DEFAULT_WORK_HIGHLIGHT_COLOR, fetchAndParseDocument, fetchToken, getArchiveLink, options, parseUser, toast, unpackIds } from '#common'
import {
  attachMenuTrigger,
  buildIndicators,
  clearMenuTriggers,
  type IndicatorState,
  standardLinkItems,
} from '#content_script/contextTrigger.js'
import { loadMarkedForLaterIndex, noteMarkedForLater } from '#content_script/markedForLaterIndex.js'
import { clearEntityBehavior, entityBehavior, type EntityOptionKey, toggleEntityBehavior } from '#content_script/persistentFilters.js'
import { Unit } from '#content_script/Unit.js'
import { applyReadMark, setFavoriteMark } from '#content_script/workMarks.js'
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
interface MarkState {
  saved: boolean
  busy: boolean
  known: boolean
  /**
   * We changed this state ourselves this session. Seeding reads the *page*, which
   * still shows the pre-toggle markup after a background {@link submitMark} — so
   * a re-run (every options change triggers one) would otherwise re-seed the old
   * value and bring the saved-clock back on a work just marked read.
   */
  acted: boolean
  /**
   * The state came from the cached Marked for Later index rather than from this
   * page or a fetch — good enough to draw the indicator, but possibly out of date
   * by however long ago the list was last scraped. Opening the work's menu
   * re-checks a cached state against the archive before acting on it.
   */
  cached: boolean
}
const markState = new Map<string, MarkState>()

/** Options for {@link seedMarkedForLater}. */
interface SeedOptions {
  /** The ids come from the cached index — see {@link MarkState.cached}. */
  cached?: boolean
}

/**
 * Seed the shared session mark-for-later state for works already known to be
 * saved. The state normally starts empty (it can't be read from a blurb), but
 * some listings know every work on them is marked for later — the Search Marked
 * for Later view above all — so seeding lets the work menu offer "Mark as read"
 * (not "Mark for later") and show the saved-clock indicator from the first
 * render. A work mid-request (busy) is left untouched.
 *
 * The other seed is {@link file://../markedForLaterIndex.ts}, the cached id list
 * from the last bulk scrape, which is what puts the indicator on ordinary
 * listings. Those ids come in with `cached: true` and never overwrite a state
 * read first-hand.
 */
export function seedMarkedForLater(workIds: Iterable<string>, opts: SeedOptions = {}): void {
  for (const id of workIds) {
    const state = markState.get(id)
    // A toggle in flight, or one we already made, is fresher than the listing.
    if (state?.busy || state?.acted)
      continue
    // Anything read off this page (or fetched) beats a possibly-stale cache.
    if (opts.cached && state?.known && !state.cached)
      continue
    markState.set(id, { saved: true, busy: false, known: true, acted: false, cached: !!opts.cached })
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
 * AO3's own mark button for a work — the `li.mark` form in a work page's header.
 * It renders exactly one of `mark_for_later` / `mark_as_read`, so asking for the
 * action we want also tells us whether it's the right one to press.
 *
 * Pressing it beats posting the request ourselves ({@link submitMark}): AO3
 * handles its own redirect, so the button flips to the opposite action and the
 * "added to your Marked for Later list" notice matches reality. A background POST
 * leaves both stale until the reader reloads by hand — and leaves a "Mark as
 * Read" button sitting there on a work that's already been marked read.
 *
 * Returns null on listings (no such form), where {@link submitMark} is the only
 * option — and is fine there, because nothing on the page claims otherwise.
 */
function nativeMarkButton(workId: string, save: boolean): HTMLButtonElement | null {
  const action = save ? 'mark_for_later' : 'mark_as_read'
  const form = document.querySelector<HTMLFormElement>(`form.button_to[action*="/works/${workId}/${action}"]`)
  return form?.querySelector<HTMLButtonElement>('button') ?? null
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
// Read / favourite marks (works only). Unlike mark-for-later these are ours, so
// the state is always known: it's unpacked once per run from the `workMarks`
// option into these sets, and the menu/indicators read them synchronously.
// ---------------------------------------------------------------------------

let readIds = new Set<string>()
let favoriteIds = new Set<string>()

/** Re-read the packed mark sets from options at the start of a run. */
function loadMarkSets(marks: { read: string, favorite: string }): void {
  readIds = unpackIds(marks.read)
  favoriteIds = unpackIds(marks.favorite)
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
  /** Works fold in read/favourite marks; series don't. */
  protected marksEnabled(): boolean { return false }

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
        scope: 'settings',
        danger: true,
        active: behavior === 'hide',
        disabled: behavior === 'hide',
        onSelect: () => toggleEntityBehavior(this.optionKey, id, 'hide'),
      },
      {
        icon: () => <MdiEyeCheck />,
        label: 'Always show',
        scope: 'settings',
        active: behavior === 'invert',
        disabled: behavior === 'invert',
        onSelect: () => toggleEntityBehavior(this.optionKey, id, 'invert'),
      },
      {
        icon: () => <MdiStar />,
        label: 'Highlight',
        scope: 'settings',
        active: behavior === 'highlight',
        disabled: behavior === 'highlight',
        onSelect: () => toggleEntityBehavior(this.optionKey, id, 'highlight'),
      },
    ]
    if (behavior) {
      items.push({
        icon: () => <MdiCloseCircleOutline />,
        label: 'Clear',
        scope: 'settings',
        onSelect: () => clearEntityBehavior(this.optionKey, id),
      })
    }

    if (this.marksEnabled())
      items.push(...this.markSetItems(id))

    if (this.markEnabled())
      items.push(this.markItem(id))

    // The work-page title isn't a link, so the copy/open-link rows don't apply.
    if (link instanceof HTMLAnchorElement)
      items.push(...standardLinkItems(link))
    return items
  }

  /**
   * The read / favourite rows. Both are local state we already hold, so unlike
   * the mark-for-later row they render their real label immediately.
   */
  private markSetItems(id: string): MenuItem[] {
    const read = readIds.has(id)
    const favorite = favoriteIds.has(id)
    return [
      {
        icon: () => (read ? <MdiBookOutline /> : <MdiBookCheck />),
        label: read ? 'Unmark as read' : 'Mark as read',
        scope: 'settings',
        separatorBefore: true,
        onSelect: () => this.onToggleRead(id, !read),
      },
      {
        icon: () => (favorite ? <MdiHeart /> : <MdiHeartOutline />),
        label: favorite ? 'Remove from favorites' : 'Add to favorites',
        scope: 'settings',
        onSelect: () => this.onToggleFavorite(id, !favorite),
      },
    ]
  }

  /**
   * Toggle the local read mark. Marking a work read means "I'm done with this",
   * so when we already know it's on the Marked for Later list it comes off it
   * too — that's the loop this feature exists to break. The list is only touched
   * when its state is known first-hand (seeded or acted on this session); an
   * unknown state is left alone rather than paying for a page fetch here.
   */
  private async onToggleRead(id: string, read: boolean): Promise<void> {
    this.setReadLocally(id, read)

    const state = markState.get(id)
    if (read && this.markEnabled() && state?.saved && !state.busy) {
      // onMark toasts the "removed from your Marked for Later list" message.
      await this.onMark(id)
      return
    }
    toast(read ? 'Marked as read.' : 'Marked as unread.', { type: 'success' })
  }

  /**
   * Apply a read mark and show it immediately. Goes through
   * {@link applyReadMark} — the one writer of read marks — so this behaves
   * identically to pressing AO3's own button, which lands in the same place.
   *
   * The indicator is updated optimistically rather than waiting for the options
   * round-trip (whose change event re-runs every unit and rebuilds it anyway).
   */
  protected setReadLocally(id: string, read: boolean): void {
    if (read)
      readIds.add(id)
    else
      readIds.delete(id)
    applyReadMark(this.options.workMarks, id, read)
    this.syncEntriesFor(id)
  }

  private async onToggleFavorite(id: string, favorite: boolean): Promise<void> {
    if (favorite)
      favoriteIds.add(id)
    else
      favoriteIds.delete(id)
    this.syncEntriesFor(id)

    await setFavoriteMark(id, favorite)
    toast(favorite ? 'Added to favorites.' : 'Removed from favorites.', { type: 'success' })
  }

  /**
   * The Mark for Later / Mark as Read row. When the work's saved state is known
   * first-hand (acted on this session, read off this page, or seeded by a listing
   * that knows its works are saved — the Search Marked for Later view), it renders
   * directly and stands.
   *
   * Otherwise the row opens *with* the menu and patches itself once a background
   * fetch of the work page reveals the real state, so opening never waits on the
   * network. What it shows meanwhile depends on how much we know:
   *
   * - a cached state (from the Marked for Later index) renders as the real,
   *   usable action straight away — the check only corrects it if the list has
   *   moved on since the last scrape;
   * - knowing nothing at all, a disabled "Checking…" placeholder.
   */
  private markItem(id: string): MenuItem {
    const state = markState.get(id)
    if (state?.known && !state.cached)
      return this.markAction(id, state.saved, state.busy)

    const resolve = async (): Promise<MenuItem> => {
      const saved = await this.checkMarked(id)
      const busy = markState.get(id)?.busy ?? false
      if (saved === null) {
        // Couldn't reach the archive. A cached state is still the best answer we
        // have, so leave that row usable rather than replacing it with nothing.
        return state?.known
          ? this.markAction(id, state.saved, busy)
          : { icon: () => <MdiClockPlusOutline />, label: 'Mark for later (unavailable)', disabled: true }
      }
      return this.markAction(id, saved, busy)
    }

    if (state?.known)
      return { ...this.markAction(id, state.saved, state.busy), resolve }

    return {
      icon: () => <MdiClockPlusOutline />,
      label: 'Checking Marked for Later…',
      scope: 'account',
      disabled: true,
      resolve,
    }
  }

  /**
   * The resolved, actionable Mark for Later / Mark as Read row. When read marks
   * are on there's already a "Mark as read" row above (which also unsaves), so
   * this one is relabelled to what it uniquely does — otherwise the menu would
   * carry two identically-labelled actions.
   */
  private markAction(id: string, saved: boolean, busy: boolean): MenuItem {
    const savedLabel = this.marksEnabled() ? 'Remove from Marked for Later' : 'Mark as read'
    return {
      icon: () => (saved ? <MdiClockCheck /> : <MdiClockPlusOutline />),
      label: saved ? savedLabel : 'Mark for later',
      scope: 'account',
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
    const state = markState.get(id) ?? { saved: false, busy: false, known: false, acted: false, cached: false }
    // A toggle in flight, or one we already made, is the freshest intent.
    if (state.busy || state.acted)
      return state.saved
    state.saved = saved
    state.known = true
    // Straight from the archive, so it supersedes anything the index said — and
    // the index itself, which may have been what we just disagreed with.
    state.cached = false
    noteMarkedForLater(id, saved)
    markState.set(id, state)
    this.syncEntriesFor(id)
    return saved
  }

  /** Refresh the indicator on every decorated link showing this entity. */
  protected syncEntriesFor(id: string): void {
    for (const entry of this.entries) {
      if (entry.id === id)
        this.syncIndicator(entry)
    }
  }

  protected computeStates(id: string): IndicatorState[] {
    const states: IndicatorState[] = []
    const behavior = entityBehavior(this.options[this.optionKey].filters, id)
    if (behavior)
      states.push(behavior)
    if (this.markEnabled() && markState.get(id)?.saved)
      states.push('saved')
    if (this.marksEnabled()) {
      if (readIds.has(id))
        states.push('read')
      if (favoriteIds.has(id))
        states.push('favorite')
    }
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
    const state = markState.get(id) ?? { saved: false, busy: false, known: false, acted: false, cached: false }
    if (state.busy)
      return
    const save = !state.saved

    // On a work page, let AO3's own button do it — it reloads the page, so its
    // mark button and notice end up telling the truth. This navigates away, so
    // nothing below runs.
    const native = nativeMarkButton(id, save)
    if (native) {
      native.click()
      return
    }

    state.busy = true
    markState.set(id, state)
    try {
      await submitMark(id, save)
      state.saved = save
      // We now know this work's state first-hand, so future opens skip the check.
      state.known = true
      state.cached = false
      // ...and must not be overwritten by a re-seed from the now-stale page.
      state.acted = true
      // Keep the cached index in step, so every other listing agrees with what
      // just happened rather than waiting for the next bulk scrape.
      noteMarkedForLater(id, save)
      // Read and Marked for Later are opposite ends of one decision, so keep the
      // read mark in step: saving a work for later clears it, taking it off the
      // list records it. On the native-button path CaptureMarkButtons does this
      // same step — this branch is the fetch fallback, where no button exists.
      if (this.marksEnabled())
        this.setReadLocally(id, !save)
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
      this.syncEntriesFor(id)
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
  // on (hide/highlight/always-show), mark-for-later is on, or read/favourite
  // marks are on.
  override get enabled() {
    return this.options.hideWorks.enabled || this.options.markForLaterToolbar || this.options.workMarks.enabled
  }

  protected override get noun() { return 'work' as const }
  protected override get kind() { return 'works' as const }
  protected override get optionKey() { return 'hideWorks' as const }
  protected override get defaultColor() { return this.options.hideWorks.defaultHighlightColor || DEFAULT_WORK_HIGHLIGHT_COLOR }
  protected override get entries() { return workEntries }

  protected override markEnabled(): boolean {
    // Marking needs a logged-in session, and only when the feature is enabled.
    return this.options.markForLaterToolbar && document.body.classList.contains('logged-in')
  }

  // Read/favourite marks are ours alone — no AO3 session needed.
  protected override marksEnabled(): boolean { return this.options.workMarks.enabled }

  override async ready(): Promise<void> {
    loadMarkSets(this.options.workMarks)
    // Weakest source first: each of the three may overwrite the one before it.
    await this.seedFromIndex()
    this.seedMarkedForLaterPage()
    this.seedWorkPageMark()
    await super.ready()
  }

  /**
   * Seed the saved state from the cached Marked for Later index, which is what
   * puts the saved indicator on an ordinary listing: the states are known from
   * the last bulk scrape rather than from a request per work, which is the cost
   * that kept the indicator off listings entirely.
   *
   * Seeded before the menus are built so the indicators are right on first paint.
   * They're flagged `cached`, so opening a work's menu still re-checks that one
   * work before offering to act on it.
   */
  private async seedFromIndex(): Promise<void> {
    if (!this.markEnabled())
      return
    const userId = parseUser(document)?.userId
    if (!userId)
      return
    const ids = await loadMarkedForLaterIndex(userId)
    if (ids.size)
      seedMarkedForLater(ids, { cached: true })
  }

  /**
   * Seed the shared mark-for-later state from the reading-history page, where
   * each blurb states it: AO3 appends "(Marked for Later.)" to the `h4.viewed`
   * heading of every saved work (on both the full history and the `?show=to-read`
   * view). Without this the work menu on the very page you triage from would
   * treat each saved state as unknown — and "Mark as read" would then leave the
   * work sitting on the list.
   */
  private seedMarkedForLaterPage(): void {
    if (!this.markEnabled() || !/^\/users\/[^/]+\/readings\/?$/.test(location.pathname))
      return

    const saved: string[] = []
    for (const blurb of this.root.querySelectorAll<HTMLElement>('li.blurb[id^="work_"]')) {
      const id = blurb.id.slice('work_'.length)
      if (id && blurb.querySelector('h4.viewed')?.textContent?.includes('Marked for Later'))
        saved.push(id)
    }
    seedMarkedForLater(saved)
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
    // Don't clobber a toggle in flight, or one we already made — after a
    // background toggle this page's own mark button still shows the old state.
    const state = id ? markState.get(id) : undefined
    if (!id || state?.busy || state?.acted)
      return
    const saved = parseMarkedForLater(document)
    if (saved !== null) {
      markState.set(id, { saved, busy: false, known: true, acted: false, cached: false })
      // The page states it, so the index can be corrected for free.
      noteMarkedForLater(id, saved)
    }
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
