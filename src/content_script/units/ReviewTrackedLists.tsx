import MdiCheck from '~icons/mdi/check.jsx'
import MdiChevronLeft from '~icons/mdi/chevron-left.jsx'
import MdiChevronRight from '~icons/mdi/chevron-right.jsx'
import MdiLoading from '~icons/mdi/loading.jsx'

import type { Day, Options, SnapshotDescriptor, TrackedList, TrackedReviewCache } from '#common'
import type { Work } from '#content_script/blurb.js'
import type { LoadOptions, LoadResult, SearchHeaderControl, SearchSource } from '#content_script/searchView/host.tsx'
import type { DeferredUpdate, ViewState } from '#content_script/searchView/view.tsx'
import type { CappedDay, FetchedWindow } from '#content_script/tracked/fetchWindow.ts'

import {
  ADDON_CLASS,
  cache,
  formatDay,
  fromShortId,
  getArchiveLink,
  markIds,
  markItems,
  options,
  packIds,
  parseUser,
  readWorkIds,
  reviewStart,
  sourceLabel,
  toast,
  toShortId,
  unpackIds,
  utcToday,
} from '#common'
import { extensionAlive } from '#content_script/extensionAlive.js'
import { loadMarkedForLaterIndex, markedForLaterIds } from '#content_script/markedForLaterIndex.js'
import { clearHistoryItem, hideClearHistory, showClearHistory } from '#content_script/readingsNav.ts'
import { pruneBlurbs } from '#content_script/searchView/blurbStore.ts'
import { snapshotWorkIds, writeSnapshot } from '#content_script/searchView/cache.ts'
import { NATIVE_HIDDEN_CLASS } from '#content_script/searchView/classes.ts'
import { isSearchViewOpen, openSearchView, suspendSearchView, takeReopen } from '#content_script/searchView/host.tsx'
import { applyStatus } from '#content_script/searchView/status.ts'
import { createTrackedSession, fetchWindow } from '#content_script/tracked/fetchWindow.ts'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const FEATURE = `${ADDON_CLASS}--tracked-review`
const BUTTON_CLASS = `${FEATURE}--button`
/** The heading and subnav items that stand in for AO3's own while the view is up. */
const CHROME_CLASS = `${FEATURE}--chrome`
const BAR_CLASS = `${FEATURE}--bar`

/** What the page calls this list, in its heading and in the subnav. */
const LIST_NAME = 'Tracked'

/** Identifies this use of the search view — one id for the feature, as everywhere else. */
const SOURCE_ID = 'tracked-review'

/**
 * The stored window's key. One list, not one per reader: a review is gathered
 * from the reader's own options against their own session, and the readings page
 * it opens on has already refused anyone else's.
 */
const CACHE_KEY = 'tracked-review'

/** The address that opens the review straight away — what the toolbar's pill links to. */
const HASH = '#ao3e-tracked'

/**
 * How long Undo stays on offer after a range is marked reviewed. Longer than an
 * ordinary toast, because the reader can only tell whether they meant it once
 * the next window has drawn itself, which is a request or two away.
 */
const UNDO_TIMEOUT_MS = 20_000

// ---------------------------------------------------------------------------
// What one page run remembers.
//
// All of it outlives a global re-run — which happens on every options change, so
// on every mark click — and none of it outlives the page. That is exactly the
// lifetime a review has: the reader's place in it, the pages already fetched,
// and the set of works that counted as reviewed when they started.
// ---------------------------------------------------------------------------

/** The window the store holds, as this page run last read or wrote it. */
let facts: TrackedReviewCache | null = null
/** Whether {@link facts} still answers to the reader's options. */
let factsStale = true
/** Works the reader has already dealt with, taken once per fresh open. */
let reviewed: ReviewedSet | null = null
/** Pages already read for this window's start, so a ± day costs nothing. */
let session = createTrackedSession()
/** The reader's ± day. This visit only: the next one sizes to the target again. */
let endOverride: Day | undefined
/** The window before the one in {@link facts} — what the view still holds if a reload is waiting. */
let carried: string[] = []
/** Short ids the view is holding when they aren't the stored window's. */
let heldIds: Set<string> | null = null
/** How the last gather changed the window, for the "Range updated" offer. */
let lastDiff = { added: 0, removed: 0 }
/** What only a gather knows, so a window drawn from the cache simply leaves it out. */
let extras: { backlog: number, capped: CappedDay[], nextDayCount: number } | null = null
/** Set by Mark reviewed, read by the reopen its option write causes. */
let advanced = false
/**
 * Redraw the toolbar this open built, if it has built one.
 *
 * The toolbar reads {@link facts}, so a load that moves the window has to tell
 * it — but only when those works are going on screen. A background reload is
 * offered rather than applied, and until the reader takes it the toolbar is
 * still describing the works they are looking at.
 */
let redrawBar: (() => void) | null = null
/** The window the last load settled on, when it held no works at all. */
let emptyWindow: QuietWindow | null = null

interface QuietWindow {
  start: Day
  end: Day
  reviewable: boolean
}

/** The last load's empty window, once. */
function takeEmptyWindow(): QuietWindow | null {
  const quiet = emptyWindow
  emptyWindow = null
  return quiet
}

/** Work ids the reader has already dealt with, and whether the saved-work half is real. */
interface ReviewedSet {
  ids: Set<string>
  /**
   * Whether the Marked for Later index has ever been filled on this browser. It
   * is a local cache of the last visit to that page, so on a browser that has
   * never opened it only the read half of "already dealt with" applies — and the
   * toolbar says so rather than quietly showing more.
   */
  savedKnown: boolean
}

/**
 * The review of everything the reader's tracked lists have turned up: one
 * in-memory stream of works, a range of days at a time, with a toolbar that
 * moves the range and marks it reviewed.
 *
 * **What a review is.** Every tracked list is a saved query. Read oldest-first
 * over a span of days and merged by work, they make a stream — and the reader
 * goes through it a *window* of whole days at a time, as many days as fit the
 * works-per-review target. Nothing is ever marked reviewed one work at a time:
 * the only review state is one day number, so finishing a window is one click
 * and there is no per-item bookkeeping to keep in step, to sync, or to lose.
 * Reading the window out of the archive is
 * {@link file://../tracked/fetchWindow.ts}; deciding what a window *is* is
 * {@link file://../../common/trackedLists.ts}. This unit is the page.
 *
 * **What it stands on.** The window is shown in the same search view the reader
 * already knows from Marked for Later and the read list — through the source
 * hooks the host offers for exactly this: {@link SearchSource.load} for works
 * that aren't one listing read page by page, {@link SearchSource.header} for the
 * toolbar, and the view's frozen page layout for a list the reader is walking
 * through in order.
 *
 * **Why the pages are frozen.** A review is read in order, page by page, and
 * every mark the reader makes re-runs the page and rebuilds the view. Without a
 * frozen layout the hide pass and the facet filters would run again over a
 * shorter list, and every work after the one they just marked would slide back a
 * slot — the last work of page 2 onto page 1, which they have already been
 * through, never to be seen. So the view holds its layout, a work that would now
 * drop out is collapsed in its slot, and the only thing that ever re-lays the
 * pages is the reader's own filter, sort or range.
 *
 * **Why marking a work doesn't remove it.** Works the reader has already dealt
 * with — marked read, or saved for later — never enter the stream at all. That
 * set is taken *once* per fresh open and reused by the reopens a mark click
 * causes, so marking a work during a review leaves it where it is until the
 * window next loads. Marking is taking notes on the box, not emptying it, and
 * the work falls inside the reviewed range either way.
 */
export class ReviewTrackedLists extends Unit {
  static override get name() { return 'ReviewTrackedLists' }

  // Nothing to review with no list tracked, and nothing the entry point could
  // honestly offer.
  override get enabled() {
    const tracked = this.options.trackedLists
    return tracked.enabled && tracked.lists.some(list => list.tracked)
  }

  static override async clean(): Promise<void> {
    // A global re-run (options change, navigation) tears the view down. If it was
    // open, snapshot it so ready() can reopen it where the reader left off.
    suspendSearchView()
    showClearHistory()
  }

  override async ready(): Promise<void> {
    // Only your own readings pages, and only when signed in: the review reads
    // the archive with the reader's session, and the already-reviewed half of it
    // is their own marks.
    const pageUser = readingsUser()
    if (!pageUser || !document.body.classList.contains('logged-in'))
      return
    const currentUser = parseUser(document)?.userId
    if (!currentUser || currentUser.toLowerCase() !== pageUser.toLowerCase())
      return

    if (!onHistoryPage())
      hideClearHistory()

    const host = anchorItem()
    // Nowhere to put the entry point, but a reopen is still owed — the review may
    // be on screen with the subnav hidden behind it.
    if (host && !host.parentElement?.querySelector(`.${BUTTON_CLASS}`))
      this.addEntryPoint(host, pageUser)

    // A global re-run closed an open view: put it back where the reader left
    // off. After a Mark reviewed the window has moved on, so the reader's
    // filters come across but the works don't — they are read from the store,
    // where the new window has just been written.
    const pending = takeReopen(CACHE_KEY)
    if (pending) {
      const moved = advanced
      advanced = false
      void this.openView(pageUser, { initialState: pending, refresh: false, reuseWorks: !moved })
      return
    }
    // Linkable, and safe to reload onto.
    if (location.hash === HASH)
      void this.openView(pageUser)
  }

  /** The **Tracked** subnav item, after the read list's own. */
  private addEntryPoint(host: HTMLElement, pageUser: string): void {
    const button = (
      <button type="button" class={`${ADDON_CLASS}  ${BUTTON_CLASS}`}>{LIST_NAME}</button>
    ) as HTMLElement as HTMLButtonElement
    button.addEventListener('click', () => {
      void this.openView(pageUser)
    })
    host.after(<li class={ADDON_CLASS}>{button}</li>)
  }

  /**
   * Open the review. `opts` is the host's, plus the two things a reopen needs.
   *
   * The already-reviewed set is taken here when there isn't one yet, because the
   * stored window is filtered through it before a single blurb is drawn.
   */
  async openView(userId: string, opts: { initialState?: ViewState, refresh?: boolean, reuseWorks?: boolean } = {}): Promise<void> {
    emptyWindow = null
    await this.readFacts()
    reviewed ??= await takeReviewed(userId, this.options)
    await openSearchView(this.source(userId), this.options, opts)
    // A window holding no works at all closes the view: the host has nothing to
    // put on screen, and no toolbar goes up with it. A quiet range is still a
    // range the reader can clear, so the offer it would have carried is made
    // here instead.
    const quiet = takeEmptyWindow()
    if (!isSearchViewOpen() && quiet)
      this.offerEmptyRange(userId, quiet.start, quiet.end, quiet.reviewable)
  }

  /** Everything the shared host needs to know about a review window. */
  source(userId: string): SearchSource {
    const history = onHistoryPage()
    // Where the list lives, for the options page's stored-list row. A review is
    // gathered from several queries at once, so there is no listing behind it —
    // which is also why `load` replaces the whole scrape.
    const home = getArchiveLink(`/users/${encodeURIComponent(userId)}/readings${HASH}`)
    return {
      id: SOURCE_ID,
      cacheKey: CACHE_KEY,
      descriptor: () => descriptorFor(userId),
      // Required of every source, and meaningless for one that loads its own
      // works: nothing here is ever asked for a page.
      pageUrl: () => home,
      pageCount: () => 1,
      load: opts => this.load(userId, opts),
      header: ctl => this.header(ctl, userId),
      belongs: work => belongsToWindow(work),
      // Opened over the to-read page, there is nothing native to go back to —
      // that page is itself a search view. Over History, "Back to list" means
      // History.
      replacesListing: !history,
      // These are listings the archive chose, not a list the reader built work
      // by work, so their rules apply exactly as they would on the pages the
      // works came from.
      hidesNothing: false,
      // A past day's works barely change, so a window is worth keeping between
      // visits — but only while it still answers to the reader's options. A
      // window computed against a watermark or a list set that has moved is no
      // longer about anything, and is read again at once.
      refreshInterval: () => (factsStale ? 0 : Math.max(0, this.options.searchProfileListsRefreshHours || 0) * 60 * 60_000),
      nativeElements: () => [
        ...document.querySelectorAll('#main ol.reading.work.index.group, #main ol.pagination'),
        ...listChrome(),
      ],
      mount: (container) => {
        const anchor = document.querySelector('#main ul.navigation.actions')
          ?? document.querySelector('#main ol.reading.work.index.group')
        anchor?.after(container)
        showReviewChrome(userId)
      },
      unmount: () => {
        for (const el of document.querySelectorAll(`.${CHROME_CLASS}`))
          el.remove()
      },
      prepare: works => this.stamp(works),
      viewConfig: {
        // "marked" is the order the window was gathered in: oldest day first,
        // and within a day the order the lists themselves listed the works in.
        sortLabels: { marked: 'Review order' },
        // Opening on "Ready" would hide most of a review behind a facet the
        // reader never set.
        defaultStatus: [],
        // See the class comment: a review is walked in order, and a mark click
        // must not move anything.
        stablePages: true,
      },
      emptyMessage: 'Nothing new from your tracked lists.',
      errorMessage: 'Could not gather your tracked lists.',
    }
  }

  /** Read the review window out of the archive, and write down what it is. */
  private async load(userId: string, opts: LoadOptions): Promise<LoadResult> {
    const option = this.options.trackedLists
    const lists = option.lists.filter(list => list.tracked)
    const start = reviewStart(option)
    const today = utcToday()
    // A load is a fresh look at the window, so the already-reviewed set is taken
    // again here — and only here. The reopens a mark click causes reuse it, which
    // is what keeps a work the reader just marked from vanishing from under them.
    reviewed = await takeReviewed(userId, this.options)

    const result = await fetchWindow({
      lists,
      start,
      today,
      target: option.target,
      endOverride,
      reviewed: reviewed.ids,
      options: this.options,
      signal: opts.signal,
      onProgress: opts.onProgress,
      session,
    })

    // The same condition the host writes the snapshot under: a refusal that
    // brought nothing back is not news about what the lists hold, and the stored
    // window stays exactly as it was.
    if (!result.blocked || result.works.length)
      await this.commit(result, userId, { reviewedThrough: option.reviewedThrough, lists: option.lists })
    // These works are going straight on screen (a first load, or the reader's
    // own Refresh), so the toolbar has to describe the window they came from.
    // A reload that is only being offered leaves it alone — see {@link redrawBar}.
    if (opts.applied)
      redrawBar?.()
    emptyWindow = result.works.length ? null : result.window
    return { works: result.works, blocked: result.blocked }
  }

  /**
   * Read the stored window, and say whether it still means anything.
   *
   * A window computed against a watermark or a set of lists the reader has moved
   * on from is about nothing at all — so it isn't merely refreshed behind them,
   * it stops belonging (see {@link belongsToWindow}), which leaves the host with
   * no stored copy to draw and sends it to gather a new one.
   */
  private async readFacts(): Promise<void> {
    const option = this.options.trackedLists
    try {
      facts = await cache.get('trackedReview')
    }
    catch (err) {
      this.logger.error('Could not read the stored review window', err)
      facts = null
    }
    const watermark = Number.isSafeInteger(option.reviewedThrough) ? option.reviewedThrough : 0
    factsStale = !facts
      || facts.computedAt === 0
      || facts.reviewedThrough !== watermark
      || facts.listsSig !== listsSig(option.lists)
    if (factsStale) {
      // Nothing carried over from a window that no longer describes anything.
      extras = null
      heldIds = null
    }
  }

  /**
   * Write a freshly gathered window down: its works as the stored list, its
   * facts as the cache entry, and the works the window before it held — and this
   * one doesn't — retired.
   *
   * The order matters. The list goes down **first**, so that by the time the
   * blurbs of the outgoing window are weighed as orphans the incoming window is
   * already holding its own. (The host writes the same list again the moment
   * `load` returns; a list already in the store costs nothing to write twice.)
   */
  private async commit(result: FetchedWindow, userId: string, against: { reviewedThrough: Day, lists: readonly TrackedList[] }): Promise<void> {
    const previous = facts
    const sources: { [sid: string]: string } = {}
    for (const [sid, ids] of result.sources)
      sources[sid] = ids.join(',')
    const days: { [day: string]: number } = {}
    for (const [day, count] of result.days)
      days[String(day)] = count

    await writeSnapshot(CACHE_KEY, result.works, descriptorFor(userId))

    const retired = await this.retire(previous, sources, this.options)

    const next: TrackedReviewCache = {
      start: result.window.start,
      end: result.window.end,
      computedAt: Date.now(),
      reviewedThrough: against.reviewedThrough,
      listsSig: listsSig(against.lists),
      sources,
      days,
      failed: result.failed,
      retired: packIds(retired),
    }
    carried = previous ? Object.keys(previous.sources) : []
    lastDiff = countDiff(previous?.sources ?? {}, sources)
    extras = { backlog: result.backlog, capped: result.capped, nextDayCount: result.window.nextDayCount }
    facts = next
    factsStale = false
    heldIds = null
    await cache.set({ trackedReview: next })
  }

  /**
   * Discard the blurbs the outgoing window leaves behind, and hand back the ids
   * that have to wait.
   *
   * A reviewed window is disposable by construction — forty-odd blurbs the
   * reader has been through, that no list will name again — and a reader who
   * clears one a day would otherwise pile up a hundred megabytes of them in a
   * year, unnoticed, because there is no quota to bump into. So this runs
   * whatever the reader's orphan setting says, which governs the lists they
   * chose to keep rather than a window that exists to be thrown away.
   *
   * Three kinds of work are kept even so: one another stored list still holds
   * (the store's own rule), one carrying a mark, and one saved for later. The
   * read list rebuilds a work from a stored blurb rather than fetching its page,
   * so a work marked during a review is exactly the one worth keeping.
   */
  private async retire(previous: TrackedReviewCache | null, incoming: { [sid: string]: string }, opts: Options): Promise<Set<string>> {
    const waiting = unpackIds(previous?.retired ?? '')
    for (const sid of Object.keys(previous?.sources ?? {})) {
      if (sid in incoming)
        continue
      const id = fromShortId(sid)
      if (id)
        waiting.add(id)
    }
    if (!waiting.size)
      return waiting

    const spared = keptWorkIds(opts)
    for (const id of [...waiting]) {
      if (spared.has(id))
        waiting.delete(id)
    }
    if (!waiting.size)
      return waiting

    try {
      // Everything every stored list holds, the window just written included —
      // which is why this runs after the write and not before it.
      const referenced = await snapshotWorkIds()
      const plan = await pruneBlurbs([...waiting], referenced)
      for (const id of plan.ids)
        waiting.delete(id)
    }
    catch (err) {
      // Nothing was lost: the ids stay in `retired` and the next window tries
      // again.
      this.logger.error('Could not discard the blurbs a reviewed window left behind', err)
    }
    return waiting
  }

  /** Stamp the works with their statuses and their List source facet values. */
  private stamp(works: Work[]): void {
    applyStatus(works, this.options)
    const lists = this.options.trackedLists.lists
    const labels = new Map(lists.map(list => [list.id, sourceLabel(list, lists)]))
    const sources = facts?.sources ?? {}
    for (const work of works) {
      const sid = toShortId(work.workId)
      const ids = sid === null ? undefined : sources[sid]
      // Read from the *current* aliases, so renaming a list relabels the facet
      // on the next re-run rather than at the next gather.
      work.sources = ids ? ids.split(',').map(id => labels.get(id)).filter((label): label is string => !!label) : []
    }
  }

  // -------------------------------------------------------------------------
  // The toolbar.
  // -------------------------------------------------------------------------

  /**
   * The strip above the view: what range is being reviewed, how to move its end,
   * and the one button that finishes it.
   *
   * Built once per open and kept across the renders inside it, so its own
   * spinner, its confirmations and the "range updated" offer survive a
   * background reload. The host's progress panel is only up for the first load,
   * which is why a ± day fetch reports here instead.
   */
  private header(ctl: SearchHeaderControl, userId: string): HTMLElement {
    const range = (<span class={`${BAR_CLASS}--range`} />) as HTMLElement
    const meta = (<span class={`${BAR_CLASS}--meta`} />) as HTMLElement
    const spinner = (<span class={`${BAR_CLASS}--spinner`}><MdiLoading /></span>) as HTMLElement
    const back = (
      <button type="button" class={`${BAR_CLASS}--step`} title="Take a day off the end of the range">
        <MdiChevronLeft />
        <span>day</span>
      </button>
    ) as HTMLElement as HTMLButtonElement
    const forward = (
      <button type="button" class={`${BAR_CLASS}--step`} title="Add a day to the end of the range">
        <span>day</span>
        <MdiChevronRight />
      </button>
    ) as HTMLElement as HTMLButtonElement
    const strip = (<span class={`${BAR_CLASS}--strip`} />) as HTMLElement
    const hint = (<span class={`${BAR_CLASS}--hint`} />) as HTMLElement
    const mark = (
      <button type="button" class={`${BAR_CLASS}--mark`}>
        <MdiCheck />
        <span>Mark reviewed</span>
      </button>
    ) as HTMLElement as HTMLButtonElement
    const notes = (<div class={`${BAR_CLASS}--notes`} />) as HTMLElement
    const warnings = (<div class={`${BAR_CLASS}--warnings`} />) as HTMLElement
    const prompt = (<div class={`${BAR_CLASS}--prompt`} />) as HTMLElement
    const controls = (
      <div class={`${BAR_CLASS}--controls`}>
        {back}
        {forward}
        {strip}
        {hint}
        {mark}
      </div>
    ) as HTMLElement
    const el = (
      <div class={`${ADDON_CLASS}  ${BAR_CLASS}`}>
        <div class={`${BAR_CLASS}--headline`}>
          {range}
          {meta}
          {spinner}
        </div>
        {controls}
        {notes}
        {warnings}
        {prompt}
      </div>
    ) as HTMLElement

    let busy = false
    /** A reload the view would not spring on the reader, waiting to be offered. */
    let deferred: DeferredUpdate | null = null

    const redraw = (): void => {
      const option = this.options.trackedLists
      const today = utcToday()
      const current = facts
      if (!current || current.computedAt === 0) {
        range.textContent = 'Gathering your tracked lists…'
        meta.textContent = ''
        controls.classList.add(`${BAR_CLASS}--off`)
        return
      }
      const caughtUp = current.start > today - 1
      const span = current.end - current.start + 1
      const count = Object.values(current.days).reduce((sum, n) => sum + n, 0)

      range.textContent = caughtUp ? 'You’re caught up.' : `Reviewing ${formatRange(current.start, current.end)}`
      meta.textContent = caughtUp
        ? 'Today’s works so far are below; they can be reviewed tomorrow.'
        : `${span} ${span === 1 ? 'day' : 'days'} · ${count} ${count === 1 ? 'work' : 'works'} (target ${option.target})`

      controls.classList.toggle(`${BAR_CLASS}--off`, caughtUp)
      setDisabled(back, busy || current.end <= current.start)
      setDisabled(forward, busy || current.end >= today - 1)
      drawStrip(strip, current)
      hint.textContent = extras && extras.nextDayCount > 0 && current.end < today - 1
        ? `+1 day adds at least ${extras.nextDayCount}`
        : ''

      const failed = failedLabels(current.failed, option.lists)
      setDisabled(mark, busy || current.end >= today)
      mark.title = current.end >= today
        ? 'Today isn’t over yet, so it can’t be marked reviewed.'
        : failed.length
          ? 'One of your lists couldn’t be loaded — you’ll be asked before its works are skipped.'
          : `Mark ${formatRange(current.start, current.end)} reviewed and move on to the next range.`

      notes.textContent = noteLine(option.lists, extras?.backlog)
      warnings.replaceChildren(...warningLines(failed, extras?.capped, reviewed, option.lists))
      if (!deferred)
        prompt.replaceChildren()
    }

    const setBusy = (on: boolean): void => {
      busy = on
      el.classList.toggle(`${BAR_CLASS}--busy`, on)
      redraw()
    }

    const gather = async (override: Day | undefined): Promise<void> => {
      const option = this.options.trackedLists
      const start = reviewStart(option)
      setBusy(true)
      try {
        const result = await fetchWindow({
          lists: option.lists.filter(list => list.tracked),
          start,
          today: utcToday(),
          target: option.target,
          endOverride: override,
          reviewed: (reviewed ??= await takeReviewed(userId, this.options)).ids,
          options: this.options,
          session,
        })
        endOverride = override
        await this.commit(result, userId, { reviewedThrough: option.reviewedThrough, lists: option.lists })
        deferred = null
        ctl.show(result.works)
      }
      catch (err) {
        this.logger.error('Could not change the review range', err)
        toast('Could not change the range. Please try again.', { type: 'error' })
      }
      finally {
        setBusy(false)
      }
    }

    const step = (delta: number): void => {
      const current = facts
      if (busy || !current)
        return
      const wanted = Math.min(Math.max(current.end + delta, current.start), utcToday() - 1)
      if (wanted === current.end)
        return
      void gather(wanted)
    }
    back.addEventListener('click', () => step(-1))
    forward.addEventListener('click', () => step(1))

    mark.addEventListener('click', () => {
      const current = facts
      if (busy || !current)
        return
      const failed = failedLabels(current.failed, this.options.trackedLists.lists)
      const capped = extras?.capped ?? []
      if (!failed.length && !capped.length) {
        void this.markReviewed(userId, current, setBusy)
        return
      }
      // Skipping a list's works silently is the one way a review can lose a
      // work, so it always asks.
      prompt.replaceChildren(confirmRow(
        skipWarning(failed, capped, current),
        'Mark reviewed anyway',
        () => {
          prompt.replaceChildren()
          void this.markReviewed(userId, current, setBusy)
        },
        () => prompt.replaceChildren(),
      ))
    })

    // Without this the view swaps a background reload straight in, which would
    // take the reader back to page 1 of a list they are part-way through. With
    // it, the reload waits here until they say so.
    ctl.onUpdateDeferred((update) => {
      deferred = update
      // The view is still holding the works it had; the store has moved on.
      heldIds = new Set(carried)
      const added = lastDiff.added ? `+${lastDiff.added}` : ''
      const removed = lastDiff.removed ? `−${lastDiff.removed}` : ''
      const change = [added, removed].filter(Boolean).join(' ')
      prompt.replaceChildren(confirmRow(
        change ? `Range updated (${change}).` : 'Range updated.',
        'Show',
        () => {
          deferred = null
          heldIds = null
          prompt.replaceChildren()
          update.apply()
          redraw()
        },
        null,
      ))
    })

    // This open's toolbar is the one a load writes to. Set last, so a half-built
    // strip is never the one asked to redraw itself.
    redrawBar = redraw
    redraw()
    return el
  }

  /**
   * Finish the range: move the watermark, read the next window, and only then
   * write the option — whose broadcast re-runs the page and reopens the view on
   * what has just been stored.
   *
   * The watermark is read fresh and never lowered, so a tab that has been
   * sitting open can't rewind another tab's progress. The session can't survive
   * the window's start moving (every list's query starts a day before it), so
   * the next window is read from nothing.
   */
  private async markReviewed(userId: string, range: TrackedReviewCache, setBusy: (on: boolean) => void): Promise<void> {
    if (!extensionAlive())
      return
    setBusy(true)
    try {
      const option = await options.get('trackedLists')
      const current = Number.isSafeInteger(option.reviewedThrough) ? option.reviewedThrough : 0
      const next = Math.max(current, range.end)
      const lists = option.lists.filter(list => list.tracked)
      const start = reviewStart({ reviewedThrough: next, lists: option.lists })

      reviewed = await takeReviewed(userId, this.options)
      session = createTrackedSession()
      endOverride = undefined
      const result = await fetchWindow({
        lists,
        start,
        today: utcToday(),
        target: option.target,
        reviewed: reviewed.ids,
        options: this.options,
        session,
      })
      await this.commit(result, userId, { reviewedThrough: next, lists: option.lists })

      // Last, and the thing that makes it so: the write re-runs every unit, and
      // the reopen it causes reads the window written just above.
      advanced = true
      await options.set({ trackedLists: { ...option, reviewedThrough: next } })
      toast(`Marked ${formatRange(range.start, range.end)} reviewed.`, {
        type: 'success',
        timeout: UNDO_TIMEOUT_MS,
        action: { label: 'Undo', onClick: () => void undoReviewed(current, next) },
      })
    }
    catch (err) {
      advanced = false
      this.logger.error('Could not mark the range reviewed', err)
      toast('Could not mark this range reviewed. Please try again.', { type: 'error' })
    }
    finally {
      setBusy(false)
    }
  }

  /**
   * A range that turned up nothing, offered as a toast: the view closed with it,
   * because a window of no works is nothing for the host to draw.
   */
  private offerEmptyRange(userId: string, start: Day, end: Day, reviewable: boolean): void {
    // A range that can't be marked reviewed has nothing to offer, and the host
    // has already said there was nothing there.
    if (!reviewable)
      return
    const where = formatRange(start, end)
    toast(`Nothing from your tracked lists for ${where}.`, {
      timeout: 0,
      action: {
        label: 'Mark reviewed',
        onClick: () => {
          const gathered = facts
          if (gathered)
            void this.markReviewed(userId, gathered, () => {})
        },
      },
    })
  }
}

/**
 * Everything that counts as reviewed already: the works the reader has marked
 * read (the `read` mark and every verdict aliasing it) and the works on their
 * Marked for Later list.
 *
 * Both are the reader having dealt with a work — one says they finished it, the
 * other that they chose it — so neither belongs in a stream of things they have
 * yet to look at.
 */
async function takeReviewed(userId: string, opts: Options): Promise<ReviewedSet> {
  const ids = new Set(readWorkIds(opts.workMarks))
  let savedKnown = false
  try {
    const entry = await cache.get('markedForLater')
    savedKnown = entry.updatedAt > 0 && entry.userId === userId.toLowerCase()
    for (const id of await loadMarkedForLaterIndex(userId))
      ids.add(id)
  }
  catch {
    // An unreadable index means the saved half is simply unknown, which is the
    // harmless direction to be wrong in: a work that should have been skipped
    // turns up in the review.
  }
  return { ids, savedKnown }
}

/** Every work id any mark holds — the works a retired blurb is kept for. */
function keptWorkIds(opts: Options): Set<string> {
  const kept = new Set<string>()
  const marks = opts.workMarks.marks
  for (const id of markIds(marks)) {
    for (const workId of markItems(marks, id))
      kept.add(workId)
  }
  // The saved-work index as it stands, not as it stood when the review opened:
  // a work the reader saved for later *during* the review is exactly the one
  // whose blurb is worth the bytes. Null when nothing has read the index on this
  // browser, which is not the same as nothing being saved.
  for (const id of markedForLaterIds() ?? [])
    kept.add(id)
  return kept
}

/**
 * Whether a work still belongs in the review.
 *
 * Two questions, and the second is the interesting one. A work outside the
 * stored window is a leftover from a window that has moved on, and can't be
 * shown. A work the reader has dealt with since the window was gathered — marked
 * read on another page, saved from a menu — goes too, which is how a cached
 * window stays honest without being fetched again.
 *
 * The exception is a reload the view declined to swap in: the store has moved on
 * while the reader is still part-way through the window before it, so what they
 * are holding is allowed to stay until they ask for the new one.
 */
function belongsToWindow(work: Work): boolean {
  if (factsStale || !facts)
    return false
  const sid = toShortId(work.workId)
  if (sid === null)
    return false
  if (!(sid in facts.sources) && !heldIds?.has(sid))
    return false
  return !reviewed?.ids.has(work.workId)
}

/**
 * What a stored window was computed against: every tracked list's identity,
 * address, tracking date and reading mode. The alias is deliberately not in it —
 * renaming a list relabels its facet on the next re-run and is no reason to read
 * the archive again.
 */
function listsSig(lists: readonly TrackedList[]): string {
  // Serialized rather than joined on a separator: a URL can hold very nearly
  // any character, and two lists must never be able to spell one signature
  // between them.
  return JSON.stringify(lists
    .filter(list => list.tracked)
    .map(list => [list.id, list.kind, list.url, list.since, list.scan ? 1 : 0]))
}

/** How many works the new window gained and lost against the old one. */
function countDiff(previous: { [sid: string]: string }, next: { [sid: string]: string }): { added: number, removed: number } {
  let added = 0
  let removed = 0
  for (const sid of Object.keys(next)) {
    if (!(sid in previous))
      added++
  }
  for (const sid of Object.keys(previous)) {
    if (!(sid in next))
      removed++
  }
  return { added, removed }
}

/** Put the watermark back, if nothing has moved it since. */
async function undoReviewed(previous: Day, expected: Day): Promise<void> {
  if (!extensionAlive())
    return
  try {
    const option = await options.get('trackedLists')
    if (option.reviewedThrough !== expected) {
      toast('Your review has moved on since, so this can’t be undone.', { type: 'error' })
      return
    }
    session = createTrackedSession()
    endOverride = undefined
    await options.set({ trackedLists: { ...option, reviewedThrough: previous } })
    toast('Put the range back.', { type: 'success' })
  }
  catch {
    toast('Could not undo that. Please try again.', { type: 'error' })
  }
}

/**
 * Where the options page's stored-list row points. A review is gathered from
 * several queries at once, so there is no listing address to give it — the page
 * the review itself opens on is the honest answer.
 */
function descriptorFor(userId: string): SnapshotDescriptor {
  return {
    sourceId: SOURCE_ID,
    label: 'Tracked review',
    listUrl: getArchiveLink(`/users/${encodeURIComponent(userId)}/readings${HASH}`),
  }
}

/** Set a button's disabled state and say so to assistive technology. */
function setDisabled(button: HTMLButtonElement, off: boolean): void {
  button.disabled = off
  // Set rather than written into the JSX: a boolean attribute there renders as
  // a bare one, which is not a value `aria-disabled` may take.
  button.setAttribute('aria-disabled', String(off))
}

/** `12 Sep – 19 Sep 2026`, with the year said once when both ends share it. */
function formatRange(start: Day, end: Day): string {
  const from = formatDay(start)
  const to = formatDay(end)
  if (from === to)
    return from
  const sameYear = from.slice(-4) === to.slice(-4)
  return `${sameYear ? from.slice(0, -5) : from} – ${to}`
}

/** One bar per day of the window, tallest for the busiest, with the count on hover. */
function drawStrip(strip: HTMLElement, window: TrackedReviewCache): void {
  const days: [Day, number][] = []
  for (let day = window.start; day <= window.end; day++)
    days.push([day, window.days[String(day)] ?? 0])
  const peak = Math.max(1, ...days.map(([, count]) => count))
  strip.replaceChildren(...days.map(([day, count]) => {
    const label = `${formatDay(day)} — ${count} ${count === 1 ? 'work' : 'works'}`
    const bar = (<span class={`${BAR_CLASS}--day`} title={label} aria-label={label} role="img" />) as HTMLElement
    // A day with nothing in it still gets a sliver, so the run of quiet days a
    // range can hold is visible as a run rather than as a gap.
    bar.style.height = `${Math.max(8, Math.round((count / peak) * 100))}%`
    return bar
  }))
}

/** `5 lists · 1 paused · about 412 more to review`. */
function noteLine(lists: readonly TrackedList[], backlog: number | undefined): string {
  const tracked = lists.filter(list => list.tracked).length
  const paused = lists.length - tracked
  const parts = [`${tracked} ${tracked === 1 ? 'list' : 'lists'}`]
  if (paused)
    parts.push(`${paused} paused`)
  if (backlog && backlog > 0)
    parts.push(`about ${backlog.toLocaleString()} more to review`)
  return parts.join(' · ')
}

/** The names of the lists a window couldn't be read from. */
function failedLabels(failed: readonly string[], lists: readonly TrackedList[]): string[] {
  return failed.map((id) => {
    const entry = lists.find(list => list.id === id)
    return entry ? sourceLabel(entry, lists) : id
  })
}

/** The lines under the toolbar that say what this window is missing or cut short. */
function warningLines(failed: readonly string[], capped: readonly CappedDay[] | undefined, set: ReviewedSet | null, lists: readonly TrackedList[]): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const label of failed)
    out.push(warning(`“${label}” couldn’t be loaded, so its works are missing from this range.`))
  for (const day of capped ?? []) {
    const who = failedLabels(day.lists, lists)
    out.push(warning(
      `${formatDay(day.day)} holds ${day.count.toLocaleString()} works — only the first ${day.shown.toLocaleString()} were loaded${
        who.length ? ` (${who.join(', ')})` : ''}.`,
    ))
  }
  if (set && !set.savedKnown)
    out.push(warning('Marked for Later not loaded on this browser. Open it once to skip saved works.'))
  return out
}

function warning(text: string): HTMLElement {
  return (<div class={`${BAR_CLASS}--warning`}>{text}</div>) as HTMLElement
}

/** What the reader is agreeing to when they mark a range that isn't whole. */
function skipWarning(failed: readonly string[], capped: readonly CappedDay[], window: TrackedReviewCache): string {
  const where = formatRange(window.start, window.end)
  const parts: string[] = []
  if (failed.length)
    parts.push(`${failed.map(label => `“${label}”`).join(', ')} couldn’t be loaded; ${failed.length === 1 ? 'its' : 'their'} works for ${where} will be skipped.`)
  for (const day of capped)
    parts.push(`${formatDay(day.day)} holds more works than could be loaded; the rest will be skipped.`)
  return parts.join(' ')
}

/** A line of explanation with one or two buttons under it. */
function confirmRow(text: string, label: string, onConfirm: () => void, onCancel: (() => void) | null): HTMLElement {
  const confirm = (<button type="button" class={`${BAR_CLASS}--confirm`}>{label}</button>) as HTMLElement as HTMLButtonElement
  confirm.addEventListener('click', onConfirm)
  const row = (
    <div class={`${BAR_CLASS}--prompt-row`}>
      <span>{text}</span>
      {confirm}
    </div>
  ) as HTMLElement
  if (onCancel) {
    const cancel = (<button type="button" class={`${BAR_CLASS}--confirm`}>Cancel</button>) as HTMLElement as HTMLButtonElement
    cancel.addEventListener('click', onCancel)
    row.append(cancel)
  }
  return row
}

// ---------------------------------------------------------------------------
// The page it opens on.
// ---------------------------------------------------------------------------

/**
 * Both halves of `/users/:user/readings`: `?show=to-read` is the Marked for
 * Later list, anything else is History.
 */
function readingsUser(): string | null {
  return location.pathname.match(/^\/users\/([^/]+)\/readings\/?$/)?.[1] ?? null
}

/** Whether the page being shown is the History listing rather than the to-read one. */
function onHistoryPage(): boolean {
  return new URLSearchParams(location.search).get('show') !== 'to-read'
}

/**
 * The subnav item our button goes after: whatever of ours already sits behind
 * the Marked for Later one, which is the read list's button.
 */
function anchorItem(): HTMLElement | null {
  const item = Array.from(document.querySelectorAll('#main ul.navigation.actions > li'))
    .find(li => li.textContent?.trim() === 'Marked for Later')
  if (!item)
    return null
  let last: Element = item
  while (last.nextElementSibling?.classList.contains(ADDON_CLASS))
    last = last.nextElementSibling
  return last as HTMLElement
}

/**
 * The furniture that names the list on screen — the page heading, the subnav
 * item AO3 marks as current, our own button, and History's "clear everything".
 * Hidden while the view is up, because none of it is true any more: the reader
 * is looking at the review, whichever page they opened it from.
 */
function listChrome(): Element[] {
  const nav = document.querySelector('#main ul.navigation.actions')
  return [
    document.querySelector('#main > h2.heading'),
    nav?.querySelector(`:scope > li:not(.${ADDON_CLASS}) > span.current`)?.parentElement,
    nav?.querySelector(`.${BUTTON_CLASS}`)?.closest('li'),
    clearHistoryItem(),
  ].filter((el): el is HTMLElement => !!el)
}

/**
 * Stand in for {@link listChrome} while the view is up, the way AO3 draws its
 * own lists: a heading naming the review, its subnav item as the current one in
 * place of our button, and the item that *was* current turned back into a link.
 */
function showReviewChrome(userId: string): void {
  const hidden = `.${NATIVE_HIDDEN_CLASS}`
  const heading = document.querySelector(`#main > h2.heading${hidden}`)
  heading?.after(<h2 class={`heading ${ADDON_CLASS}  ${CHROME_CLASS}`}>{LIST_NAME}</h2>)

  const nav = document.querySelector('#main ul.navigation.actions')
  const current = nav?.querySelector(`:scope > li${hidden} > span.current`)
  if (current) {
    const path = `/users/${encodeURIComponent(userId)}/readings`
    const href = onHistoryPage() ? path : `${path}?show=to-read`
    current.parentElement!.after(
      <li class={`${ADDON_CLASS}  ${CHROME_CLASS}`}><a href={href}>{current.textContent?.trim() ?? ''}</a></li>,
    )
  }
  nav?.querySelector(`.${BUTTON_CLASS}`)?.closest('li')?.after(
    <li class={`${ADDON_CLASS}  ${CHROME_CLASS}`}><span class="current">{LIST_NAME}</span></li>,
  )
}
