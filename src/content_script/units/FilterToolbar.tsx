import Icon from '~icons/ao3e/icon.jsx'
import MdiBookOpenVariant from '~icons/mdi/book-open-variant.jsx'
import MdiCog from '~icons/mdi/cog.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiEye from '~icons/mdi/eye.jsx'
import MdiFindReplace from '~icons/mdi/find-replace.jsx'
import MdiGestureTapHold from '~icons/mdi/gesture-tap-hold.jsx'
import MdiPlaylistCheck from '~icons/mdi/playlist-check.jsx'
import MdiPlaylistEdit from '~icons/mdi/playlist-edit.jsx'
import MdiPlaylistPlay from '~icons/mdi/playlist-play.jsx'
import MdiPlaylistPlus from '~icons/mdi/playlist-plus.jsx'

import type { ListState, SaveBackDone, SaveBackPage, SaveBackPlan, SaveBackUndoPlan, SavedList, TrackedFilter, TrackedList, TrackedMeta } from '#common'
import type { DetachedSnapshot } from '#content_script/searchView/cache.ts'
import type { TrackablePage } from '#content_script/tracked/createList.ts'

import { ADDON_CLASS, aliasOf, api, cache, defaultTitle, describeUpdate, fillMeta, filteredKey, getArchiveLink, marksHideAnything, normalizeTrackedUrl, options, parseUser, planLetGo, planSaveBack, planStopTracking, planTrack, planTrackSearch, planUndoSaveBack, sameRoot, sameTitle, SAVE_BACK_UNDO_TIMEOUT, savedListAt, savedListsOf, savedListsWrite, sourceLabel, storedListRefs, titleAfterUpdate, titleTakenBy, toast, trackedKey, trackedMeta, trackedRoot, uniqueTitle, utcToday } from '#common'
import { getMenusEnabled, setMenusEnabled } from '#content_script/contextTrigger.js'
import { extensionAlive } from '#content_script/extensionAlive.js'
import { holdSearchPrompt } from '#content_script/pendingSearch.ts'
import { detachSnapshot, pruneDetached, restoreSnapshot } from '#content_script/searchView/cache.ts'
import { NATIVE_HIDDEN_CLASS, VIEW_HIDDEN_CLASS } from '#content_script/searchView/classes.ts'
import { activeSearchFilter } from '#content_script/searchView/host.tsx'
import { findWorkText } from '#content_script/textReplaceScope.ts'
import { metaUnsettled, needsScan, pageQuery, resolveMeta, sidebarNameId, trackablePage } from '#content_script/tracked/createList.ts'
import { endRefining, openRefining, refiningList, startRefining, takeRefiningLink } from '#content_script/tracked/refining.ts'
import { trackedFilterOf } from '#content_script/tracked/viewFilter.ts'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const TOOLBAR_CLASS = `${ADDON_CLASS}--filter-toolbar`
const PANEL_CLASS = `${ADDON_CLASS}--filter-toolbar--panel`
const FAB_CLASS = `${ADDON_CLASS}--filter-toolbar--fab`
const OPEN_CLASS = `${ADDON_CLASS}--filter-toolbar--open`
const BUTTON_CLASS = `${ADDON_CLASS}--filter-toolbar--button`

/** The tracking pill and the box it grows — see {@link FilterToolbar.buildTrackButton}. */
const TRACK_CLASS = `${ADDON_CLASS}--filter-toolbar--track`
const TRACK_BOX_CLASS = `${TRACK_CLASS}--box`
const TRACK_NOTE_CLASS = `${TRACK_CLASS}--note`
const TRACK_INPUT_CLASS = `${TRACK_CLASS}--alias`
const TRACK_ROW_CLASS = `${TRACK_CLASS}--row`
const TRACK_MINOR_CLASS = `${TRACK_CLASS}--minor`
const TRACK_HEAD_CLASS = `${TRACK_CLASS}--head`
const TRACK_WARN_CLASS = `${TRACK_CLASS}--warn`
const TRACK_DIFF_CLASS = `${TRACK_CLASS}--diff`
const TRACK_SUMMARY_CLASS = `${TRACK_CLASS}--summary`
const TRACK_CHOOSER_CLASS = `${TRACK_CLASS}--chooser`
/** Set on a title box once the reader has typed in it: what they typed is theirs, and outlives a rebuilt pill. */
const TYPED_KEY = 'ao3eTyped'

/** Toggled on <body> to temporarily reveal works hidden by any filter (see CSS). */
const PEEK_CLASS = `${ADDON_CLASS}--peek-hidden`

/**
 * Blurbs HideWorks hid (at least partly) — by a tag, author or crossover
 * filter. Every hidden work carries `data-ao3e-hidden-by`, so this
 * matches them all regardless of which filter kind was responsible.
 */
const HIDDEN_SELECTOR = 'li[data-ao3e-hidden-by]'

/**
 * How many works the reader's filters have hidden *in the listing they're
 * looking at* — the only ones peek could reveal. Two kinds are in the page but
 * not in front of the reader, and neither counts: the native listing a custom
 * search view is standing in for, and the works that view is holding back
 * because they're filtered out or on another of its pages.
 *
 * Recounted rather than cached because a search view marks its works as it
 * decorates them, a page at a time — the number simply isn't known when this
 * unit runs, and changes with every filter and page turn after it.
 */
function countHidden(): number {
  let count = 0
  for (const el of document.querySelectorAll(HIDDEN_SELECTOR)) {
    if (el.classList.contains(VIEW_HIDDEN_CLASS) || el.closest(`.${NATIVE_HIDDEN_CLASS}`))
      continue
    count++
  }
  return count
}

/**
 * The mounted toolbar's peek pill, so a listing that fills in *after* this unit
 * ran can bring the count up to date. Null when the page has no peek pill.
 */
let syncPeek: (() => void) | null = null
/**
 * The mounted toolbar's tracking pill, so a custom search view opened, filtered
 * or closed after this unit ran can bring it up to date — see
 * {@link FilterToolbar.trackSync}. Null when the page has no tracking pill.
 */
let syncTrack: (() => void) | null = null
/**
 * The mounted toolbar's way to redraw its tracking pill from lists just
 * written, for a write that re-runs nothing — see
 * {@link FilterToolbar.buildTrackButton}. Null when the page has no tracking
 * pill. Module scope, so an Undo from a toast can reach whichever toolbar is
 * mounted by then.
 */
let trackWritten: ((state: ListState) => void) | null = null
let refreshPending = false

/**
 * Each pill's redraw of what the live filter decides in its box, where there is
 * any — see {@link FilterToolbar.trackSync}. Keyed by the pill's group, so a
 * pill that's replaced takes its entry with it.
 */
const trackRedraws = new WeakMap<HTMLElement, () => void>()

/**
 * Bring the pills that describe what's on screen in line with it: the peek pill
 * with what's actually hidden now — adding or dropping it as that count crosses
 * zero — and the tracking pill with the filter the page's search view is set to,
 * which is part of what the page *is* to a tracked list. Called by the search
 * view after every render, and when it closes; coalesced to one pass per frame.
 */
export function refreshFilterToolbar(): void {
  if ((!syncPeek && !syncTrack) || refreshPending)
    return
  refreshPending = true
  requestAnimationFrame(() => {
    refreshPending = false
    syncPeek?.()
    syncTrack?.()
  })
}

/**
 * How much of the bottom-right corner this toolbar is occupying, published on
 * `<html>` for anything else that parks itself there. The toast stack is the
 * one thing that does (see {@link file://../../common/toast/toast.css}) and it
 * offsets itself by this, so a toast raised by one of the pills below sits
 * above the toolbar instead of over it — until this existed, saving anything
 * from a pill made the whole toolbar unreachable for as long as the toast was
 * up, the launcher included.
 *
 * Deliberately survives `clean()`: a pill's write re-runs every unit, and the
 * toast it raised is *not* ours to remove (it has no `ADDON_CLASS`, so it rides
 * out the rebuild). Dropping the property in between would drop that toast onto
 * the corner and lift it again a moment later. `ready()` always mounts a
 * toolbar — the unit is always enabled — so it is always rewritten.
 */
const RESERVE_PROP = '--ao3e-corner-reserve'

/**
 * Watches the mounted toolbar's box, so the reserve follows a pill appearing or
 * the tracking box growing out of one. Module scope for the same reason as the
 * outside-click handler below: one per mounted toolbar, detached by `clean()`.
 */
let reserveObserver: ResizeObserver | null = null

/**
 * Document listener that collapses the panel on an outside click. Kept at module
 * scope (not per-instance) so each run's `clean()` can detach the previous one
 * before `ready()` mounts a fresh toolbar — otherwise re-runs would leak listeners.
 */
let outsideHandler: ((e: Event) => void) | null = null
function detachOutsideHandler(): void {
  if (outsideHandler) {
    document.removeEventListener('pointerdown', outsideHandler, true)
    outsideHandler = null
  }
}

function detachReserveObserver(): void {
  reserveObserver?.disconnect()
  reserveObserver = null
}

/**
 * A floating control in the bottom-right corner of listing pages. A round,
 * touch-sized button (the extension's AO3 logo) expands a stack of pill toggles
 * — and collapses them again — so the stack can grow without crowding the page:
 *
 * - **Peek** — on any listing where the extension hid one or more works, toggles
 *   a body class that reveals them (and hides them again) without touching the
 *   saved filters. Gated by the `filterToolbar` option, shown only when works
 *   were hidden.
 * - **Disable menus** — the escape hatch for the in-page context menus: flips
 *   `contextMenusEnabled`, restoring the browser's native menu on links. Shown
 *   whenever any menu decorator is active on the page, so it's always reachable.
 *   (The per-gesture version is holding Shift; see
 *   {@link file://../contextTrigger.tsx}.)
 * - **Reader mode** — on a work page, toggles the `readerMode` option (font-zoom
 *   + drag-to-width on the work text) without a trip to the options page.
 * - **Text replacement tools** — on a work page with text replacement on,
 *   toggles `textReplacements.tools`: the underlines under replaced text, and
 *   the button that turns a selection into a rule. The same switch the options
 *   page carries, put where a reader notices they want it.
 * - **Track this search** — on any page that is a query the review can read (a
 *   works search, a filtered listing, an uncommon tag's works, a series), offers
 *   to save it as a tracked list, and once it is one, says so and offers to stop
 *   or to go and review. On a page that searches what a list does, filtered
 *   differently — or in a tab opened to refine a saved list, tracked or not — it
 *   offers to update that list instead. A refining tab gets the pill whether or
 *   not Tracked lists is on, since refining belongs to saved lists; with it off,
 *   that is the only place the pill appears. See {@link buildTrackButton}.
 * - **Options** — opens the extension's options page. Always present, which is
 *   also why the toolbar itself now always is.
 *
 * Runs after HideWorks so the hidden markers the peek counts are already in place.
 */
export class FilterToolbar extends Unit {
  static override get name() { return 'FilterToolbar' }

  /** A single work / chapter page — the only place the reader-mode pill applies. */
  private get onWorkPage(): boolean {
    return /^\/works\/\d+/.test(location.pathname)
  }

  /** Whether any feature that adds a context menu is active on the page. */
  private get menuFeaturesActive(): boolean {
    const o = this.options
    return o.tagToolbar
      || o.fandomToolbar
      || o.markForLaterToolbar
      || o.hideAuthorToolbar
      || o.subscribeAuthorToolbar
      || o.muteAuthorToolbar
      || o.rules.enabled
      || o.workMarks.enabled
  }

  /** Whether the peek pill could apply here (the `filterToolbar` option + a hide feature). */
  private get peekAvailable(): boolean {
    const { filterToolbar, rules, hideCrossovers, workMarks } = this.options
    return filterToolbar && (
      rules.enabled || hideCrossovers.enabled
      || (workMarks.enabled && marksHideAnything(workMarks.marks))
    )
  }

  // Every other pill comes and goes with the page and the reader's settings, but
  // Options applies everywhere — so the toolbar does too. (The DOM checks that
  // gate the reader and replacement pills happen in `ready()`; at
  // `document_start` there is no page to ask.)
  override get enabled() { return true }

  static override async clean(): Promise<void> {
    detachOutsideHandler()
    detachReserveObserver()
    syncPeek = null
    syncTrack = null
    trackWritten = null
    document.body.classList.remove(PEEK_CLASS)
  }

  override async ready(): Promise<void> {
    // The pill is built whenever peeking *could* apply here, not only when
    // something is hidden already: a custom search view hides its works long
    // after this runs, and there'd be nothing left to add the pill to.
    const showPeek = this.peekAvailable
    const showMenus = this.menuFeaturesActive
    // The reader pill needs the actual work text present, not just a work URL.
    const showReader = this.onWorkPage && document.querySelector('#workskin') !== null
    // The replacement pill goes wherever replacements themselves apply, which is
    // a little wider than `#workskin` — see `textReplaceScope`.
    const showReplace = this.options.textReplacements.enabled && findWorkText() !== null
    const tracking = this.options.trackedLists.enabled
    // A tab opened by a saved list's refining link remembers the list, whatever
    // this page turns out to be — see {@link file://../tracked/refining.ts}.
    const known = savedListsOf(this.listState()).map(({ list }) => list)
    takeRefiningLink(known)
    // Whether this page is a query a list could be — a DOM question as well as a
    // URL one for an uncommon tag, so it can only be asked now. Without Tracked
    // lists, only a tab refining a list has anything to offer.
    const trackable = tracking || refiningList(known) ? trackablePage() : null
    if (trackable && tracking)
      void this.learnMeta(trackable)

    document.body.append(this.buildToolbar(showPeek, showMenus, showReader, showReplace, trackable))
    this.logger.debug(`Filter toolbar added (peek: ${showPeek}, menus toggle: ${showMenus}, reader: ${showReader}, replace tools: ${showReplace}, trackable: ${trackable?.normalized.kind ?? 'no'}).`)
  }

  buildToolbar(showPeek: boolean, showMenus: boolean, showReader: boolean, showReplace: boolean, trackable: TrackablePage | null): HTMLElement {
    const panel = <div class={PANEL_CLASS} role="group" />
    panel.append(this.buildOptionsButton())
    if (trackable) {
      const track = this.buildTrackButton(trackable)
      if (track)
        panel.append(track)
      syncTrack = this.trackSync(trackable, panel)
      trackWritten = (state) => {
        this.lists = state
        this.redrawTrack(trackable, panel)
      }
    }
    if (showReplace)
      panel.append(this.buildReplaceToolsButton())
    if (showReader)
      panel.append(this.buildReaderButton())
    // Built up front but only put in the panel while it has something to say —
    // see syncVisible below. The menus pill is kept to hand as the insertion
    // point, so the peek pill always comes back in the same place.
    const peek = showPeek ? this.buildPeekButton() : null
    const menusButton = showMenus ? this.buildMenusButton() : null
    if (menusButton)
      panel.append(menusButton)

    const fab: HTMLButtonElement = (
      <button type="button" class={FAB_CLASS} aria-haspopup="true" aria-expanded="false">
        <Icon />
      </button>
    ) as HTMLElement as HTMLButtonElement

    // The panel renders above the fab (column layout) so the pills stack upward.
    const container = (
      <div class={`${ADDON_CLASS}  ${TOOLBAR_CLASS}`}>
        {panel}
        {fab}
      </div>
    )

    let open = false

    // Say how much of the corner this is taking, for whatever else is in it —
    // see RESERVE_PROP. Measured from the live box rather than worked out from
    // the stylesheet, so the reader's font size, however many pills this page
    // has and the tracking box growing out of one are all in it. Collapsed, only
    // the circle counts: the panel keeps its layout box while it is hidden, and
    // reserving that would hold every toast a couple of hundred pixels off the
    // bottom of the page for nothing.
    const syncReserve = (): void => {
      // Nothing is published until the toolbar has a box — `ready()` appends it
      // after this runs. Leaving the property as it was until then is the point:
      // a toast raised by a pill outlives the rebuild that pill's write sets
      // off, and must not drop onto the corner and rise again in between.
      if (!container.isConnected)
        return
      const measured = container.hidden ? null : (open ? container : fab).getBoundingClientRect()
      const reserved = measured ? Math.max(0, Math.round(window.innerHeight - measured.top)) : 0
      document.documentElement.style.setProperty(RESERVE_PROP, `${reserved}px`)
    }

    // The peek pill comes and goes with the count, and with nothing left in the
    // panel there is nothing for the fab to open — so the whole toolbar steps
    // out of the corner rather than leaving a button that opens an empty box.
    const syncVisible = (): void => {
      if (peek) {
        const count = peek.sync()
        if (count > 0 && !peek.button.isConnected) {
          if (menusButton)
            menusButton.before(peek.button)
          else
            panel.append(peek.button)
        }
        else if (count === 0 && peek.button.isConnected) {
          peek.button.remove()
        }
      }
      container.hidden = panel.children.length === 0
      syncReserve()
    }
    if (peek)
      syncPeek = syncVisible
    syncVisible()

    // Everything that changes the box: the toolbar being appended (the first
    // real measurement), a pill arriving or leaving, the tracking box opening.
    detachReserveObserver()
    reserveObserver = new ResizeObserver(() => syncReserve())
    reserveObserver.observe(container)

    const setOpen = (next: boolean): void => {
      open = next
      container.classList.toggle(OPEN_CLASS, open)
      fab.setAttribute('aria-expanded', String(open))
      const label = open ? 'Hide extension controls' : 'Show extension controls'
      fab.title = label
      fab.setAttribute('aria-label', label)
      holdSearchPrompt(open)
      // Opening changes what counts as taken without changing the box the
      // observer above is watching, so it has nothing to say about this one.
      syncReserve()
    }
    setOpen(false)

    fab.addEventListener('click', (e) => {
      e.preventDefault()
      setOpen(!open)
    })

    // Collapse when the user clicks anywhere outside the toolbar.
    detachOutsideHandler()
    outsideHandler = (e: Event) => {
      if (open && !container.contains(e.target as Node))
        setOpen(false)
    }
    document.addEventListener('pointerdown', outsideHandler, true)

    return container
  }

  /** The peek pill, plus the sync that relabels it and reports the current count. */
  buildPeekButton(): { button: HTMLButtonElement, sync: () => number } {
    const icon: HTMLElement = <span class={`${ADDON_CLASS}--filter-toolbar--icon`} />
    const text: HTMLElement = <span />
    const button: HTMLButtonElement = (
      <button type="button" class={BUTTON_CLASS} aria-pressed="false">
        {icon}
        {text}
      </button>
    ) as HTMLElement as HTMLButtonElement

    const sync = (): number => {
      const count = countHidden()
      if (count === 0)
        return 0
      const noun = count === 1 ? 'work' : 'works'
      const peeking = document.body.classList.contains(PEEK_CLASS)
      icon.replaceChildren(peeking ? <MdiEyeOff /> : <MdiEye />)
      text.textContent = `${peeking ? 'Hide' : 'Show'} ${count} filtered ${noun}`
      button.setAttribute('aria-pressed', String(peeking))
      const label = peeking
        ? 'Re-hide works your filters hid'
        : 'Temporarily show works your filters hid (does not change your filters)'
      button.title = label
      button.setAttribute('aria-label', label)
      return count
    }

    button.addEventListener('click', () => {
      document.body.classList.toggle(PEEK_CLASS)
      sync()
    })

    return { button, sync }
  }

  buildMenusButton(): HTMLElement {
    const icon: HTMLElement = <span class={`${ADDON_CLASS}--filter-toolbar--icon`}><MdiGestureTapHold /></span>
    const text: HTMLElement = <span />
    const button: HTMLButtonElement = (
      <button type="button" class={`${BUTTON_CLASS}  ${ADDON_CLASS}--filter-toolbar--menus`} aria-pressed="false">
        {icon}
        {text}
      </button>
    ) as HTMLElement as HTMLButtonElement

    const sync = () => {
      const enabled = getMenusEnabled()
      // aria-pressed marks the "disabled" override as active, so the button reads
      // as a toggle that's "on" when it has switched the menus off.
      button.setAttribute('aria-pressed', String(!enabled))
      text.textContent = enabled ? 'Disable right-click menus' : 'Enable right-click menus'
      const label = enabled
        ? 'Turn off the extension\'s right-click / long-press menus (restores the browser\'s native menu). To stand it down for one gesture instead, hold Shift while clicking.'
        : 'Turn the extension\'s right-click / long-press menus back on'
      button.title = label
      button.setAttribute('aria-label', label)
    }

    button.addEventListener('click', () => {
      // Each of these pills flips a local copy of a setting and writes the real
      // one behind it, so an orphaned page would show the new state and keep the
      // old — checked here rather than after the flip.
      if (!extensionAlive())
        return
      const next = !getMenusEnabled()
      setMenusEnabled(next)
      void options.set({ contextMenusEnabled: next })
      sync()
    })
    sync()

    return button
  }

  buildReaderButton(): HTMLElement {
    // Optimistic local state so the pill flips instantly; the options change also
    // triggers a re-run that rebuilds the toolbar (and (de)activates ReaderMode).
    let on = this.options.readerMode
    const icon: HTMLElement = <span class={`${ADDON_CLASS}--filter-toolbar--icon`}><MdiBookOpenVariant /></span>
    const text: HTMLElement = <span />
    const button: HTMLButtonElement = (
      <button type="button" class={BUTTON_CLASS} aria-pressed="false">
        {icon}
        {text}
      </button>
    ) as HTMLElement as HTMLButtonElement

    const sync = () => {
      // aria-pressed reads as the feature's on/off state (green when on).
      button.setAttribute('aria-pressed', String(on))
      text.textContent = on ? 'Disable reader mode' : 'Enable reader mode'
      const label = on
        ? 'Turn off reader mode (zoom + adjustable width) for this work'
        : 'Turn on reader mode (zoom + adjustable width) for this work'
      button.title = label
      button.setAttribute('aria-label', label)
    }

    button.addEventListener('click', () => {
      if (!extensionAlive())
        return
      on = !on
      void options.set({ readerMode: on })
      sync()
    })
    sync()

    return button
  }

  buildReplaceToolsButton(): HTMLElement {
    // Optimistic local state, as with the reader pill: the options write also
    // re-runs every unit, which rebuilds this toolbar from the saved value.
    let on = this.options.textReplacements.tools
    const icon: HTMLElement = <span class={`${ADDON_CLASS}--filter-toolbar--icon`}><MdiFindReplace /></span>
    const text: HTMLElement = <span />
    const button: HTMLButtonElement = (
      <button type="button" class={BUTTON_CLASS} aria-pressed="false">
        {icon}
        {text}
      </button>
    ) as HTMLElement as HTMLButtonElement

    const sync = () => {
      button.setAttribute('aria-pressed', String(on))
      text.textContent = on ? 'Hide text replacement tools' : 'Show text replacement tools'
      const label = on
        ? 'Stop underlining replaced text and offering to replace what you select'
        : 'Underline the text your rules replaced, and offer to make a rule out of any text you select'
      button.title = label
      button.setAttribute('aria-label', label)
    }

    button.addEventListener('click', () => {
      if (!extensionAlive())
        return
      on = !on
      void options.set({ textReplacements: { ...this.options.textReplacements, tools: on } })
      sync()
    })
    sync()

    return button
  }

  /**
   * The tracking control, in whichever state the page is in, or null where it
   * has none. The first row that applies wins:
   *
   * 1. **Refining a saved list**, tracked or not — the tab was opened by that
   *   list's link on the options page ({@link file://../tracked/refining.ts}) —
   *   and the page is of the list's kind: "Update “X”" once the search differs
   *   from X's, else "Refining “X”". A page of another kind can't become X's
   *   query, so there the mark waits and the rows below apply. This row is
   *   offered whatever Tracked lists says; the rest only while it is on.
   * 2. **Exactly a tracked list**: "Tracked as “X”".
   * 3. **Exactly a saved list that isn't tracked**: "Track “X”", one click from
   *   tracking it under its own id and title.
   * 4. **The same root as one or more tracked lists** — the same tag, author,
   *   series or words, filtered differently: "Track or update…", which offers to
   *   update one of them to this page's search, or to track the page as a new
   *   list.
   * 5. **Nothing**: "Track this search".
   *
   * What the page *is* includes the filter set on its custom search view, when
   * one is open ({@link liveFilter}): a tag's works narrowed in the view are a
   * different list from the tag's works as a whole.
   *
   * Every change is a write to the `trackedLists` option, or to this browser's
   * saved-list records (`savedLists`), or both, and stops there. Each reads both
   * afresh just before it writes, since the background files records as the
   * page is used. A write to `trackedLists` re-runs every unit, which rebuilds
   * this toolbar from the saved values — so what the pill says next came out of
   * storage, and a page can never disagree with the options about what it is.
   * (The reader-mode pill works the same way.) A write to the records alone —
   * saving a list nothing tracks back, and its Undo — re-runs nothing, so the
   * pill is drawn again from what was written ({@link trackWritten}). Ending the
   * refining mark isn't a write at all, so **Stop refining** rebuilds the pill
   * itself; and the view's filter changes without one, which {@link trackSync}
   * follows.
   */
  buildTrackButton(page: TrackablePage): HTMLElement | null {
    const state = this.listState()
    const lists = trackedOnly(state)
    const titles = titlesOf(state)
    const row = trackRow(page, state, this.options.trackedLists.enabled)
    if (!row)
      return null
    let group: HTMLElement
    switch (row.kind) {
      case 'refining':
        group = this.buildRefiningPill(page, row, lists, titles)
        break
      case 'exact':
        group = this.buildTrackedPill(row.entry, lists)
        break
      case 'saved':
        group = this.buildSavedPill(row.list)
        break
      case 'same-root':
        group = this.buildSameRootPill(page, row.candidates, lists, titles)
        break
      case 'new':
        group = this.buildNewListPill(page, titles)
        break
    }
    group.dataset.ao3eRow = rowSignature(row)
    return group
  }

  /**
   * The saved lists as this page last knew them, once it has written some
   * itself that re-ran nothing ({@link trackWritten}); null until then.
   */
  private lists: ListState | null = null

  /** The saved lists as this page knows them: the synced entries, and this browser's records. */
  private listState(): ListState {
    return this.lists ?? { tracked: this.options.trackedLists, saved: this.options.savedLists }
  }

  /** Draw the tracking pill again, as the lists now stand: in place, or where it goes, or not at all. */
  private redrawTrack(page: TrackablePage, panel: HTMLElement): void {
    const group = panel.querySelector<HTMLElement>(`:scope > .${TRACK_CLASS}`)
    const next = this.buildTrackButton(page)
    if (group && next)
      group.replaceWith(next)
    else if (group)
      group.remove()
    else if (next && panel.firstElementChild)
      panel.firstElementChild.after(next)
    else if (next)
      panel.prepend(next)
  }

  /**
   * What keeps the tracking pill in step with the page's custom search view, run
   * on every {@link refreshFilterToolbar}. The view's filter is part of what the
   * page is to a tracked list ({@link liveFilter}), so opening the view, setting
   * or clearing a facet, or closing the view again can make the page some other
   * list's, or no list's, or change what an update would do.
   *
   * Nothing happens until the filter on screen has actually changed, so a
   * render that only turned a page costs one comparison. After that:
   *
   * - with the pill's box shut, the pill is simply built again;
   * - with it open the reader may be part-way through it — a title typed, the
   *   diff being read — so it isn't pulled out from under them. When the pill
   *   would still say the same thing, only what the filter decides is redrawn in
   *   place: the diff, and whether another list already searches this. When it
   *   wouldn't, the new pill takes its place already open, with any title the
   *   reader typed carried across.
   *
   * Whatever is on screen when **Update** or **Track** is clicked is what gets
   * written: both read the filter again at that moment.
   */
  private trackSync(page: TrackablePage, panel: HTMLElement): () => void {
    let shown = filterSignature(liveFilter(page))
    return () => {
      const now = filterSignature(liveFilter(page))
      if (now === shown)
        return
      shown = now
      const group = panel.querySelector<HTMLElement>(`:scope > .${TRACK_CLASS}`)
      if (!group)
        return
      const open = group.querySelector(':scope > button')?.getAttribute('aria-expanded') === 'true'
      const row = trackRow(page, this.listState(), this.options.trackedLists.enabled)
      if (open && row && group.dataset.ao3eRow === rowSignature(row)) {
        trackRedraws.get(group)?.()
        return
      }
      const next = this.buildTrackButton(page)
      if (!next) {
        group.remove()
        return
      }
      if (open)
        carryOver(group, next)
      group.replaceWith(next)
    }
  }

  /** A page that is exactly a tracked list: it says so, and offers the two things left to do with it. */
  private buildTrackedPill(entry: TrackedList, lists: readonly TrackedList[]): HTMLElement {
    const label = sourceLabel(entry, lists)
    const { group, button } = trackPill(<MdiPlaylistCheck />, `Tracked as “${label}”`, 'This page is a tracked list. Its new and updated works turn up in your review.', true)
    const { box } = trackBox(group, button)
    this.fillTrackedBox(box, entry, label)
    return group
  }

  /**
   * A page that is exactly a saved list nothing tracks. It has its title, so one
   * click is all tracking it needs: under its own id, from today, so nothing
   * from before is poured in.
   */
  private buildSavedPill(list: SavedList): HTMLElement {
    const label = sourceLabel(aliasOf(list))
    const { group, button } = trackPill(<MdiPlaylistPlay />, `Track “${label}”`, `Track “${label}”, so works added or updated from today on turn up in your review.`)
    button.addEventListener('click', () => void this.trackSaved(list.id, label))
    return group
  }

  /** Track saved list `id`, as storage holds it now. */
  private async trackSaved(id: string, label: string): Promise<void> {
    if (!extensionAlive())
      return
    try {
      const before = await readListState()
      const plan = planTrack(before, id, utcToday())
      if (!plan.ok) {
        toast(`This search is already tracked as ${describeList(plan.twin)}.`, { type: 'error' })
        return
      }
      if (plan.state === before) {
        // Gone, or tracked already: either way the options say so, and the
        // write that would have redrawn this pill never comes.
        toast(`“${label}” is no longer a saved list waiting to be tracked.`, { type: 'error' })
        return
      }
      await writeListState(before, plan.state)
      toast(`Tracking “${label}”. Works added or updated from today on will turn up in your review.`, { type: 'success' })
    }
    catch (err) {
      this.logger.error('Could not track the list.', err)
      toast('Could not track this list. Please try again.', { type: 'error' })
    }
  }

  /** What a tracked list offers: stop, or go and look at the review. */
  private fillTrackedBox(box: HTMLElement, entry: TrackedList, label: string): void {
    const stop = minorButton('Stop tracking', 'Stop tracking this page. It stays a saved list on this browser, title and all.')
    stop.addEventListener('click', () => void this.stopTracking(entry.id, label))

    const row: HTMLElement = <div class={TRACK_ROW_CLASS}>{stop}</div>
    // The review lives on the reader's own readings page, so it takes a session.
    const userId = parseUser(document)?.userId
    if (userId) {
      const href = getArchiveLink(`/users/${encodeURIComponent(userId)}/readings#ao3e-tracked`)
      row.append(
        <a class={`${BUTTON_CLASS}  ${TRACK_MINOR_CLASS}`} href={href} title="Open your review of everything your tracked lists have turned up.">
          Review…
        </a>,
      )
    }
    box.append(row)
  }

  /** Stop tracking list `id`, as storage holds it now: its entry goes, and it stays a saved list on this browser. */
  private async stopTracking(id: string, label: string): Promise<void> {
    if (!extensionAlive())
      return
    try {
      const before = await readListState()
      await writeListState(before, planStopTracking(before, id))
      toast(`Stopped tracking “${label}”. It stays a saved list on this browser.`, { type: 'success' })
    }
    catch (err) {
      this.logger.error('Could not stop tracking the list.', err)
      toast('Could not stop tracking this list. Please try again.', { type: 'error' })
    }
  }

  /** A page nothing tracks yet: the box that titles a new list, and the one write that creates it. */
  private buildNewListPill(page: TrackablePage, titles: readonly ListTitle[]): HTMLElement {
    const { group, button } = trackPill(<MdiPlaylistPlus />, 'Track this search', 'Track this search, so works added or updated from now on turn up in one review stream.')
    // The box and the section each need the other: the box opens the section,
    // and the section's Cancel closes the box.
    let section: NewListSection | undefined
    const { box, close } = trackBox(group, button, () => section?.opened())
    section = this.newListSection(page, titles, close)
    box.append(...section.nodes)
    return group
  }

  /**
   * The title box and **Track** for a page about to become a new list. The title
   * starts as the page's default — "Type: entity", made unique among every saved
   * list's — which the reader edits there or later on the options page. A tag's
   * category that only the tag's own page can supply is asked for when the box
   * first opens, and put into the title unless the reader has typed over it by
   * then.
   */
  private newListSection(page: TrackablePage, titles: readonly ListTitle[], close: () => void): NewListSection {
    const nodes: Node[] = []
    // A relative date bound can't come along: it means a different span of days
    // every day it's read, and the review sets its own. Said here rather than
    // afterwards, because it changes what the reader is about to create.
    if (page.normalized.relativeDate)
      nodes.push(relativeDateNote(page))

    const title = titleField(uniqueTitle(defaultTitle(page.meta), titles))
    const track = minorButton('Track')
    const cancel = minorButton('Cancel')
    const save = (): void => void this.createList(page, title.input.value, track)
    track.addEventListener('click', save)
    cancel.addEventListener('click', close)
    title.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        save()
      }
      else if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    })
    const row: HTMLElement = (
      <div class={TRACK_ROW_CLASS}>
        {track}
        {cancel}
      </div>
    )
    nodes.push(title.input, row)

    return {
      nodes,
      opened: () => {
        if (metaUnsettled(page))
          void resolveMeta(page).then(meta => title.offer(uniqueTitle(defaultTitle(meta), titles)))
      },
    }
  }

  /**
   * The tab is refining `row.list`, a saved list tracked or not, and this page
   * is of its kind. Until the search differs from the list's (`changed`),
   * there's nothing to do but change it; once it does, the box says what an
   * update would change, and offers the update, a new list instead (while
   * Tracked lists is on), and a way out of refining.
   */
  private buildRefiningPill(page: TrackablePage, row: Extract<TrackRow, { kind: 'refining' }>, lists: readonly TrackedList[], titles: readonly ListTitle[]): HTMLElement {
    const { list, entry, changed } = row
    const label = entry ? sourceLabel(entry, lists) : sourceLabel(aliasOf(list))
    if (!changed) {
      const { group, button } = trackPill(<MdiPlaylistEdit />, `Refining “${label}”`, `This tab is refining “${label}”. Change the search, and the list can be updated to match it.`)
      const { box } = trackBox(group, button)
      box.append(
        <p class={TRACK_NOTE_CLASS}>Change the search, then update it here.</p>,
        <div class={TRACK_ROW_CLASS}>{this.stopRefiningButton(page, group, label)}</div>,
      )
      return group
    }

    const { group, button } = trackPill(<MdiPlaylistEdit />, `Update “${label}”`, `This page's search differs from “${label}”'s. Update the list to search this way instead.`)
    let meta = page.meta
    const summary: HTMLElement = <div class={TRACK_SUMMARY_CLASS} />
    const drawSummary = (): void => summary.replaceChildren(...this.updateSummary(list, entry !== null, page, meta, lists, label))
    drawSummary()
    trackRedraws.set(group, drawSummary)

    const offered = (): string => titleAfterUpdate(aliasOf(list), page.normalized.url, meta, titles)
    const title = titleField(offered())
    const update = minorButton(`Update “${label}”`, `Change “${label}” to search what this page does.${entry ? ' It keeps its place in your review.' : ''}`)
    // A title the reader hasn't touched is the one the update would offer, and
    // the update works it out again against the lists as they stand when it is
    // made, which this page's copy may be behind.
    update.addEventListener('click', () => void this.saveBack(page, list.id, label, update, {
      title: TYPED_KEY in title.input.dataset ? title.input.value : undefined,
      refining: true,
    }))
    const asNew = this.options.trackedLists.enabled
      ? minorButton('Track as a new list instead', `Leave “${label}” as it is, and track this page as a list of its own.`)
      : null
    if (asNew) {
      asNew.addEventListener('click', () => {
        // The box holds the list's own title, which a new list can't share:
        // unless the reader has typed another, the new one takes the page's
        // default.
        const typed = sameTitle(title.input.value, list.title) ? '' : title.input.value
        void this.createList(page, typed, asNew, true)
      })
    }
    title.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        update.click()
      }
    })

    const { box } = trackBox(group, button, () => {
      if (metaUnsettled(page)) {
        void resolveMeta(page).then((known) => {
          meta = known
          drawSummary()
          title.offer(offered())
        })
      }
    })
    box.append(summary)
    if (page.normalized.relativeDate)
      box.append(relativeDateNote(page))
    box.append(
      title.input,
      <div class={TRACK_ROW_CLASS}>{update}</div>,
      <div class={TRACK_ROW_CLASS}>
        {asNew}
        {this.stopRefiningButton(page, group, label)}
      </div>,
    )
    return group
  }

  /** Ends the tab's refining mark, leaving the list exactly as it is. */
  private stopRefiningButton(page: TrackablePage, group: HTMLElement, label: string): HTMLButtonElement {
    const stop = minorButton('Stop refining', `Stop refining “${label}” in this tab. The list stays exactly as it is.`)
    stop.addEventListener('click', () => {
      endRefining()
      // Not a write, so nothing re-runs: the pill is rebuilt here, for what the
      // page is without the mark, which with Tracked lists off is no pill at all.
      const next = this.buildTrackButton(page)
      if (next)
        group.replaceWith(next)
      else
        group.remove()
    })
    return stop
  }

  /**
   * The page shares a root with `candidates` without being any of them: offer to
   * update one to this page's search, to go and refine one from its own page, or
   * to track this page as a list of its own. Several candidates are chosen
   * between by title.
   */
  private buildSameRootPill(page: TrackablePage, candidates: readonly TrackedList[], lists: readonly TrackedList[], titles: readonly ListTitle[]): HTMLElement {
    const { group, button } = trackPill(<MdiPlaylistPlus />, 'Track or update…', 'This page searches what a list you track does, filtered differently. Update that list to search this way, or track the page as a new list.')

    const sorted = [...candidates].sort((a, b) => compareTitles(sourceLabel(a, lists), sourceLabel(b, lists)))
    let chosen = sorted[0]!
    let meta = page.meta
    const name: HTMLElement = <p class={TRACK_NOTE_CLASS} />
    const chooser = sorted.length > 1
      ? (
          <select class={TRACK_CHOOSER_CLASS} aria-label="List to update">
            {sorted.map(one => <option value={one.id}>{sourceLabel(one, lists)}</option>)}
          </select>
        ) as HTMLElement as HTMLSelectElement
      : null
    const summary: HTMLElement = <div class={TRACK_SUMMARY_CLASS} />
    const update = minorButton('')
    const refine = minorButton('')
    const draw = (): void => {
      const label = sourceLabel(chosen, lists)
      name.textContent = `“${label}”`
      summary.replaceChildren(...this.updateSummary(chosen, true, page, meta, lists, label))
      update.textContent = `Update “${label}”`
      update.title = `Change “${label}” to search what this page does. It keeps its place in your review.`
      refine.textContent = `Refine “${label}”`
      refine.title = `Open “${label}”'s own search in this tab, to change it from there.`
    }
    draw()
    trackRedraws.set(group, draw)

    chooser?.addEventListener('change', () => {
      chosen = sorted.find(one => one.id === chooser.value) ?? chosen
      draw()
    })
    update.addEventListener('click', () => void this.saveBack(page, chosen.id, sourceLabel(chosen, lists), update, { refining: false }))
    refine.addEventListener('click', () => {
      if (!extensionAlive())
        return
      if (!openRefining(chosen))
        toast(`“${sourceLabel(chosen, lists)}” isn't a page on AO3, so it can't be opened.`, { type: 'error' })
    })

    let section: NewListSection | undefined
    const { box, close } = trackBox(group, button, () => {
      section?.opened()
      if (metaUnsettled(page)) {
        void resolveMeta(page).then((known) => {
          meta = known
          draw()
        })
      }
    })
    section = this.newListSection(page, titles, close)
    box.append(
      <p class={TRACK_HEAD_CLASS}>Update a list</p>,
      chooser ?? name,
      summary,
      <div class={TRACK_ROW_CLASS}>
        {update}
        {refine}
      </div>,
      <p class={TRACK_HEAD_CLASS}>Track as a new list</p>,
      ...section.nodes,
    )
    return group
  }

  /**
   * What updating `list` to this page would change ({@link describeUpdate}): a
   * warning when it moves the list to another root, a line per change — ids the
   * page's own Sort & Filter sidebar has a label for named, the rest counted —
   * and, for a `tracked` list, a warning when another tracked list already
   * searches exactly this. A saved list nothing tracks may search what a tracked
   * one does.
   */
  private updateSummary(list: Pick<TrackedList, 'id' | 'url' | 'filter' | 'type' | 'entity'>, tracked: boolean, page: TrackablePage, meta: TrackedMeta, lists: readonly TrackedList[], label: string): Node[] {
    const filter = liveFilter(page)
    const update = describeUpdate(list, { url: page.normalized.url, filter, type: meta.type, entity: meta.entity }, { nameId: sidebarNameId })
    const nodes: Node[] = []
    if (update.root)
      nodes.push(<p class={TRACK_WARN_CLASS}>{rootMoveText(label, update.root)}</p>)
    if (update.changes.length) {
      nodes.push(
        <ul class={TRACK_DIFF_CLASS} aria-label={`What updating “${label}” changes`}>
          {update.changes.map(change => <li>{change.text}</li>)}
        </ul>,
      )
    }
    else if (!update.root) {
      nodes.push(<p class={TRACK_NOTE_CLASS}>{`This page's search differs from “${label}”'s.`}</p>)
    }
    const pageKey = filteredKey(page.normalized.key, filter)
    const twin = tracked ? lists.find(one => one.id !== list.id && trackedKey(one) === pageKey) : undefined
    if (twin)
      nodes.push(<p class={TRACK_WARN_CLASS}>{`This search is already tracked as “${sourceLabel(twin, lists)}”, so “${label}” can't become it.`}</p>)
    return nodes
  }

  /**
   * Track this page as a list, titled `typed` — or, left blank, by the page's
   * default. The lists are read afresh first: a saved list that is exactly this
   * search ({@link savedListAt}), which the background may have filed since the
   * page was drawn, is the one tracked, under its own id; otherwise the page
   * becomes a new list. Refuses a title another list has, and a search another
   * list tracks, and says which. `button` shows the work while it's done, and
   * stays disabled once it has worked: the write rebuilds the toolbar around
   * it. `endsRefining` is the refining box's **Track as a new list instead**,
   * which is the end of refining the list it was for.
   */
  private async createList(page: TrackablePage, typed: string, button: HTMLButtonElement, endsRefining = false): Promise<void> {
    if (button.disabled || !extensionAlive())
      return
    const text = button.textContent
    button.disabled = true
    try {
      const meta = await resolveMeta(page)
      const known = await readListState()
      const existing = savedListAt(known, filteredKey(page.normalized.key, liveFilter(page)))
      const titles = titlesOf(known)
      const title = typed.trim() || uniqueTitle(defaultTitle(meta), titles, existing?.id)
      const taken = titleTakenBy(title, titles, existing?.id)
      if (taken) {
        toast(titleRefusal(taken), { type: 'error' })
      }
      else {
        // An uncommon tag costs one request here (see `needsScan`) — long enough
        // to be worth saying something about.
        if (page.normalized.kind === 'tag-works')
          button.textContent = 'Checking…'
        const scan = await needsScan(page)
        // Read now rather than when the box was drawn: what's on screen as the
        // list is made is what it's made of, and the lists as they stand now
        // are what it joins.
        const filter = liveFilter(page)
        const before = await readListState()
        const plan = planTrackSearch(before, pageQuery(page, scan, meta, filter), title, utcToday())
        if (plan.ok) {
          if (endsRefining)
            endRefining()
          await writeListState(before, plan.state)
          toast(
            `Tracking “${title}”. Works added or updated from today on will turn up in your review.${
              scan ? ' This tag is read from its own page, so an update to an older work may be missed.' : ''}`,
            { type: 'success' },
          )
          return
        }
        toast('twin' in plan ? `This search is already tracked as ${describeList(plan.twin)}.` : titleRefusal(aliasOf(plan.takenBy)), { type: 'error' })
      }
    }
    catch (err) {
      this.logger.error('Could not save the tracked list.', err)
      toast('Could not save this list. Please try again.', { type: 'error' })
    }
    // The rebuild that would have replaced this box never came, so the box has to
    // be usable again.
    button.disabled = false
    button.textContent = text
  }

  /**
   * Save this page's search back to saved list `id` ({@link planSaveBack}),
   * tracked or not: its record rewritten in place under its own id, and its
   * entry with it while it is tracked. Then offer to take it back.
   *
   * The lists are read afresh, since the background files records as the page
   * is used. The copies stored at the list's old address are set aside before
   * the list moves, so that no moment has copies at an address with no record,
   * which the background would make a list of; Undo puts them back, and they go
   * for good when its time is up. `title` is one the reader typed into the box;
   * blank, the page's default; absent, the list's own, or the new search's
   * default where the old one was only ever its default. `refining` ends the
   * tab's mark: the list it was for has become what the reader made of it. A
   * list that is gone ends it too, since there is nothing left to refine.
   */
  private async saveBack(page: TrackablePage, id: string, label: string, button: HTMLButtonElement, opts: { title?: string, refining: boolean }): Promise<void> {
    if (button.disabled || !extensionAlive())
      return
    const text = button.textContent
    button.disabled = true
    try {
      const meta = await resolveMeta(page)
      const asked = (scan?: boolean): SaveBackPage => ({ url: page.normalized.url, kind: page.normalized.kind, meta, filter: liveFilter(page), scan, title: opts.title })
      const known = await readListState()
      let plan: SaveBackPlan = planSaveBack(known, id, asked(), [])
      let before = known
      if (plan.ok) {
        // Whether a tag's works can be read by date was checked for the tag the
        // list was made on. Another tag has to be checked again.
        let scan: boolean | undefined
        const list = savedListsOf(known).find(one => one.list.id === id)?.list
        if (page.normalized.kind === 'tag-works' && list && trackedRoot(list) !== trackedRoot(page.normalized)) {
          button.textContent = 'Checking…'
          scan = await needsScan(page)
        }
        before = await readListState()
        plan = planSaveBack(before, id, asked(scan), storedListRefs(await cache.get('searchLists')))
      }
      if (plan.ok) {
        const detached = await detachCopies(plan.dropCopies)
        try {
          await writeListState(before, plan.state)
        }
        catch (err) {
          await restoreCopies(detached)
          throw err
        }
        if (opts.refining)
          endRefining()
        trackWritten?.(plan.state)
        offerUndo({ id, before, after: plan.state, absorbed: plan.absorbed }, detached, opts.refining)
        return
      }
      if (plan.reason === 'missing' && opts.refining) {
        endRefining()
        trackWritten?.(before)
      }
      toast(saveBackRefusal(plan, label), { type: 'error' })
    }
    catch (err) {
      this.logger.error('Could not save the list back.', err)
      toast('Could not update this list. Please try again.', { type: 'error' })
    }
    button.disabled = false
    button.textContent = text
  }

  /**
   * Fill in what the tracked lists rooted where this page is don't say yet — a
   * tag's category, a series' title — from what the page itself says
   * ({@link fillMeta}), into the lists as storage holds them. Nothing is fetched
   * for it, and nothing is written when there's nothing to fill, so the re-run a
   * write causes finds nothing more to do.
   */
  private async learnMeta(page: TrackablePage): Promise<void> {
    if (!learnedMeta(this.options.trackedLists.lists, page) || !extensionAlive())
      return
    try {
      const trackedLists = await options.get('trackedLists')
      const lists = learnedMeta(trackedLists.lists, page)
      if (lists)
        await options.set({ trackedLists: { ...trackedLists, lists } })
    }
    catch (err) {
      this.logger.error('Could not record what this page says about its lists.', err)
    }
  }

  buildOptionsButton(): HTMLElement {
    const label = 'Open the AO3 Enhancements options page'
    const button: HTMLButtonElement = (
      <button type="button" class={BUTTON_CLASS} title={label} aria-label={label}>
        <span class={`${ADDON_CLASS}--filter-toolbar--icon`}><MdiCog /></span>
        <span>Open extension options…</span>
      </button>
    ) as HTMLElement as HTMLButtonElement

    button.addEventListener('click', () => {
      if (!extensionAlive())
        return
      void api.openOptionsPage.sendToBackground()
    })

    return button
  }
}

// ---------------------------------------------------------------------------
// The tracking pill's parts
// ---------------------------------------------------------------------------

/** A new list's title box and buttons, and what to do when the box they're in first opens. */
interface NewListSection {
  nodes: Node[]
  opened: () => void
}

/**
 * The view filter on screen, which a page is compared by and a list written
 * with, alongside its URL: the reader's own filter on the custom search view
 * open over this page ({@link activeSearchFilter}), as a list would store it —
 * or none, when no view is open or the view narrows nothing.
 *
 * Only a view *of this page's listing* counts: one whose source is the same
 * query, or the same root ({@link sameRoot}), of the same kind. A view a page
 * merely offers — Marked for Later on a readings page — is filtered, but not
 * a filter of anything the page could be tracked as.
 */
function liveFilter(page: TrackablePage): TrackedFilter | undefined {
  const open = activeSearchFilter()
  if (!open)
    return undefined
  const listing = normalizeTrackedUrl(open.descriptor.listUrl)
  if (!listing || listing.kind !== page.normalized.kind)
    return undefined
  // The key as well as the root, for a works search with nothing to be a search
  // of — no words, title, creator or tag names, only such fields as a rating: it
  // has no root, and is still the very search its view was opened on.
  if (listing.key !== page.normalized.key && !sameRoot(listing, page.normalized))
    return undefined
  return trackedFilterOf(open.filter)
}

/** A live filter in a form two can be compared in. Canonical, so its JSON is. */
function filterSignature(filter: TrackedFilter | undefined): string {
  return JSON.stringify(filter ?? null)
}

/** A list as the title helpers read one: a saved list's title as its alias. */
type ListTitle = Pick<TrackedList, 'id' | 'alias' | 'url' | 'type' | 'entity'>

/** The entries of the lists tracked right now, in their stored order. */
function trackedOnly(state: ListState): TrackedList[] {
  return state.tracked.lists.filter(one => one.tracked === true)
}

/** Every saved list's title, tracked or not: what a title has to be unique among. */
function titlesOf(state: ListState): ListTitle[] {
  return savedListsOf(state).map(({ list }) => aliasOf(list))
}

/** The saved lists as storage holds them now, rather than as this page's options were read. */
async function readListState(): Promise<ListState> {
  const { trackedLists, savedLists } = await options.get(['trackedLists', 'savedLists'])
  return { tracked: trackedLists, saved: savedLists }
}

/** Write what a plan given `before` changed, in one write. */
async function writeListState(before: ListState, next: ListState): Promise<void> {
  const update = savedListsWrite(before, next)
  if (Object.keys(update).length && extensionAlive())
    await options.set(update)
}

/** Which of {@link FilterToolbar.buildTrackButton}'s rows the page is in, and for which lists. */
type TrackRow
  = | { kind: 'refining', list: SavedList, entry: TrackedList | null, changed: boolean }
    | { kind: 'exact', entry: TrackedList }
    | { kind: 'saved', list: SavedList }
    | { kind: 'same-root', candidates: TrackedList[] }
    | { kind: 'new' }

/**
 * The first row that applies, in {@link FilterToolbar.buildTrackButton}'s
 * order, or null for none. Without `tracking` (Tracked lists switched off),
 * only the refining row does.
 */
function trackRow(page: TrackablePage, state: ListState, tracking: boolean): TrackRow | null {
  const lists = trackedOnly(state)
  const pageKey = filteredKey(page.normalized.key, liveFilter(page))
  const refining = refiningList(savedListsOf(state).map(({ list }) => list))
  if (refining && refining.kind === page.normalized.kind) {
    const entry = lists.find(one => one.id === refining.id) ?? null
    return { kind: 'refining', list: refining, entry, changed: trackedKey(entry ?? refining) !== pageKey }
  }
  if (!tracking)
    return null
  const entry = lists.find(one => trackedKey(one) === pageKey)
  if (entry)
    return { kind: 'exact', entry }
  const saved = savedListAt(state, pageKey)
  if (saved)
    return { kind: 'saved', list: saved }
  const candidates = lists.filter(one => sameRoot(one, page.normalized))
  return candidates.length ? { kind: 'same-root', candidates } : { kind: 'new' }
}

/** A row as a string, so a pill can say which one it was built for. Two equal ones draw the same pill. */
function rowSignature(row: TrackRow): string {
  switch (row.kind) {
    case 'refining':
      return `refining:${row.list.id}:${row.changed ? 'changed' : 'same'}`
    case 'exact':
      return `exact:${row.entry.id}`
    case 'saved':
      return `saved:${row.list.id}`
    case 'same-root':
      return `same-root:${row.candidates.map(one => one.id).join(',')}`
    case 'new':
      return 'new'
  }
}

/**
 * Open `next`'s box, as `old`'s was, before `next` takes its place — keeping any
 * title the reader typed into `old`'s box, when `next` has a title box too.
 *
 * Only a pill with a box is opened. One without is a single action — tracking
 * a saved list — which is the reader's to click, not this.
 */
function carryOver(old: HTMLElement, next: HTMLElement): void {
  if (!next.querySelector(`:scope > .${TRACK_BOX_CLASS}`))
    return
  const typed = old.querySelector<HTMLInputElement>(`input.${TRACK_INPUT_CLASS}`)
  const input = next.querySelector<HTMLInputElement>(`input.${TRACK_INPUT_CLASS}`)
  if (typed && input && TYPED_KEY in typed.dataset) {
    input.value = typed.value
    input.dataset[TYPED_KEY] = ''
  }
  next.querySelector<HTMLButtonElement>(':scope > button')?.click()
}

/** The pill itself, in a group the box can grow under. */
function trackPill(icon: JSX.Element, text: string, title: string, pressed = false): { group: HTMLElement, button: HTMLButtonElement } {
  const group: HTMLElement = <div class={TRACK_CLASS} />
  const button: HTMLButtonElement = (
    <button type="button" class={BUTTON_CLASS} title={title} aria-label={title}>
      <span class={`${ADDON_CLASS}--filter-toolbar--icon`}>{icon}</span>
      <span class={`${TRACK_CLASS}--text`}>{text}</span>
    </button>
  ) as HTMLElement as HTMLButtonElement
  // Set rather than written into the JSX: a boolean there is rendered as a bare
  // attribute (`aria-pressed=""`), which is not one of the values it may take.
  button.setAttribute('aria-pressed', String(pressed))
  group.append(button)
  return { group, button }
}

/**
 * The box under a pill, revealed by clicking it. Built up front, so the reader's
 * typing survives a re-render of nothing else. `onFirstOpen` runs the first time
 * it opens — which is when anything worth asking the archive for is asked.
 */
function trackBox(group: HTMLElement, button: HTMLButtonElement, onFirstOpen?: () => void): { box: HTMLElement, close: () => void } {
  const box: HTMLElement = <div class={TRACK_BOX_CLASS} hidden />
  group.append(box)
  let open = false
  let opened = false
  const setOpen = (next: boolean): void => {
    open = next
    box.hidden = !open
    button.setAttribute('aria-expanded', String(open))
    if (open && !opened) {
      opened = true
      onFirstOpen?.()
    }
  }
  setOpen(false)
  button.addEventListener('click', () => setOpen(!open))
  return { box, close: () => setOpen(false) }
}

/** One of a box's own buttons. */
function minorButton(text: string, title?: string): HTMLButtonElement {
  const button = (
    <button type="button" class={`${BUTTON_CLASS}  ${TRACK_MINOR_CLASS}`}>{text}</button>
  ) as HTMLElement as HTMLButtonElement
  if (title)
    button.title = title
  return button
}

/**
 * A list's title box. `offer` puts a better default in — a tag's category that
 * arrived late — but only while the box still holds the last one offered, so
 * nothing the reader typed is ever replaced.
 */
function titleField(initial: string): { input: HTMLInputElement, offer: (title: string) => void } {
  const input = (
    <input type="text" class={TRACK_INPUT_CLASS} value={initial} aria-label="Title for this list" placeholder="Title for this list" />
  ) as HTMLElement as HTMLInputElement
  input.addEventListener('input', () => {
    input.dataset[TYPED_KEY] = ''
  })
  let offered = initial
  return {
    input,
    offer: (title) => {
      if (input.value === offered)
        input.value = title
      offered = title
    },
  }
}

/** Why the relative date bound on this page won't be part of the list. */
function relativeDateNote(page: TrackablePage): HTMLElement {
  return (
    <p class={TRACK_NOTE_CLASS}>
      {`The “${page.normalized.relativeDate}” date filter is left out — tracking follows your review's own dates instead.`}
    </p>
  )
}

/**
 * The warning an update that moves a list to another root shows first: "This
 * changes what “X” searches: from Harry Potter to Marvel." The type is named too
 * when it changes with the root.
 */
function rootMoveText(label: string, root: { from: TrackedMeta, to: TrackedMeta }): string {
  const sameType = root.from.type === root.to.type
  const name = (meta: TrackedMeta): string => (sameType ? meta.entity || 'a search with no words' : defaultTitle(meta))
  return `This changes what “${label}” searches: from ${name(root.from)} to ${name(root.to)}.`
}

/** Titles in the order a reader looks for them in. */
function compareTitles(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
}

/** Which list a refusal is about: its title, and what it is when the title doesn't say. */
function describeList(list: ListTitle): string {
  const title = sourceLabel(list)
  const meta = trackedMeta(list)
  return meta && !sameTitle(title, defaultTitle(meta)) ? `“${title}” (${defaultTitle(meta)})` : `“${title}”`
}

/** A title the reader typed that another list already has. */
function titleRefusal(other: ListTitle): string {
  return `Another list is already called ${describeList(other)}. Choose a different title.`
}

function saveBackRefusal(plan: Extract<SaveBackPlan, { ok: false }>, label: string): string {
  switch (plan.reason) {
    case 'duplicate':
      return `This search is already tracked as ${describeList(plan.other)}, so “${label}” was left as it was.`
    case 'title':
      return titleRefusal(aliasOf(plan.other))
    case 'missing':
      return `“${label}” no longer exists — it was removed on the options page, or by a sync.`
    case 'invalid':
      return 'This page can’t be tracked.'
  }
}

function undoRefusal(plan: Extract<SaveBackUndoPlan, { ok: false }>, label: string): string {
  switch (plan.reason) {
    case 'missing':
      return `“${label}” no longer exists, so the update can’t be undone.`
    case 'changed':
      return `“${label}” has changed again since, so the update can’t be undone.`
    case 'duplicate':
      return `${describeList(plan.other)} now searches what “${label}” used to, so the update can’t be undone.`
    case 'title':
      return `Another list is now called ${describeList(aliasOf(plan.other))}, so the update can’t be undone.`
  }
}

/** List `id`'s title in `state`, as the toasts name it. */
function titleIn(state: ListState, id: string): string {
  const found = savedListsOf(state).find(({ list }) => list.id === id)
  return found ? sourceLabel(aliasOf(found.list)) : ''
}

/** Set aside each stored list in `keys` ({@link detachSnapshot}), in turn, for an Undo to put back. */
async function detachCopies(keys: readonly string[]): Promise<DetachedSnapshot[]> {
  const detached: DetachedSnapshot[] = []
  for (const key of keys) {
    const one = await detachSnapshot(key)
    if (one)
      detached.push(one)
  }
  return detached
}

/** Put back each stored list {@link detachCopies} set aside. */
async function restoreCopies(detached: readonly DetachedSnapshot[]): Promise<void> {
  for (const one of detached)
    await restoreSnapshot(one)
}

/**
 * Settle the copies set aside for an Undo that won't come ({@link planLetGo}),
 * against the lists as they stand now: a list may have come to their address
 * meanwhile, by a sync or from another tab, and then they are its copies, put
 * back as they were. The rest go for good ({@link pruneDetached}), and so does
 * one whose key has had a list stored under it since, which stands in for it.
 */
async function letGo(detached: readonly DetachedSnapshot[]): Promise<void> {
  if (!detached.length || !extensionAlive())
    return
  try {
    const setAside = storedListRefs(Object.fromEntries(detached.map(one => [one.key, one.list])))
    const { restore } = planLetGo(await readListState(), setAside, storedListRefs(await cache.get('searchLists')))
    const gone: DetachedSnapshot[] = []
    for (const one of detached) {
      if (!restore.includes(one.key) || !await restoreSnapshot(one))
        gone.push(one)
    }
    if (gone.length)
      await pruneDetached(gone)
  }
  catch (err) {
    FilterToolbar.logger.error('Could not settle the old copies.', err)
  }
}

/**
 * The toast after a save-back, which can take it back for a while. It outlives
 * the rebuild the save-back's own write may cause, so it works from storage,
 * not from this page's copy of the lists. When it goes without being used, the
 * copies set aside are settled ({@link letGo}).
 */
function offerUndo(done: SaveBackDone, detached: readonly DetachedSnapshot[], wasRefining: boolean): void {
  let undone = false
  toast(`Updated “${titleIn(done.after, done.id)}”.`, {
    type: 'success',
    timeout: SAVE_BACK_UNDO_TIMEOUT,
    action: {
      label: 'Undo',
      onClick: () => {
        undone = true
        void undoSaveBack(done, detached, wasRefining)
      },
    },
    onHide: () => {
      if (!undone)
        void letGo(detached)
    },
  })
}

/**
 * Put back what a save-back changed ({@link planUndoSaveBack}): the lists
 * first, then the copies it set aside, so that no moment has those copies at
 * an address with no record. The tab goes back to refining the list, if it was.
 */
async function undoSaveBack(done: SaveBackDone, detached: readonly DetachedSnapshot[], wasRefining: boolean): Promise<void> {
  if (!extensionAlive())
    return
  const label = titleIn(done.after, done.id)
  try {
    const state = await readListState()
    const plan = planUndoSaveBack(state, done)
    if (!plan.ok) {
      toast(undoRefusal(plan, label), { type: 'error' })
      await letGo(detached)
      return
    }
    // Back to where the reader was: refining the list, from the page as it is.
    if (wasRefining)
      startRefining(done.id, false)
    await writeListState(state, plan.state)
    await restoreCopies(detached)
    trackWritten?.(plan.state)
    toast(`Put “${titleIn(plan.state, done.id)}” back as it was.`, { type: 'success' })
  }
  catch (err) {
    FilterToolbar.logger.error('Could not undo the update.', err)
    toast('Could not undo the update. Please try again.', { type: 'error' })
  }
}

/**
 * The entries with what this page says about their root filled in
 * ({@link fillMeta}), or null when it fills in nothing.
 */
function learnedMeta(lists: readonly TrackedList[], page: TrackablePage): TrackedList[] | null {
  let learned = false
  const next = lists.map((one) => {
    const filled = sameRoot(one, page.normalized) ? fillMeta(one, page.meta) : null
    if (!filled)
      return one
    learned = true
    return { ...one, ...filled }
  })
  return learned ? next : null
}
