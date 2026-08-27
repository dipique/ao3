import MdiArrowCollapseVertical from '~icons/mdi/arrow-collapse-vertical.jsx'
import MdiBookOpenPageVariant from '~icons/mdi/book-open-page-variant.jsx'
import MdiCalendarClock from '~icons/mdi/calendar-clock.jsx'
import MdiClockCheck from '~icons/mdi/clock-check.jsx'
import MdiClockPlusOutline from '~icons/mdi/clock-plus-outline.jsx'
import MdiCloseCircleOutline from '~icons/mdi/close-circle-outline.jsx'
import MdiEyeCheck from '~icons/mdi/eye-check.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiFastForward from '~icons/mdi/fast-forward.jsx'
import MdiStar from '~icons/mdi/star.jsx'

import type { MarkId, WorkMarks, WorkProgress } from '#common'
import type { MenuItem } from '#content_script/contextMenu.js'

import { describeProgress, fetchAndParseDocument, fetchToken, getArchiveLink, localMarkIds, markGroup, markItems, markRoot, markTracksProgress, options, parseUser, progressFor, progressMarkIds, READ_MARK, readiness, readinessColor, ruleTargetColor, SAVED_MARK, toast, todayEpochDays } from '#common'
import { readChapterCounts } from '#content_script/blurb.js'
import { lastFloatingPoint } from '#content_script/contextMenu.js'
import {
  attachMenuTrigger,
  buildIndicators,
  clearMenuTriggers,
  type IndicatorState,
  markIndicatorState,
  standardLinkItems,
} from '#content_script/contextTrigger.js'
import { loadMarkedForLaterIndex, noteMarkedForLater } from '#content_script/markedForLaterIndex.js'
import { markIcon } from '#content_script/markIcons.js'
import { clearRule, entityKey, ruleBehavior, ruleIndicatorBehavior, toggleRuleBehavior } from '#content_script/persistentFilters.js'
import { openProgressEditor } from '#content_script/progressEditor.js'
import { Unit } from '#content_script/Unit.js'
import { applyMark, applyMarkGroup, applyMarkProgress } from '#content_script/workMarks.js'
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
const savedState = new Map<string, MarkState>()

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
    const state = savedState.get(id)
    // A toggle in flight, or one we already made, is fresher than the listing.
    if (state?.busy || state?.acted)
      continue
    // Anything read off this page (or fetched) beats a possibly-stale cache.
    if (opts.cached && state?.known && !state.cached)
      continue
    savedState.set(id, { saved: true, busy: false, known: true, acted: false, cached: !!opts.cached })
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
// Per-work marks (works only). Unlike mark-for-later these are ours, so the
// state is always known: each mark's packed id set is unpacked once per run into
// this cache, and the menu/indicators read it synchronously.
// ---------------------------------------------------------------------------

let markSets = new Map<MarkId, Set<string>>()

/** Re-read every local mark's id set from options at the start of a run. */
function loadMarkSets(marks: WorkMarks): void {
  markSets = new Map(localMarkIds(marks.marks).map(id => [id, markItems(marks.marks, id)]))
}

/**
 * Mirror one mark write in the cached sets, so indicators can update without
 * waiting for the options round-trip. Follows the same rule the stored table
 * does: a work carries at most one mark per trigger group.
 */
function noteMark(marks: WorkMarks, workId: string, markId: MarkId, on: boolean): void {
  if (!on) {
    markSets.get(markId)?.delete(workId)
    return
  }
  for (const other of markGroup(marks.marks, markId))
    markSets.get(other)?.delete(workId)
  markSets.get(markId)?.add(workId)
}

// ---------------------------------------------------------------------------
// Chapter counts, for the progress marks. Read from whatever this page states
// rather than kept anywhere: the count moves as the author posts, and the whole
// point of the ongoing mark is to notice when it has.
// ---------------------------------------------------------------------------

/**
 * Chapters published as far as this page says — from the blurb the anchor sits
 * in, else the work page's own stats. Null when neither is there, which every
 * caller reads as "don't guess".
 *
 * `closest` still resolves after HideWorks collapses a blurb, because its
 * wrapper goes *inside* the `<li>`. On a work page the anchor is the bare `<h2>`
 * title, nowhere near the stats, so the fallback is a `#main`-scoped descendant
 * selector — descendant, because `TotalStats.fixDl` rewraps `dl.stats`'s rows in
 * `<div>`s, and scoped, so a stats block fetched from elsewhere can't match.
 */
function publishedChapters(link: HTMLElement): number | null {
  const dd = link.closest('li.blurb')?.querySelector('dd.chapters')
    ?? document.querySelector('#main dl.stats dd.chapters')
  return readChapterCounts(dd)?.written ?? null
}

/**
 * The chapter open on a work page. Null anywhere else.
 *
 * Two different pages have to be told apart, because they number chapters
 * differently:
 *
 * - **Viewing the whole work** renders every chapter, and `div.chapter`'s
 *   `id="chapter-N"` counts them, so the highest is both the published count and
 *   the chapter you'd have read to.
 * - **Viewing one chapter** renders exactly one `div.chapter`, and it is always
 *   `id="chapter-1"` — the id numbers what is *on the page*, not what it is in
 *   the work. Reading chapter 7 alone would report chapter 1, quietly recording
 *   the wrong place every time. The chapter dropdown is the only thing on that
 *   page that names the work's own chapter number, in its option text
 *   ("7. Some Title"), so that is what we read.
 *
 * Only the server-rendered `selected` *attribute* counts, never the live
 * selection: changing the dropdown without submitting leaves you looking at the
 * chapter you were already on.
 */
function currentChapter(): number | null {
  const rendered = document.querySelectorAll('#chapters > div.chapter')

  // More than one chapter on the page means the whole work is being shown.
  if (rendered.length > 1) {
    let highest = 0
    for (const chapter of rendered) {
      const n = Number(chapter.id.replace(/\D/g, ''))
      if (Number.isFinite(n) && n > highest)
        highest = n
    }
    return highest > 0 ? highest : null
  }

  const option = document.querySelector<HTMLOptionElement>('#chapter_index option[selected]')
  const numbered = Number(option?.textContent?.match(/^\s*(\d+)\s*\./)?.[1])
  if (Number.isFinite(numbered) && numbered > 0)
    return numbered

  // A single-chapter work has no dropdown; one rendered chapter is chapter one.
  return rendered.length === 1 ? 1 : null
}

/** The work's title as this page shows it, for the editor's heading. */
function entityTitle(link: HTMLElement): string {
  return link.textContent?.trim().replace(/\s+/g, ' ') || 'this work'
}

// ---------------------------------------------------------------------------

abstract class FilterEntityToolbar extends Unit {
  /** `'work'` or `'series'` — used in labels, and the rule target for this kind. */
  protected abstract get noun(): 'work' | 'series'
  /** The path segment the entity's links use. */
  protected abstract get kind(): 'works' | 'series'
  /** Live registry of this kind's decorated links, shared across page runs. */
  protected abstract get entries(): EntityEntry[]
  /** Works fold in mark-for-later; series don't. */
  protected markEnabled(): boolean { return false }
  /** Works fold in the per-work marks; series don't. */
  protected marksEnabled(): boolean { return false }

  /** Highlight colour shown on the star indicator when a highlight has no colour of its own. */
  protected get defaultColor(): string { return ruleTargetColor(this.noun, this.options.rules.colors) }

  /**
   * Links to decorate: every `/works/:id` (or `/series/:id`) link, returning the
   * id and the link the menu/indicator hang off. Works use the blurb title;
   * series use each series link.
   */
  protected links(): { id: string, link: HTMLElement, clickToOpen?: boolean }[] {
    const idRe = new RegExp(`^/${this.kind}/(\\d+)(?:/|$)`)
    const out: { id: string, link: HTMLElement, clickToOpen?: boolean }[] = []
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

    for (const { id, link, clickToOpen } of this.links()) {
      const entry: EntityEntry = { link, id, indicator: null }
      this.entries.push(entry)
      attachMenuTrigger(link, () => this.buildMenu(id, link), { clickToOpen })
      this.syncIndicator(entry)
    }

    this.logger.debug(`Added ${this.noun} menus to ${this.entries.length} links.`)
  }

  async buildMenu(id: string, link: HTMLElement): Promise<MenuItem[]> {
    // Read the freshest rules so the checked state is current.
    const { filters } = await options.get('rules')
    const key = entityKey(this.noun, id)
    const behavior = ruleBehavior(filters, key)

    // The active behaviour is shown disabled (current state); "Clear" removes it.
    const items: MenuItem[] = [
      {
        icon: () => <MdiEyeOff />,
        label: `Hide ${this.noun}`,
        scope: 'settings',
        danger: true,
        active: behavior === 'hide',
        disabled: behavior === 'hide',
        onSelect: () => toggleRuleBehavior(key, 'hide'),
      },
      {
        icon: () => <MdiArrowCollapseVertical />,
        label: `Collapse ${this.noun}`,
        scope: 'settings',
        active: behavior === 'collapse',
        disabled: behavior === 'collapse',
        onSelect: () => toggleRuleBehavior(key, 'collapse'),
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
    ]
    if (behavior) {
      items.push({
        icon: () => <MdiCloseCircleOutline />,
        label: 'Clear',
        scope: 'settings',
        onSelect: () => clearRule(key),
      })
    }

    if (this.marksEnabled())
      items.push(...this.markSetItems(id, link))

    if (this.markEnabled())
      items.push(this.markItem(id))

    // The work-page title isn't a link, so the copy/open-link rows don't apply.
    if (link instanceof HTMLAnchorElement)
      items.push(...standardLinkItems(link))
    return items
  }

  /**
   * One row per mark that holds its own ids — read, favorite, and whatever finer
   * dispositions the mark table lists. All of it is local state we already hold,
   * so unlike the mark-for-later row these render their real label immediately.
   *
   * A mark that tracks progress is several rows rather than one toggle, since
   * setting it means saying *where* you got to — see {@link progressItems}.
   */
  private markSetItems(id: string, link: HTMLElement): MenuItem[] {
    const { marks } = this.options.workMarks
    const items: MenuItem[] = []
    localMarkIds(marks).forEach((markId, index) => {
      // The separator opens the mark block, so it belongs to whichever row comes
      // first — which is why this keys off the mark's index, not the row's.
      const separatorBefore = index === 0
      if (markTracksProgress(marks, markId)) {
        items.push(...this.progressItems(id, markId, link, separatorBefore))
        return
      }
      const config = marks[markId]!
      const has = markSets.get(markId)?.has(id) ?? false
      const noun = (config.label || markId).toLowerCase()
      items.push({
        icon: markIcon(config.icon),
        label: has ? `Unmark as ${noun}` : `Mark as ${noun}`,
        scope: 'settings',
        separatorBefore,
        active: has,
        onSelect: () => this.onToggleMark(id, markId, !has),
      })
    })
    return items
  }

  /**
   * The rows for a progress mark. Unmarked, there's one row and it opens the
   * editor — you can't record "ongoing" without recording a chapter. Marked,
   * there are the two ways to move the chapter on without a dialog, the editor
   * (for the date, or to type a chapter by hand), and the way back out.
   *
   * The chapter never advances on its own: visiting a work page is not evidence
   * you read it, and a mark that quietly moved would be a mark you couldn't
   * trust to tell you what's new.
   */
  private progressItems(id: string, markId: MarkId, link: HTMLElement, separatorBefore: boolean): MenuItem[] {
    const { marks } = this.options.workMarks
    const config = marks[markId]!
    const noun = (config.label || markId).toLowerCase()
    const openEditor = (): void => this.openProgressEditor(id, markId, link)

    const progress = progressFor(marks, markId, id)
    if (!progress) {
      return [{
        icon: markIcon(config.icon),
        label: `Mark as ${noun}…`,
        scope: 'settings',
        separatorBefore,
        onSelect: openEditor,
      }]
    }

    const rows: MenuItem[] = []
    const advance = (chapter: number, label: string, icon: () => Node): void => {
      rows.push({
        icon,
        label: `${label} (${chapter})`,
        scope: 'settings',
        // Re-recording the chapter it's already on would be a write that changed
        // nothing, so the row is shown (it says where you are) but inert.
        disabled: chapter === progress.chapter,
        onSelect: () => void this.saveProgress(id, markId, { ...progress, chapter }),
      })
    }

    const published = publishedChapters(link)
    if (published !== null)
      advance(published, 'Update to latest chapter', () => <MdiFastForward />)
    const current = currentChapter()
    if (current !== null)
      advance(current, 'Update to current chapter', () => <MdiBookOpenPageVariant />)

    rows.push({
      icon: () => <MdiCalendarClock />,
      label: 'Set wait-until date…',
      scope: 'settings',
      onSelect: openEditor,
    })
    rows.push({
      icon: markIcon(config.icon),
      label: `Unmark as ${noun}`,
      scope: 'settings',
      active: true,
      onSelect: () => this.onToggleMark(id, markId, false),
    })
    rows[0]!.separatorBefore = separatorBefore
    return rows
  }

  /**
   * Open the chapter/wait-until editor for one work. Positioned where the menu
   * was opened, since the menu closes before a row's `onSelect` runs and there's
   * no event of our own left to read a point off.
   */
  private openProgressEditor(id: string, markId: MarkId, link: HTMLElement): void {
    const { marks } = this.options.workMarks
    openProgressEditor({
      title: entityTitle(link),
      progress: progressFor(marks, markId, id),
      published: publishedChapters(link),
      current: currentChapter(),
      at: lastFloatingPoint(),
      onSave: entry => void this.saveProgress(id, markId, entry),
    })
  }

  /**
   * Record where the reader got to, then make sure the work is on Marked for
   * Later. In that order deliberately: the option write is dispatched unawaited
   * and survives a frame teardown, while anything after a network call may not
   * run at all.
   */
  private async saveProgress(id: string, markId: MarkId, entry: WorkProgress): Promise<void> {
    const marks = this.options.workMarks
    noteMark(marks, id, markId, true)
    applyMarkProgress(marks, id, markId, entry)
    this.syncEntriesFor(id)

    const noun = (marks.marks[markId]?.label || markId).toLowerCase()
    toast(`Marked as ${noun} — last finished chapter ${entry.chapter}.`, { type: 'success' })

    // An ongoing work is the one disposition that isn't "done with it", so it
    // belongs on the to-read list rather than off it.
    await this.ensureSaved(id)
  }

  /**
   * Make sure a work is on the Marked for Later list, adding it if it isn't.
   *
   * Deliberately not {@link onMark}: that one *toggles*, and on a work page it
   * presses AO3's own button — which navigates, firing CaptureMarkButtons on the
   * way out, which would clear the very mark that asked for this.
   *
   * The state is checked before adding rather than assumed: marking an
   * already-saved work for later moves it to the top of the list, silently
   * reordering a list the reader may be working through.
   */
  private async ensureSaved(id: string): Promise<void> {
    if (!this.markEnabled())
      return
    const state = savedState.get(id) ?? { saved: false, busy: false, known: false, acted: false, cached: false }
    if (state.busy || (state.known && state.saved))
      return
    if (await this.checkMarked(id) === true)
      return

    state.busy = true
    savedState.set(id, state)
    try {
      await submitMark(id, true)
      state.saved = true
      state.known = true
      state.cached = false
      // ...and must not be overwritten by a re-seed from the now-stale page.
      state.acted = true
      noteMarkedForLater(id, true)
      toast('Added to your Marked for Later list.', { type: 'success' })
    }
    catch (err) {
      // The mark itself is already written, so this is a partial failure, not a
      // lost action — say so without implying nothing happened.
      this.logger.error(`Failed to add work ${id} to Marked for Later.`, err)
      toast('Marked, but could not add this work to your Marked for Later list.', { type: 'error' })
    }
    finally {
      state.busy = false
      savedState.set(id, state)
      this.syncEntriesFor(id)
    }
  }

  /**
   * Toggle one mark on a work. Every mark in the read group means "I'm done with
   * this", so when we already know the work is on the Marked for Later list it
   * comes off it too — that's the loop this feature exists to break. The list is
   * only touched when its state is known first-hand (seeded or acted on this
   * session); an unknown state is left alone rather than paying for a page fetch.
   */
  private async onToggleMark(id: string, markId: MarkId, on: boolean): Promise<void> {
    const noun = (this.options.workMarks.marks[markId]?.label || markId).toLowerCase()
    this.setMarkLocally(id, markId, on)

    const state = savedState.get(id)
    const { marks } = this.options.workMarks
    // A progress mark sits in the read group without meaning what the group
    // means — an ongoing work is precisely one you're *not* done with — so it
    // must not take the work off the list the way its neighbours do.
    const done = on && markRoot(marks, markId) === READ_MARK && !markTracksProgress(marks, markId)
    if (done && this.markEnabled() && state?.saved && !state.busy) {
      // onMark toasts the "removed from your Marked for Later list" message.
      await this.onMark(id)
      return
    }
    toast(on ? `Marked as ${noun}.` : `Unmarked as ${noun}.`, { type: 'success' })
  }

  /**
   * Apply one specific mark and show it immediately. Goes through
   * {@link applyMark} — one of the two writers of marks — so an explicit choice
   * behaves the same wherever it's made.
   *
   * The indicator is updated optimistically rather than waiting for the options
   * round-trip (whose change event re-runs every unit and rebuilds it anyway).
   */
  protected setMarkLocally(id: string, markId: MarkId, on: boolean): void {
    noteMark(this.options.workMarks, id, markId, on)
    applyMark(this.options.workMarks, id, markId, on)
    this.syncEntriesFor(id)
  }

  /**
   * Apply the read *disposition* rather than one specific mark — what AO3's own
   * buttons mean. A work already marked with something finer keeps that mark
   * (see {@link applyMarkGroup}).
   *
   * The two progress-mark exemptions {@link setMarkGroup} makes have to be made
   * here too, or the in-memory cache and storage disagree: an ongoing work would
   * be promoted to `read` in the stored table but not in `markSets`, and the
   * indicator would go on showing the old mark until the next full re-run.
   */
  protected setReadLocally(id: string, read: boolean): void {
    const marks = this.options.workMarks
    const carried = markGroup(marks.marks, READ_MARK).filter(markId => markSets.get(markId)?.has(id))
    const blocking = carried.filter(markId => !markTracksProgress(marks.marks, markId))
    if (read) {
      // noteMark(on) clears the whole group first, so the ongoing mark comes off
      // here exactly as it does in storage — it just didn't get a vote.
      if (blocking.length === 0)
        noteMark(marks, id, READ_MARK, true)
    }
    else {
      for (const markId of blocking)
        noteMark(marks, id, markId, false)
    }
    applyMarkGroup(marks, id, read)
    this.syncEntriesFor(id)
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
    const state = savedState.get(id)
    if (state?.known && !state.cached)
      return this.markAction(id, state.saved, state.busy)

    const resolve = async (): Promise<MenuItem> => {
      const saved = await this.checkMarked(id)
      const busy = savedState.get(id)?.busy ?? false
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
    const state = savedState.get(id) ?? { saved: false, busy: false, known: false, acted: false, cached: false }
    // A toggle in flight, or one we already made, is the freshest intent.
    if (state.busy || state.acted)
      return state.saved
    state.saved = saved
    state.known = true
    // Straight from the archive, so it supersedes anything the index said — and
    // the index itself, which may have been what we just disagreed with.
    state.cached = false
    noteMarkedForLater(id, saved)
    savedState.set(id, state)
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
    const behavior = ruleIndicatorBehavior(ruleBehavior(this.options.rules.filters, entityKey(this.noun, id)))
    if (behavior)
      states.push(behavior)
    // A work carrying a progress mark is kept on Marked for Later deliberately
    // (see `ensureSaved`), so the clock would be on every one of them saying
    // something the calendar already implies. Drop it and let the mark speak.
    const ongoing = this.marksEnabled()
      && progressMarkIds(this.options.workMarks.marks).some(markId => markSets.get(markId)?.has(id))
    if (this.markEnabled() && !ongoing && savedState.get(id)?.saved)
      states.push(markIndicatorState(SAVED_MARK))
    if (this.marksEnabled()) {
      for (const [markId, ids] of markSets) {
        if (ids.has(id))
          states.push(markIndicatorState(markId))
      }
    }
    return states
  }

  /**
   * What the marks with per-work state have to say about *this* work: hover text
   * and indicator colour, both derived from the same readiness. Only the
   * progress marks have any — every other indicator means one thing everywhere.
   *
   * Both are left out (so the mark's own label and colour stand) whenever the
   * chapter count can't be found: half a hint is worse than none, and
   * `entry.link` may be detached, since the module-scoped registry is shared
   * with the search view, which resets it.
   */
  private markOverrides(entry: EntityEntry): {
    titles?: Record<MarkId, string>
    colors?: Record<MarkId, string>
  } {
    if (!this.marksEnabled())
      return {}
    const { marks } = this.options.workMarks
    const today = todayEpochDays()
    let titles: Record<MarkId, string> | undefined
    let colors: Record<MarkId, string> | undefined
    for (const markId of progressMarkIds(marks)) {
      const progress = progressFor(marks, markId, entry.id)
      if (!progress)
        continue
      const published = publishedChapters(entry.link)
      if (published === null)
        continue
      const label = marks[markId]?.label || markId
      titles ??= {}
      titles[markId] = `${label}\n${describeProgress(progress, published, today)}`
      const color = readinessColor(readiness(progress, published, today), marks[markId]?.color)
      if (color) {
        colors ??= {}
        colors[markId] = color
      }
    }
    return { titles, colors }
  }

  protected syncIndicator(entry: EntityEntry): void {
    const next = buildIndicators(this.computeStates(entry.id), {
      highlightColor: this.defaultColor,
      marks: this.options.workMarks.marks,
      ...this.markOverrides(entry),
    })
    if (next)
      attachMenuTrigger(next, () => this.buildMenu(entry.id, entry.link), { indicator: true, link: entry.link })

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
    const state = savedState.get(id) ?? { saved: false, busy: false, known: false, acted: false, cached: false }
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
    savedState.set(id, state)
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
      savedState.set(id, state)
      // Reflect the saved-clock on every blurb showing this work.
      this.syncEntriesFor(id)
    }
  }
}

const workEntries: EntityEntry[] = []
const seriesEntries: EntityEntry[] = []

/**
 * The work id for the page we are on, or null when this isn't a work page.
 *
 * Usually the URL says it. But AO3 also serves a chapter at its own permalink —
 * `/chapters/:id`, carrying no work id and *not* redirecting to the `/works/`
 * form — and there the URL knows nothing, so the id has to come out of the
 * markup. Without this the work menu simply never appeared on those pages, while
 * the author menu (which reads its own link) went on working, so the page looked
 * half-decorated rather than broken.
 *
 * Every fallback below sits in a container that only exists on a work page, so a
 * listing can't match one by accident, and each points at *this* work rather
 * than one it merely links to (a series, or an "inspired by" work).
 */
function workPageId(): string | null {
  const fromUrl = location.pathname.match(/^\/works\/(\d+)(?:\/|$)/)?.[1]
  if (fromUrl)
    return fromUrl

  const selectors = [
    // The chapter's own permalink, on its heading.
    '#chapters .chapter h3.title a[href*="/works/"]',
    // The chapter-index jump form.
    '#chapter_index form[action*="/works/"]',
    // The work navigation's Entire Work / Share / Comments rows.
    'ul.work.navigation a[href*="/works/"]',
  ]
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      const raw = el.getAttribute('href') ?? el.getAttribute('action')
      if (!raw)
        continue
      let path: string
      try {
        path = new URL(raw, location.origin).pathname
      }
      catch {
        continue
      }
      const id = path.match(/^\/works\/(\d+)(?:\/|$)/)?.[1]
      if (id)
        return id
    }
  }
  return null
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

  // The work menu appears wherever its actions are useful: when rules are on
  // (hide/highlight/always-show), mark-for-later is on, or per-work marks are on.
  override get enabled() {
    return this.options.rules.enabled || this.options.markForLaterToolbar || this.options.workMarks.enabled
  }

  protected override get noun() { return 'work' as const }
  protected override get kind() { return 'works' as const }
  protected override get entries() { return workEntries }

  protected override markEnabled(): boolean {
    // Marking needs a logged-in session, and only when the feature is enabled.
    return this.options.markForLaterToolbar && document.body.classList.contains('logged-in')
  }

  // The per-work marks are ours alone — no AO3 session needed.
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
    // The work page's own title opens on a plain click as well as the usual
    // right-click/long-press. Unlike a blurb's title it isn't a link, so there
    // is no navigation to suppress and nothing else a click could have meant.
    if (title && id)
      found.push({ id, link: title, clickToOpen: true })
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
    const state = id ? savedState.get(id) : undefined
    if (!id || state?.busy || state?.acted)
      return
    const saved = parseMarkedForLater(document)
    if (saved !== null) {
      savedState.set(id, { saved, busy: false, known: true, acted: false, cached: false })
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
  override get enabled() { return this.options.rules.enabled }
  protected override get noun() { return 'series' as const }
  protected override get kind() { return 'series' as const }
  protected override get entries() { return seriesEntries }

  static override async clean(): Promise<void> {
    seriesEntries.length = 0
    clearMenuTriggers()
  }
}
