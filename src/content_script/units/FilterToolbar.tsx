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

import type { TrackedFilter, TrackedList, TrackedMeta, TrackedUndoPlan, TrackedUpdatePlan } from '#common'
import type { TrackablePage } from '#content_script/tracked/createList.ts'

import { ADDON_CLASS, api, defaultTitle, describeUpdate, fillMeta, filteredKey, getArchiveLink, marksHideAnything, options, parseUser, planUndo, planUpdate, sameRoot, sourceLabel, titleTakenBy, toast, trackedKey, trackedMeta, trackedRoot, uniqueTitle, utcToday } from '#common'
import { getMenusEnabled, setMenusEnabled } from '#content_script/contextTrigger.js'
import { extensionAlive } from '#content_script/extensionAlive.js'
import { NATIVE_HIDDEN_CLASS, VIEW_HIDDEN_CLASS } from '#content_script/searchView/classes.ts'
import { findWorkText } from '#content_script/textReplaceScope.ts'
import { metaUnsettled, needsScan, newEntry, resolveMeta, sidebarNameId, trackablePage } from '#content_script/tracked/createList.ts'
import { endRefining, openRefining, refiningList, startRefining, takeRefiningLink } from '#content_script/tracked/refining.ts'
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

/** Toggled on <body> to temporarily reveal works hidden by any filter (see CSS). */
const PEEK_CLASS = `${ADDON_CLASS}--peek-hidden`

/**
 * Blurbs HideWorks hid (at least partly) — by a tag, author, crossover or
 * language filter. Every hidden work carries `data-ao3e-hidden-by`, so this
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
let peekPending = false

/**
 * Bring the peek pill in line with what's actually hidden now — adding or
 * dropping it as that count crosses zero. Called by the search view after every
 * render, and when it closes; coalesced to one pass per frame.
 */
export function refreshFilterToolbar(): void {
  if (!syncPeek || peekPending)
    return
  peekPending = true
  requestAnimationFrame(() => {
    peekPending = false
    syncPeek?.()
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
 *   differently — or in a tab opened to refine a list — it offers to update that
 *   list instead. See {@link buildTrackButton}.
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
    const { filterToolbar, rules, hideCrossovers, hideLanguages, workMarks } = this.options
    return filterToolbar && (
      rules.enabled || hideCrossovers.enabled || hideLanguages.enabled
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
    // A tab opened by a list's refining link remembers the list, whatever this
    // page turns out to be — see {@link file://../tracked/refining.ts}.
    if (tracking)
      takeRefiningLink(this.options.trackedLists.lists)
    // Whether this page is a query a review could read — a DOM question as well
    // as a URL one for an uncommon tag, so it can only be asked now.
    const trackable = tracking ? trackablePage() : null
    if (trackable)
      this.learnMeta(trackable)

    document.body.append(this.buildToolbar(showPeek, showMenus, showReader, showReplace, trackable))
    this.logger.debug(`Filter toolbar added (peek: ${showPeek}, menus toggle: ${showMenus}, reader: ${showReader}, replace tools: ${showReplace}, trackable: ${trackable?.normalized.kind ?? 'no'}).`)
  }

  buildToolbar(showPeek: boolean, showMenus: boolean, showReader: boolean, showReplace: boolean, trackable: TrackablePage | null): HTMLElement {
    const panel = <div class={PANEL_CLASS} role="group" />
    panel.append(this.buildOptionsButton())
    if (trackable)
      panel.append(this.buildTrackButton(trackable))
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
   * The tracking control, in whichever state the page is in. The first row that
   * applies wins:
   *
   * 1. **Refining a list** — the tab was opened by that list's link on the options
   *   page ({@link file://../tracked/refining.ts}) — and the page is of the list's
   *   kind: "Update “X”" once the search differs from X's, else "Refining “X”". A
   *   page of another kind can't become X's query, so there the mark waits and
   *   the rows below apply.
   * 2. **Exactly a list**: "Tracked as “X”", or "Resume tracking “X”" if it's
   *   paused.
   * 3. **The same root as one or more lists** — the same tag, author, series or
   *   words, filtered differently: "Track or update…", which offers to update one
   *   of them to this page's search, or to track the page as a new list.
   * 4. **Nothing**: "Track this search".
   *
   * Every change is a write to the `trackedLists` option, and stops there. The
   * write re-runs every unit, which rebuilds this toolbar from the saved value —
   * so what the pill says next came out of storage, and a page can never disagree
   * with the options about what it is. (The reader-mode pill works the same way.)
   * Ending the refining mark is the one change that isn't a write, so **Stop
   * refining** rebuilds the pill itself.
   */
  buildTrackButton(page: TrackablePage): HTMLElement {
    const lists = this.options.trackedLists.lists
    const pageKey = filteredKey(page.normalized.key, liveFilter())
    const refining = refiningList(lists)
    if (refining && refining.kind === page.normalized.kind)
      return this.buildRefiningPill(page, refining, lists, pageKey)
    const entry = lists.find(one => trackedKey(one) === pageKey)
    if (entry)
      return this.buildTrackedPill(entry, lists)
    const candidates = lists.filter(one => sameRoot(one, page.normalized))
    return candidates.length
      ? this.buildSameRootPill(page, candidates, lists)
      : this.buildNewListPill(page, lists)
  }

  /**
   * A page that is exactly a list. Tracked, it says so and offers the two things
   * left to do with it; paused, one click starts it again — from today, so the
   * stretch the reader chose to skip isn't poured back in.
   */
  private buildTrackedPill(entry: TrackedList, lists: readonly TrackedList[]): HTMLElement {
    const label = sourceLabel(entry, lists)
    const { group, button } = entry.tracked
      ? trackPill(<MdiPlaylistCheck />, `Tracked as “${label}”`, 'This page is a tracked list. Its new and updated works turn up in your review.', true)
      : trackPill(<MdiPlaylistPlay />, `Resume tracking “${label}”`, 'Tracking is paused for this page. Starting again picks up from today — nothing from the gap is filled in.')

    // Paused is the one state whose click needs nothing from the reader.
    if (!entry.tracked) {
      button.addEventListener('click', () => {
        void this.writeLists(lists.map(one => (one.id === entry.id ? { ...one, tracked: true, since: utcToday() } : one)))
        toast(`Tracking “${label}” again, from today on.`, { type: 'success' })
      })
      return group
    }

    const { box } = trackBox(group, button)
    this.fillTrackedBox(box, entry, label)
    return group
  }

  /** What a tracked list offers: stop, or go and look at the review. */
  private fillTrackedBox(box: HTMLElement, entry: TrackedList, label: string): void {
    const lists = this.options.trackedLists.lists
    const stop = minorButton('Stop tracking', 'Stop tracking this page. The list is kept, so its title and its place come back if you resume.')
    stop.addEventListener('click', () => {
      void this.writeLists(lists.map(one => (one.id === entry.id ? { ...one, tracked: false } : one)))
      toast(`Stopped tracking “${label}”. The list is kept — resume it any time.`, { type: 'success' })
    })

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

  /** A page nothing tracks yet: the box that titles a new list, and the one write that creates it. */
  private buildNewListPill(page: TrackablePage, lists: readonly TrackedList[]): HTMLElement {
    const { group, button } = trackPill(<MdiPlaylistPlus />, 'Track this search', 'Track this search, so works added or updated from now on turn up in one review stream.')
    // The box and the section each need the other: the box opens the section,
    // and the section's Cancel closes the box.
    let section: NewListSection | undefined
    const { box, close } = trackBox(group, button, () => section?.opened())
    section = this.newListSection(page, lists, close)
    box.append(...section.nodes)
    return group
  }

  /**
   * The title box and **Track** for a page about to become a new list. The title
   * starts as the page's default — "Type: entity", made unique — which the reader
   * edits there or later on the options page. A tag's category that only the
   * tag's own page can supply is asked for when the box first opens, and put
   * into the title unless the reader has typed over it by then.
   */
  private newListSection(page: TrackablePage, lists: readonly TrackedList[], close: () => void): NewListSection {
    const nodes: Node[] = []
    // A relative date bound can't come along: it means a different span of days
    // every day it's read, and the review sets its own. Said here rather than
    // afterwards, because it changes what the reader is about to create.
    if (page.normalized.relativeDate)
      nodes.push(relativeDateNote(page))

    const title = titleField(uniqueTitle(defaultTitle(page.meta), lists))
    const track = minorButton('Track')
    const cancel = minorButton('Cancel')
    const save = (): void => void this.createList(page, lists, title.input.value, track)
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
          void resolveMeta(page).then(meta => title.offer(uniqueTitle(defaultTitle(meta), lists)))
      },
    }
  }

  /**
   * The tab is refining `list`, and this page is of its kind. Until the search
   * differs from the list's, there's nothing to do but change it; once it does,
   * the box says what an update would change, and offers the update, a new list
   * instead, and a way out of refining.
   */
  private buildRefiningPill(page: TrackablePage, list: TrackedList, lists: readonly TrackedList[], pageKey: string): HTMLElement {
    const label = sourceLabel(list, lists)
    if (trackedKey(list) === pageKey) {
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
    const drawSummary = (): void => summary.replaceChildren(...this.updateSummary(list, page, meta, lists, label))
    drawSummary()

    const offered = (): string => titleAfterUpdate(list, page, meta, lists)
    const title = titleField(offered())
    const update = minorButton(`Update “${label}”`, `Change “${label}” to search what this page does. It keeps its place in your review.`)
    const asNew = minorButton('Track as a new list instead', `Leave “${label}” as it is, and track this page as a list of its own.`)
    update.addEventListener('click', () => void this.updateList(page, list, lists, update, { alias: title.input.value, refining: true }))
    asNew.addEventListener('click', () => {
      // The box holds the list's own title, which a new list can't share: unless
      // the reader has typed another, the new one takes the page's default.
      const typed = sameTitle(title.input.value, list.alias) ? '' : title.input.value
      void this.createList(page, lists, typed, asNew, true)
    })
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
    if (!list.tracked)
      box.append(pausedNote(label))
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
      // page is without the mark.
      group.replaceWith(this.buildTrackButton(page))
    })
    return stop
  }

  /**
   * The page shares a root with `candidates` without being any of them: offer to
   * update one to this page's search, to go and refine one from its own page, or
   * to track this page as a list of its own. Several candidates are chosen
   * between by title.
   */
  private buildSameRootPill(page: TrackablePage, candidates: readonly TrackedList[], lists: readonly TrackedList[]): HTMLElement {
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
      summary.replaceChildren(...this.updateSummary(chosen, page, meta, lists, label))
      if (!chosen.tracked)
        summary.append(pausedNote(label))
      update.textContent = `Update “${label}”`
      update.title = `Change “${label}” to search what this page does. It keeps its place in your review.`
      refine.textContent = `Refine “${label}”`
      refine.title = `Open “${label}”'s own search in this tab, to change it from there.`
    }
    draw()

    chooser?.addEventListener('change', () => {
      chosen = sorted.find(one => one.id === chooser.value) ?? chosen
      draw()
    })
    update.addEventListener('click', () => void this.updateList(page, chosen, lists, update, { refining: false }))
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
    section = this.newListSection(page, lists, close)
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
   * and a warning when another list already searches exactly this.
   */
  private updateSummary(list: TrackedList, page: TrackablePage, meta: TrackedMeta, lists: readonly TrackedList[], label: string): Node[] {
    const filter = liveFilter()
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
    const twin = lists.find(one => one.id !== list.id && trackedKey(one) === pageKey)
    if (twin)
      nodes.push(<p class={TRACK_WARN_CLASS}>{`This search is already tracked as “${sourceLabel(twin, lists)}”, so “${label}” can't become it.`}</p>)
    return nodes
  }

  /**
   * Track this page as a new list, titled `typed` — or, left blank, by the page's
   * default. Refuses a title another list has, and says which. `button` shows
   * the work while it's done, and stays disabled once it has worked: the write
   * rebuilds the toolbar around it. `endsRefining` is the refining box's **Track
   * as a new list instead**, which is the end of refining the list it was for.
   */
  private async createList(page: TrackablePage, lists: readonly TrackedList[], typed: string, button: HTMLButtonElement, endsRefining = false): Promise<void> {
    if (button.disabled || !extensionAlive())
      return
    const text = button.textContent
    button.disabled = true
    try {
      const meta = await resolveMeta(page)
      const title = typed.trim() || uniqueTitle(defaultTitle(meta), lists)
      const taken = titleTakenBy(title, lists)
      if (taken) {
        toast(titleRefusal(taken), { type: 'error' })
      }
      else {
        // An uncommon tag costs one request here (see `needsScan`) — long enough
        // to be worth saying something about.
        if (page.normalized.kind === 'tag-works')
          button.textContent = 'Checking…'
        const scan = await needsScan(page)
        const entry = newEntry(page, title, lists, scan, meta)
        if (endsRefining)
          endRefining()
        await this.writeLists([...lists, entry])
        toast(
          `Tracking “${title}”. Works added or updated from today on will turn up in your review.${
            scan ? ' This tag is read from its own page, so an update to an older work may be missed.' : ''}`,
          { type: 'success' },
        )
        return
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
   * Replace `list`'s query with this page's ({@link planUpdate}), then offer to
   * take it back. `alias` is the title box's, where there is one; blank, it's the
   * page's default. `refining` ends the tab's refining mark: the list it was for
   * has become what the reader made of it.
   */
  private async updateList(page: TrackablePage, list: TrackedList, lists: readonly TrackedList[], button: HTMLButtonElement, opts: { alias?: string, refining: boolean }): Promise<void> {
    if (button.disabled || !extensionAlive())
      return
    const text = button.textContent
    const label = sourceLabel(list, lists)
    button.disabled = true
    try {
      const meta = await resolveMeta(page)
      const alias = opts.alias === undefined ? undefined : (opts.alias.trim() || uniqueTitle(defaultTitle(meta), lists, list.id))
      // Whether a tag's works can be read by date was checked for the tag the
      // list was made on. Another tag has to be checked again.
      let scan: boolean | undefined
      if (page.normalized.kind === 'tag-works' && trackedRoot(list) !== trackedRoot(page.normalized)) {
        button.textContent = 'Checking…'
        scan = await needsScan(page)
      }
      const plan = planUpdate(lists, list.id, { url: page.normalized.url, filter: liveFilter(), alias, meta, scan })
      if (plan.ok) {
        if (opts.refining)
          endRefining()
        await this.writeLists(plan.lists)
        offerUndo(plan.before, plan.after, opts.refining)
        return
      }
      toast(updateRefusal(plan, label), { type: 'error' })
    }
    catch (err) {
      this.logger.error('Could not update the tracked list.', err)
      toast('Could not update this list. Please try again.', { type: 'error' })
    }
    button.disabled = false
    button.textContent = text
  }

  /**
   * Fill in what the lists rooted where this page is don't say yet — a tag's
   * category, a series' title — from what the page itself says ({@link fillMeta}).
   * Nothing is fetched for it, and nothing is written when there's nothing to
   * fill, so the re-run a write causes finds nothing more to do.
   */
  private learnMeta(page: TrackablePage): void {
    const lists = this.options.trackedLists.lists
    let learned = false
    const next = lists.map((one) => {
      const filled = sameRoot(one, page.normalized) ? fillMeta(one, page.meta) : null
      if (!filled)
        return one
      learned = true
      return { ...one, ...filled }
    })
    if (learned)
      void this.writeLists(next)
  }

  /** Save the list table, leaving the rest of the option as it is. */
  private writeLists(lists: readonly TrackedList[]): Promise<void> {
    if (!extensionAlive())
      return Promise.resolve()
    return options.set({ trackedLists: { ...this.options.trackedLists, lists: [...lists] } })
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

/** How long an update can be taken back from its toast. */
const UNDO_TIMEOUT_MS = 20_000

/**
 * The view filter on screen, which a page is compared by and a list written
 * with, alongside its URL. None: what a custom search view is filtered to isn't
 * read back, so a page is its query alone, and an update stores no view filter.
 */
function liveFilter(): TrackedFilter | undefined {
  return undefined
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

/** A paused list stays paused through an update, and says what resuming it means. */
function pausedNote(label: string): HTMLElement {
  return <p class={TRACK_NOTE_CLASS}>{`“${label}” is paused, and updating it leaves it paused. Resuming it tracks from that day on.`}</p>
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

/**
 * The title an update offers: the list's own — unless it was the default for a
 * root the page has left, when the new root's default takes its place, so
 * "Search: coffee" refined into a search for tea isn't left calling itself
 * coffee.
 */
function titleAfterUpdate(list: TrackedList, page: TrackablePage, meta: TrackedMeta, lists: readonly TrackedList[]): string {
  const was = trackedMeta(list)
  const moved = trackedRoot(list) !== trackedRoot(page.normalized)
  return was && moved && sameTitle(list.alias, defaultTitle(was))
    ? uniqueTitle(defaultTitle(meta), lists, list.id)
    : list.alias
}

/** Whether two titles are one, the way titles are compared: trimmed, in any case. */
function sameTitle(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** Titles in the order a reader looks for them in. */
function compareTitles(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
}

/** Which list a refusal is about: its title, and what it is when the title doesn't say. */
function describeList(list: TrackedList): string {
  const title = sourceLabel(list)
  const meta = trackedMeta(list)
  return meta && !sameTitle(title, defaultTitle(meta)) ? `“${title}” (${defaultTitle(meta)})` : `“${title}”`
}

/** A title the reader typed that another list already has. */
function titleRefusal(other: TrackedList): string {
  return `Another list is already called ${describeList(other)}. Choose a different title.`
}

function updateRefusal(plan: Extract<TrackedUpdatePlan, { ok: false }>, label: string): string {
  switch (plan.reason) {
    case 'duplicate':
      return `This search is already tracked as ${describeList(plan.other)}, so “${label}” was left as it was.`
    case 'title':
      return titleRefusal(plan.other)
    case 'missing':
      return `“${label}” no longer exists — it was removed on the options page, or by a sync.`
    case 'invalid':
      return 'This page can’t be tracked.'
  }
}

function undoRefusal(plan: Extract<TrackedUndoPlan, { ok: false }>, label: string): string {
  switch (plan.reason) {
    case 'missing':
      return `“${label}” no longer exists, so the update can’t be undone.`
    case 'changed':
      return `“${label}” has changed again since, so the update can’t be undone.`
    case 'duplicate':
      return `${describeList(plan.other)} now searches what “${label}” used to, so the update can’t be undone.`
    case 'title':
      return `Another list is now called ${describeList(plan.other)}, so the update can’t be undone.`
  }
}

/**
 * The toast after an update, which can take it back for a while. It outlives the
 * rebuild the update's own write causes, so it works from storage, not from this
 * page's copy of the lists.
 */
function offerUndo(before: TrackedList, after: TrackedList, wasRefining: boolean): void {
  toast(`Updated “${sourceLabel(after)}”.${after.tracked ? '' : ' It stays paused.'}`, {
    type: 'success',
    timeout: UNDO_TIMEOUT_MS,
    action: { label: 'Undo', onClick: () => void undoUpdate(before, after, wasRefining) },
  })
}

async function undoUpdate(before: TrackedList, after: TrackedList, wasRefining: boolean): Promise<void> {
  if (!extensionAlive())
    return
  const label = sourceLabel(after)
  try {
    const option = await options.get('trackedLists')
    const plan = planUndo(option.lists, before, after)
    if (!plan.ok) {
      toast(undoRefusal(plan, label), { type: 'error' })
      return
    }
    // Back to where the reader was: refining the list, from the page as it is.
    if (wasRefining)
      startRefining(before.id, false)
    await options.set({ trackedLists: { ...option, lists: plan.lists } })
    toast(`Put “${sourceLabel(before)}” back as it was.`, { type: 'success' })
  }
  catch (err) {
    FilterToolbar.logger.error('Could not undo the update.', err)
    toast('Could not undo the update. Please try again.', { type: 'error' })
  }
}
