import Icon from '~icons/ao3e/icon.jsx'
import MdiBookOpenVariant from '~icons/mdi/book-open-variant.jsx'
import MdiCog from '~icons/mdi/cog.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiEye from '~icons/mdi/eye.jsx'
import MdiFindReplace from '~icons/mdi/find-replace.jsx'
import MdiGestureTapHold from '~icons/mdi/gesture-tap-hold.jsx'
import MdiPlaylistCheck from '~icons/mdi/playlist-check.jsx'
import MdiPlaylistPlay from '~icons/mdi/playlist-play.jsx'
import MdiPlaylistPlus from '~icons/mdi/playlist-plus.jsx'

import type { TrackedList } from '#common'
import type { TrackablePage } from '#content_script/tracked/createList.ts'

import { ADDON_CLASS, api, getArchiveLink, marksHideAnything, options, parseUser, sourceLabel, toast, trackedKey, utcToday } from '#common'
import { getMenusEnabled, setMenusEnabled } from '#content_script/contextTrigger.js'
import { extensionAlive } from '#content_script/extensionAlive.js'
import { NATIVE_HIDDEN_CLASS, VIEW_HIDDEN_CLASS } from '#content_script/searchView/classes.ts'
import { findWorkText } from '#content_script/textReplaceScope.ts'
import { needsScan, newEntry, trackablePage } from '#content_script/tracked/createList.ts'
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
 *   or to go and review. See {@link buildTrackButton}.
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
    // Whether this page is a query a review could read — a DOM question as well
    // as a URL one for an uncommon tag, so it can only be asked now.
    const trackable = this.options.trackedLists.enabled ? trackablePage() : null

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
    }
    if (peek)
      syncPeek = syncVisible
    syncVisible()

    let open = false
    const setOpen = (next: boolean): void => {
      open = next
      container.classList.toggle(OPEN_CLASS, open)
      fab.setAttribute('aria-expanded', String(open))
      const label = open ? 'Hide extension controls' : 'Show extension controls'
      fab.title = label
      fab.setAttribute('aria-label', label)
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
   * The tracking control, in whichever of its three states this page is in.
   *
   * It writes the `trackedLists` option and stops there. The write re-runs every
   * unit, which rebuilds this toolbar from the saved value — so what the pill
   * says next came out of storage, and a page that is already tracked can never
   * disagree with the options about it. (The reader-mode pill works the same way.)
   *
   * - **not tracked** — the pill grows a box with the name the list will carry,
   *   already filled in from the page. Naming it now is the point: a review's
   *   "List source" facet is a list of these names, and a query string makes a
   *   poor one.
   * - **tracked** — it says so, and offers the two things left to do with it.
   * - **paused** — one click starts it again. Tracking restarts from today, so
   *   the stretch the reader chose to skip isn't poured back in.
   */
  buildTrackButton(page: TrackablePage): HTMLElement {
    const lists = this.options.trackedLists.lists
    const entry = lists.find(one => trackedKey(one) === page.normalized.key)
    const group: HTMLElement = <div class={TRACK_CLASS} />

    const icon = entry
      ? (entry.tracked ? <MdiPlaylistCheck /> : <MdiPlaylistPlay />)
      : <MdiPlaylistPlus />
    const label = entry ? sourceLabel(entry, lists) : ''
    const text = entry
      ? (entry.tracked ? `Tracked as “${label}”` : `Resume tracking “${label}”`)
      : 'Track this search'
    const title = entry
      ? (entry.tracked
          ? 'This page is a tracked list. Its new and updated works turn up in your review.'
          : 'Tracking is paused for this page. Starting again picks up from today — nothing from the gap is filled in.')
      : 'Track this search, so works added or updated from now on turn up in one review stream.'

    const button: HTMLButtonElement = (
      <button type="button" class={BUTTON_CLASS} title={title} aria-label={title} aria-pressed="false">
        <span class={`${ADDON_CLASS}--filter-toolbar--icon`}>{icon}</span>
        <span class={`${TRACK_CLASS}--text`}>{text}</span>
      </button>
    ) as HTMLElement as HTMLButtonElement
    // Set rather than written into the JSX: a boolean there is rendered as a bare
    // attribute (`aria-pressed=""`), which is not one of the values it may take.
    button.setAttribute('aria-pressed', String(!!entry?.tracked))
    group.append(button)

    // Paused is the one state whose click needs nothing from the reader.
    if (entry && !entry.tracked) {
      button.addEventListener('click', () => {
        void this.writeLists(lists.map(one => (one.id === entry.id ? { ...one, tracked: true, since: utcToday() } : one)))
        toast(`Tracking “${label}” again, from today on.`, { type: 'success' })
      })
      return group
    }

    // The other two grow a box under the pill. Built up front and revealed on
    // click, so the reader's typing survives a re-render of nothing else.
    const box: HTMLElement = <div class={TRACK_BOX_CLASS} hidden />
    group.append(box)
    let open = false
    const setOpen = (next: boolean): void => {
      open = next
      box.hidden = !open
      button.setAttribute('aria-expanded', String(open))
    }
    setOpen(false)
    button.addEventListener('click', () => setOpen(!open))

    if (entry)
      this.fillTrackedBox(box, entry, lists, label)
    else
      this.fillNewListBox(box, page, lists, () => setOpen(false))
    return group
  }

  /** What a tracked list offers: stop, or go and look at the review. */
  private fillTrackedBox(box: HTMLElement, entry: TrackedList, lists: readonly TrackedList[], label: string): void {
    const stop: HTMLButtonElement = (
      <button type="button" class={`${BUTTON_CLASS}  ${TRACK_MINOR_CLASS}`} title="Stop tracking this page. The list is kept, so its name and its place come back if you resume.">
        Stop tracking
      </button>
    ) as HTMLElement as HTMLButtonElement
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

  /** The box that names a new list, and the one write that creates it. */
  private fillNewListBox(box: HTMLElement, page: TrackablePage, lists: readonly TrackedList[], close: () => void): void {
    // A relative date bound can't come along: it means a different span of days
    // every day it's read, and the review sets its own. Said here rather than
    // afterwards, because it changes what the reader is about to create.
    if (page.normalized.relativeDate) {
      box.append(
        <p class={TRACK_NOTE_CLASS}>
          {`The “${page.normalized.relativeDate}” date filter is left out — tracking follows your review's own dates instead.`}
        </p>,
      )
    }

    const input: HTMLInputElement = (
      <input type="text" class={TRACK_INPUT_CLASS} value={page.alias} aria-label="Name for this list" placeholder="Name for this list" />
    ) as HTMLElement as HTMLInputElement

    const track: HTMLButtonElement = (
      <button type="button" class={`${BUTTON_CLASS}  ${TRACK_MINOR_CLASS}`}>Track</button>
    ) as HTMLElement as HTMLButtonElement
    const cancel: HTMLButtonElement = (
      <button type="button" class={`${BUTTON_CLASS}  ${TRACK_MINOR_CLASS}`}>Cancel</button>
    ) as HTMLElement as HTMLButtonElement

    let saving = false
    const save = async (): Promise<void> => {
      if (saving || !extensionAlive())
        return
      saving = true
      track.disabled = true
      const alias = input.value.trim()
      try {
        // An uncommon tag costs one request here (see `needsScan`) — long enough
        // to be worth saying something about.
        if (page.normalized.kind === 'tag-works')
          track.textContent = 'Checking…'
        const scan = await needsScan(page)
        const entry = newEntry(page, alias, lists, scan)
        // The write re-runs every unit and rebuilds this toolbar, so nothing here
        // has to put the box back into its "tracked" state by hand.
        await this.writeLists([...lists, entry])
        toast(
          `Tracking “${alias || sourceLabel(entry, [...lists, entry])}”. Works added or updated from today on will turn up in your review.${
            scan ? ' This tag is read from its own page, so an update to an older work may be missed.' : ''}`,
          { type: 'success' },
        )
      }
      catch (err) {
        // The rebuild that would have replaced this box never came, so the box has
        // to be usable again.
        this.logger.error('Could not save the tracked list.', err)
        toast('Could not save this list. Please try again.', { type: 'error' })
        saving = false
        track.disabled = false
        track.textContent = 'Track'
      }
    }

    track.addEventListener('click', () => void save())
    cancel.addEventListener('click', close)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void save()
      }
      else if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    })

    const row: HTMLElement = <div class={TRACK_ROW_CLASS} />
    row.append(track, cancel)
    box.append(input, row)
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
