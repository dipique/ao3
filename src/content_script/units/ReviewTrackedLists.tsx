import MdiCheck from '~icons/mdi/check.jsx'
import MdiChevronLeft from '~icons/mdi/chevron-left.jsx'
import MdiChevronRight from '~icons/mdi/chevron-right.jsx'
import MdiLoading from '~icons/mdi/loading.jsx'

import type { Day, Options, SnapshotDescriptor, TrackedList, TrackedListsOption, TrackedRead, TrackedReviewCache } from '#common'
import type { Work } from '#content_script/blurb.js'
import type { LoadResult, SearchHeaderControl, SearchSource } from '#content_script/searchView/host.tsx'
import type { ViewState } from '#content_script/searchView/view.tsx'
import type { ReadStatus } from '#content_script/tracked/readLists.ts'
import type { ReviewWindow } from '#content_script/tracked/reviewWindow.ts'

import {
  ADDON_CLASS,
  builtinOpens,
  cache,
  CLAIM_TTL_MS,
  formatDay,
  formatRange,
  fromShortId,
  getArchiveLink,
  markIds,
  markItems,
  options,
  packIds,
  parseUser,
  pruneReviewed,
  readWorkIds,
  recordFor,
  recordsBehind,
  reviewBasis,
  reviewStart,
  reviewStatus,
  sameReviewBasis,
  sourceLabel,
  storedRecordOf,
  toast,
  toShortId,
  unpackIds,
  utcToday,
} from '#common'
import { PATIENCE, WAIT_BUDGET, watchWaitLine } from '#content_script/archiveFetch.js'
import { extensionAlive } from '#content_script/extensionAlive.js'
import { linkedTo, openLinked } from '#content_script/lists/openLink.ts'
import { loadMarkedForLaterIndex, markedForLaterIds } from '#content_script/markedForLaterIndex.js'
import { PAGE_RUN } from '#content_script/pageRun.ts'
import { clearHistoryItem, hideClearHistory, showClearHistory } from '#content_script/readingsNav.ts'
import { pruneBlurbs } from '#content_script/searchView/blurbStore.ts'
import { snapshotWorkIds } from '#content_script/searchView/cache.ts'
import { NATIVE_HIDDEN_CLASS } from '#content_script/searchView/classes.ts'
import { closeSearchView, isSearchViewOpen, openSearchView, resumeSearchView, suspendSearchView, undecorated } from '#content_script/searchView/host.tsx'
import { applyStatus } from '#content_script/searchView/status.ts'
import { claimReads } from '#content_script/tracked/readClaim.ts'
import { readTrackedLists } from '#content_script/tracked/readLists.ts'
import { onReadRecordsChanged, readStoredRecords, writeReadRecords } from '#content_script/tracked/readStore.ts'
import { computeWindow } from '#content_script/tracked/reviewWindow.ts'
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
 * The stored window's key. One list, not one per reader: a review is computed
 * from the reader's own options and records, and the readings page it opens on
 * has already refused anyone else's.
 */
const CACHE_KEY = 'tracked-review'

/**
 * The review's own link, which opens it straight away — what the toolbar's
 * pill links to. Another spelling of its open URL.
 */
const HASH = '#ao3e-tracked'

/**
 * How long Undo stays on offer after a range is marked reviewed. Longer than an
 * ordinary toast, because the reader can only tell whether they meant it once
 * the next window has drawn itself.
 */
const UNDO_TIMEOUT_MS = 20_000

/** What a work that left the window says in the slot it keeps. */
const GONE_REASON = 'Moved to a later review'

/** Said when a window turns out to hold nothing, and nothing is left to read. */
const EMPTY_MESSAGE = 'Nothing new from your tracked lists.'

// ---------------------------------------------------------------------------
// What one page run remembers.
//
// All of it outlives a global re-run — which happens on every options change, so
// on every mark click — and none of it outlives the page. That is exactly the
// lifetime a review has: the reader's place in it, the works already parsed,
// and the set of works that counted as reviewed when they started.
// ---------------------------------------------------------------------------

/** The window the store holds, as this page run last read or wrote it. */
let facts: TrackedReviewCache | null = null
/** Whether {@link facts} still answers to the reader's options. */
let factsStale = true
/** Works the reader has already dealt with, taken once per fresh open. */
let reviewed: ReviewedSet | null = null
/** The reader's ± day. This visit only: the next one sizes to the target again. */
let endOverride: Day | undefined
/**
 * The window's end once it was up to date, for the start it was computed
 * from: held for the visit, so a list read later can't take days off a window
 * the reader has been told is whole.
 */
let heldEnd: { start: Day, end: Day } | null = null
/** Short ids of works on screen that left the window, drawn as gone in their slots. */
let goneHeld = new Set<string>()
/** Every work parsed this page run, by archive work id: one object per work. */
const parsed = new Map<string, Work>()
/** The window last computed, for the toolbar. */
let current: ReviewWindow | null = null
/**
 * Set by Mark reviewed, read by the reopen its option write causes: the works
 * that view held are the range just finished, so the reader's filters come
 * across but the works and their page layout don't.
 */
let advanced = false
/** Redraw the toolbar this open built, if it has built one. */
let redrawBar: (() => void) | null = null
/** The view this open drew, as its toolbar reaches it. */
let control: SearchHeaderControl | null = null
/** The window the last load computed, when it held no works at all. */
let emptyWindow: QuietWindow | null = null
/** The reading this page is doing, if any. */
let reading: { controller: AbortController, status: ReadStatus | null } | null = null
/** Another page holds the read claim: this one follows the records it writes. */
let readingElsewhere = false
/** Retries the claim once another page's could have lapsed. */
let claimRetry: ReturnType<typeof setTimeout> | undefined
/** Stops hearing record writes: one listener per page run. */
let stopFollowing: (() => void) | null = null
/** Stops the last toolbar's countdown of a pause in reading. */
let stopWaitLine: (() => void) | null = null
/** A recompute under way, and whether another was asked for while it ran. */
let recomputing: Promise<void> | null = null
let recomputeAgain = false
/** The next recompute puts its window on screen whole, for the reader's ± day, rather than merging it. */
let showNext = false
/** The last reading here stopped because AO3 kept refusing. */
let readingStopped = false
/**
 * The unit of the latest run. Every options change builds new units, so work
 * an older one queued — a recompute, a claim to try again, the next reading —
 * is done by this one, under the options as they are now.
 */
const run: { latest: ReviewTrackedLists | null } = { latest: null }
/** Works the records let go of when a range was marked reviewed, for the next write to retire. */
const retireLater = new Set<string>()

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
 * and merged by work, they make a stream — and the reader goes through it a
 * window* of whole days at a time, as many days as fit the works-per-review
 * target. Nothing is ever marked reviewed one work at a time: the only review
 * state is one day number, so finishing a window is one click and there is no
 * per-item bookkeeping to keep in step, to sync, or to lose.
 *
 * **Where the works come from.** Each list keeps a read record — the works its
 * query turned up, by day ({@link file://../../common/trackedReads.ts}) — and
 * the window is computed from those without asking the archive
 * ({@link file://../tracked/reviewWindow.ts}), so it draws at once. A reader
 * ({@link file://../tracked/readLists.ts}) brings the records up to date in the
 * background, one page at a time, in whichever page holds the read claim; every
 * page with the review open hears the records land and merges the works they
 * bring in place, without moving anything on a page the reader has passed.
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
  // honestly offer. Its open URL opens it whatever *Tracked lists* says
  // ({@link file://./../lists/openLink.ts}).
  override get enabled() {
    return (this.options.trackedLists.enabled || linkedTo('review')) && builtinOpens('review', this.options)
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

    run.latest = this
    if (!onHistoryPage())
      hideClearHistory()

    const host = anchorItem()
    // Nowhere to put the entry point, but a reopen is still owed — the review may
    // be on screen with the subnav hidden behind it.
    if (this.options.trackedLists.enabled && host && !host.parentElement?.querySelector(`.${BUTTON_CLASS}`))
      this.addEntryPoint(host, pageUser)

    // A global re-run took the view down: put it back where the reader left
    // off. After a Mark reviewed the window has moved on, so the reader's
    // filters come across but the works don't.
    const resumed = resumeSearchView(CACHE_KEY, (opts) => {
      const moved = advanced
      advanced = false
      return this.openView(pageUser, { ...opts, reuseWorks: !moved })
    })
    if (!resumed)
      void openLinked('review', CACHE_KEY, opts => this.openView(pageUser, opts))
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
    // A window holding no works at all, with nothing left to read, closes the
    // view: the host has nothing to put on screen. A quiet range is still a
    // range the reader can clear, so the offer it would have carried is made
    // here instead.
    const quiet = takeEmptyWindow()
    if (!isSearchViewOpen() && quiet)
      this.offerEmptyRange(quiet)
  }

  /** Everything the shared host needs to know about a review window. */
  source(userId: string): SearchSource {
    const history = onHistoryPage()
    // Where the list lives: the page the review opens on, which This review's
    // Start Review on the options page falls back on. A review is computed
    // from several queries at once, so there is no listing behind it — which
    // is also why `load` replaces the whole scrape.
    const home = getArchiveLink(`/users/${encodeURIComponent(userId)}/readings${HASH}`)
    return {
      id: SOURCE_ID,
      cacheKey: CACHE_KEY,
      descriptor: () => descriptorFor(userId),
      // Required of every source, and meaningless for one that loads its own
      // works: nothing here is ever asked for a page.
      pageUrl: () => home,
      pageCount: () => 1,
      load: () => this.load(userId),
      header: ctl => this.header(ctl),
      belongs: work => belongsToWindow(work),
      // The records are read in the background, and land in the view as they
      // do; the Refresh button only starts that reading again if it stopped.
      reread: () => this.reread(),
      // Kept open while lists are still being read, which is what will fill it.
      keepsEmpty: () => !!current?.window.pending.length,
      // Opened over the to-read page, there is nothing native to go back to —
      // that page is itself a search view. Over History, "Back to list" means
      // History.
      replacesListing: !history,
      // These are listings the archive chose, not a list the reader built work
      // by work, so their rules apply exactly as they would on the pages the
      // works came from.
      hidesNothing: false,
      // A stored window is drawn as it is while it answers to the reader's
      // options, and the records' own reading brings it up to date; one that
      // doesn't answer to them is computed again at once.
      refreshInterval: () => (factsStale ? 0 : Number.POSITIVE_INFINITY),
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
        // "marked" is the order the window was computed in: oldest day first,
        // and within a day the order the lists themselves listed the works in.
        sortLabels: { marked: 'Review order' },
        // Opening on "Ready" would hide most of a review behind a facet the
        // reader never set.
        defaultStatus: [],
        // See the class comment: a review is walked in order, and a mark click
        // must not move anything.
        stablePages: true,
        goneReason: GONE_REASON,
      },
      emptyMessage: EMPTY_MESSAGE,
      errorMessage: 'Could not gather your tracked lists.',
    }
  }

  /** Compute the window from the records, and write down what it is. */
  private async load(userId: string): Promise<LoadResult> {
    // A load is a fresh look at the window, so the already-reviewed set is taken
    // again here — and only here. The reopens a mark click causes reuse it, which
    // is what keeps a work the reader just marked from vanishing from under them.
    reviewed = await takeReviewed(userId, this.options)
    goneHeld = new Set()
    const next = await this.compute()
    await this.commit(next)
    emptyWindow = next.works.length || next.window.pending.length ? null : quietOf(next)
    // Works parsed earlier this page run may still carry an earlier view's decoration.
    return { works: undecorated(next.works), blocked: false }
  }

  /** The window the records make now, under the reader's options. */
  private async compute(): Promise<ReviewWindow> {
    const option = this.options.trackedLists
    const start = reviewStart(option)
    const held = heldEnd?.start === start ? heldEnd.end : undefined
    const next = await computeWindow({
      option,
      options: this.options,
      reviewed: (reviewed ??= { ids: new Set(), savedKnown: false }).ids,
      endOverride: endOverride ?? held,
      works: parsed,
    })
    // A window the records say is whole keeps its end for the visit.
    if (endOverride === undefined && !next.window.pending.length && !next.window.failed.length)
      heldEnd = { start, end: next.window.end }
    current = next
    return next
  }

  /**
   * Read the stored window, and say whether it still means anything.
   *
   * A window computed against a watermark, a set of lists or a target the reader
   * has moved on from ({@link sameReviewBasis}) is about nothing at all — so it
   * stops belonging (see {@link belongsToWindow}), which leaves the host with no
   * stored copy to draw and sends it to compute a new one.
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
    factsStale = !facts
      || facts.computedAt === 0
      || !sameReviewBasis(facts, option)
    // A window about something else — a moved watermark, other lists, a new
    // target — holds no end: it is sized again.
    if (factsStale) {
      goneHeld = new Set()
      heldEnd = null
      endOverride = undefined
    }
  }

  /**
   * Write a computed window down: its facts as the cache entry, and the works
   * the window before it held — and this one doesn't — retired. The window's
   * works are the stored list, which the host writes.
   */
  private async commit(next: ReviewWindow): Promise<void> {
    const previous = facts
    const { window } = next
    const sources: { [sid: string]: string } = {}
    const shown = new Set(next.works.map(work => toShortId(work.workId)))
    for (const work of window.works) {
      if (shown.has(work.sid))
        sources[work.sid] = work.lists.join(',')
    }
    const days: { [day: string]: number } = {}
    for (const [day, count] of window.days)
      days[String(day)] = count

    const retired = await this.retire(previous, sources, next.pruned, this.options)
    const stored: TrackedReviewCache = {
      start: window.start,
      end: window.end,
      computedAt: Date.now(),
      ...reviewBasis(this.options.trackedLists),
      sources,
      days,
      failed: window.failed,
      pending: window.pending,
      retired: packIds(retired),
    }
    facts = stored
    factsStale = false
    await cache.set({ trackedReview: stored })
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
   * Four kinds of work are kept even so: one another stored list still holds,
   * one a read record still holds (the store's own rule), one carrying a mark,
   * and one saved for later. The read list rebuilds a work from a stored blurb
   * rather than fetching its page, so a work marked during a review is exactly
   * the one worth keeping.
   */
  private async retire(previous: TrackedReviewCache | null, incoming: { [sid: string]: string }, pruned: readonly string[], opts: Options): Promise<Set<string>> {
    const waiting = unpackIds(previous?.retired ?? '')
    for (const id of retireLater)
      waiting.add(id)
    retireLater.clear()
    for (const sid of [...Object.keys(previous?.sources ?? {}), ...pruned]) {
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
      const referenced = await snapshotWorkIds()
      const plan = await pruneBlurbs([...waiting], referenced)
      for (const id of plan.ids) {
        waiting.delete(id)
        parsed.delete(id)
      }
    }
    catch (err) {
      // Nothing was lost: the ids stay in `retired` and the next window tries
      // again.
      this.logger.error('Could not discard the blurbs a reviewed window left behind', err)
    }
    return waiting
  }

  /** Stamp the works with their statuses, their List source facet values and their place in review order. */
  private stamp(works: Work[]): void {
    applyStatus(works, this.options)
    const lists = this.options.trackedLists.lists
    const labels = new Map(lists.map(list => [list.id, sourceLabel(list, lists)]))
    const sources = facts?.sources ?? {}
    const place = new Map((current?.works ?? []).map((work, at) => [work.workId, at]))
    for (const work of works) {
      const sid = toShortId(work.workId)
      const ids = sid === null ? undefined : sources[sid]
      // Read from the *current* aliases, so renaming a list relabels the facet
      // on the next re-run rather than at the next compute.
      work.sources = ids ? ids.split(',').map(id => labels.get(id)).filter((label): label is string => !!label) : []
      const at = place.get(work.workId)
      if (at !== undefined)
        work.markedOrder = at
    }
  }

  // -------------------------------------------------------------------------
  // Following the records.
  // -------------------------------------------------------------------------

  /**
   * Keep the view in step with the records for as long as it is up: hear every
   * record write, from this page's reading or another's, and merge what it
   * changes; and start reading here if the records are behind and nobody else
   * is reading them.
   */
  private follow(ctl: SearchHeaderControl): void {
    control = ctl
    run.latest = this
    stopFollowing?.()
    stopFollowing = onReadRecordsChanged(() => void this.recompute())
    // The records may have moved on since the stored window was written.
    void this.recompute()
    void this.startReading()
  }

  /**
   * Compute the window again and merge the difference, one at a time, by the
   * latest run's unit. Settles once the window on screen is the one the
   * records make.
   */
  private recompute(): Promise<void> {
    if (recomputing) {
      recomputeAgain = true
      return recomputing
    }
    recomputing = (async () => {
      try {
        do {
          recomputeAgain = false
          await (run.latest ?? this).applyWindow()
        } while (recomputeAgain)
      }
      catch (err) {
        this.logger.error('Could not bring the review window up to date', err)
      }
      finally {
        recomputing = null
      }
    })()
    return recomputing
  }

  /**
   * Put the window the records make now on screen, in place: works new to it
   * merged where they belong, works that left it collapsed in their slots as
   * the next review's.
   */
  private async applyWindow(): Promise<void> {
    const ctl = control
    if (!ctl || !isSearchViewOpen() || factsStale)
      return
    const before = new Set(Object.keys(facts?.sources ?? {}))
    const next = await this.compute()
    if (control !== ctl || !isSearchViewOpen())
      return
    // A work parsed earlier this page run may carry an earlier view's
    // decoration; one this view holds carries its own, and keeps it.
    const held = new Set([...before, ...goneHeld])
    undecorated(next.works.filter(work => !held.has(toShortId(work.workId)!)))
    if (showNext) {
      // The reader's own ± day: a new range, laid out afresh.
      showNext = false
      goneHeld = new Set()
      await this.commit(next)
      ctl.show(next.works)
      redrawBar?.()
      return
    }
    const after = new Map(next.works.map(work => [toShortId(work.workId)!, work]))
    const added = [...after].filter(([sid]) => !before.has(sid) || goneHeld.has(sid)).map(([, work]) => work)
    const gone = new Set([...before].filter(sid => !after.has(sid)))
    // Before the facts are written: a render while they are keeps a gone work
    // in its slot only if it is already held as gone.
    for (const sid of gone)
      goneHeld.add(sid)
    for (const sid of after.keys())
      goneHeld.delete(sid)
    await this.commit(next)
    if (added.length || gone.size)
      ctl.merge(added, new Set([...gone].map(fromShortId).filter((id): id is string => id !== null)))
    redrawBar?.()
    this.closeIfSettledEmpty()
  }

  /** A window with nothing in it and nothing left to read closes, with the empty range's offer. */
  private closeIfSettledEmpty(): void {
    if (!current || current.works.length || current.window.pending.length || reading || goneHeld.size)
      return
    if (!isSearchViewOpen())
      return
    const quiet = quietOf(current)
    closeSearchView()
    toast(EMPTY_MESSAGE, { type: 'error' })
    this.offerEmptyRange(quiet)
  }

  /** Start reading the records here, unless they are up to date or another page is reading them. */
  private async startReading(): Promise<void> {
    if (reading || !extensionAlive())
      return
    const option = this.options.trackedLists
    const lists = option.lists.filter(list => list.tracked)
    const records = current?.records ?? await recordsOf(lists, reviewStart(option))
    if (!recordsBehind(records, lists, utcToday()))
      return
    const claim = await claimReads(PAGE_RUN)
    clearTimeout(claimRetry)
    if (!claim) {
      readingElsewhere = true
      redrawBar?.()
      // The page reading may go away without letting go; once its claim could
      // have lapsed, the next page to want a read takes over.
      claimRetry = setTimeout(() => void (run.latest ?? this).startReading(), CLAIM_TTL_MS)
      return
    }
    readingElsewhere = false
    readingStopped = false
    const controller = new AbortController()
    claim.lost.addEventListener('abort', () => controller.abort())
    reading = { controller, status: null }
    control?.setUpdating(true)
    redrawBar?.()
    let outcome: Awaited<ReturnType<typeof readTrackedLists>> | null = null
    try {
      outcome = await readTrackedLists({
        lists,
        start: reviewStart(option),
        currentStart: async () => reviewStart(await options.get('trackedLists')),
        patience: PATIENCE.interactive,
        waitBudget: WAIT_BUDGET.interactive,
        signal: controller.signal,
        onProgress: (status) => {
          if (reading)
            reading.status = status
          redrawBar?.()
        },
      })
    }
    catch (err) {
      if ((err as Error)?.name !== 'AbortError')
        this.logger.error('Could not read your tracked lists', err)
    }
    finally {
      await claim.release()
      reading = null
      readingStopped = !!outcome?.blocked
      control?.setUpdating(false)
      redrawBar?.()
    }
    await this.recompute()
    // A list tracked, or read afresh, while this run went on is still behind:
    // the next run reads it, under the options as they are now. One this run
    // gave up on waits for the next open, or Refresh.
    if (outcome && !outcome.blocked)
      await (run.latest ?? this).readAgainIfBehind(outcome.failed)
  }

  /** Start another reading if a list the last one didn't give up on still wants reading. */
  private async readAgainIfBehind(failed: readonly string[]): Promise<void> {
    const option = this.options.trackedLists
    const lists = option.lists.filter(list => list.tracked && !failed.includes(list.id))
    if (lists.length && recordsBehind(await recordsOf(lists, reviewStart(option)), lists, utcToday()))
      await this.startReading()
  }

  /** The view's Refresh: read the records again if no page is reading them. */
  private reread(): void {
    void this.recompute()
    void this.startReading()
  }

  // -------------------------------------------------------------------------
  // The toolbar.
  // -------------------------------------------------------------------------

  /**
   * The strip above the view: what range is being reviewed, how current it
   * is, how to move its end, and the one button that finishes it.
   *
   * Built once per open and kept across the renders inside it, so its own
   * spinner and its confirmations survive a merge.
   */
  private header(ctl: SearchHeaderControl): HTMLElement {
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
    const status = (<div class={`${BAR_CLASS}--status`} />) as HTMLElement
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
        {status}
        {notes}
        {warnings}
        {prompt}
      </div>
    ) as HTMLElement

    let busy = false
    let waitText: string | null = null

    const redraw = (): void => {
      const option = this.options.trackedLists
      const today = utcToday()
      const stored = facts
      if (!stored || stored.computedAt === 0) {
        range.textContent = 'Gathering your tracked lists…'
        range.toggleAttribute('data-ao3e-gathering', true)
        meta.textContent = ''
        controls.classList.add(`${BAR_CLASS}--off`)
        return
      }
      const caughtUp = stored.start > today - 1
      const span = stored.end - stored.start + 1
      const count = Object.values(stored.days).reduce((sum, n) => sum + n, 0)

      range.toggleAttribute('data-ao3e-gathering', false)
      range.textContent = caughtUp ? 'You’re caught up.' : `Reviewing ${formatRange(stored.start, stored.end)}`
      meta.textContent = caughtUp
        ? 'Today’s works so far are below; they can be reviewed tomorrow.'
        : `${span} ${span === 1 ? 'day' : 'days'} · ${count} ${count === 1 ? 'work' : 'works'} (target ${option.target})`

      controls.classList.toggle(`${BAR_CLASS}--off`, caughtUp)
      setDisabled(back, busy || stored.end <= stored.start)
      setDisabled(forward, busy || stored.end >= today - 1)
      drawStrip(strip, stored)
      const nextDay = current?.window.nextDayCount ?? 0
      hint.textContent = nextDay > 0 && stored.end < today - 1 ? `+1 day adds at least ${nextDay}` : ''

      const failed = labelsOf(stored.failed, option.lists)
      setDisabled(mark, busy || stored.end >= today)
      mark.title = stored.end >= today
        ? 'Today isn’t over yet, so it can’t be marked reviewed.'
        : failed.length
          ? 'One of your lists couldn’t be loaded — you’ll be asked before its works are skipped.'
          : `Mark ${formatRange(stored.start, stored.end)} reviewed and move on to the next range.`

      const unsettled = new Set([...stored.failed, ...stored.pending])
      const line = reviewStatus({
        window: {
          start: stored.start,
          end: stored.end,
          failed: stored.failed,
          pending: stored.pending,
          complete: option.lists.filter(list => list.tracked && !unsettled.has(list.id)).map(list => list.id),
        },
        labels: new Map(option.lists.map(list => [list.id, sourceLabel(list, option.lists)])),
        wait: reading ? waitText : null,
        elsewhere: readingElsewhere && !reading,
        stopped: readingStopped && !reading,
        readAt: lastReadAt(current?.records),
      })
      status.textContent = line.text
      status.title = line.lists.join(', ')
      status.dataset.kind = line.kind
      if (line.reading)
        status.dataset.ao3eReading = line.reading
      else
        delete status.dataset.ao3eReading

      notes.textContent = noteLine(option.lists, current?.later)
      warnings.replaceChildren(...warningLines(reviewed))
    }

    const setBusy = (on: boolean): void => {
      busy = on
      el.classList.toggle(`${BAR_CLASS}--busy`, on)
      redraw()
    }

    const step = (delta: number): void => {
      const stored = facts
      if (busy || !stored)
        return
      const wanted = Math.min(Math.max(stored.end + delta, stored.start), utcToday() - 1)
      if (wanted === stored.end)
        return
      void (async () => {
        setBusy(true)
        try {
          endOverride = wanted
          showNext = true
          await this.recompute()
        }
        finally {
          setBusy(false)
        }
      })()
    }
    back.addEventListener('click', () => step(-1))
    forward.addEventListener('click', () => step(1))

    mark.addEventListener('click', () => {
      const stored = facts
      if (busy || !stored)
        return
      const failed = labelsOf(stored.failed, this.options.trackedLists.lists)
      if (!failed.length) {
        void this.markReviewed(stored, setBusy)
        return
      }
      // Skipping a list's works silently is the one way a review can lose a
      // work, so it always asks. A list still being read doesn't: the status
      // line has said so, and missing a work then is accepted.
      prompt.replaceChildren(confirmRow(
        skipWarning(failed, stored),
        'Mark reviewed anyway',
        () => {
          prompt.replaceChildren()
          void this.markReviewed(stored, setBusy)
        },
        () => prompt.replaceChildren(),
      ))
    })

    // The countdown of a pause this page's reading sits out, a second at a time.
    stopWaitLine?.()
    stopWaitLine = watchWaitLine((line) => {
      waitText = line
      redraw()
    })

    // This open's toolbar is the one the window writes to. Set last, so a
    // half-built strip is never the one asked to redraw itself.
    redrawBar = redraw
    redraw()
    this.follow(ctl)
    return el
  }

  /**
   * Finish the range: move the watermark, then take the reviewed days off the
   * records. The next window isn't read here: the option's broadcast re-runs
   * the page, the reopen finds the stored window answering to a watermark that
   * has moved ({@link readFacts}), and the host computes the next one from the
   * records — which the reading has usually filled already.
   *
   * The watermark is read fresh and never lowered, so a tab that has been
   * sitting open can't rewind another tab's progress.
   */
  private async markReviewed(range: TrackedReviewCache, setBusy: (on: boolean) => void): Promise<void> {
    if (!extensionAlive())
      return
    setBusy(true)
    try {
      const option = await options.get('trackedLists')
      const before = Number.isSafeInteger(option.reviewedThrough) ? option.reviewedThrough : 0
      const moved = { ...option, reviewedThrough: Math.max(before, range.end) }
      endOverride = undefined
      heldEnd = null
      advanced = true
      await options.set({ trackedLists: moved })
      await pruneRecords(moved).catch(err => this.logger.error('Could not take the reviewed days off the records', err))
      // The reading here sees the watermark move, and keeps those days off as it goes.
      toast(`Marked ${formatRange(range.start, range.end)} reviewed.`, {
        type: 'success',
        name: 'marked-reviewed',
        timeout: UNDO_TIMEOUT_MS,
        action: { label: 'Undo', onClick: () => void undoReviewed(before, moved.reviewedThrough) },
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
  private offerEmptyRange(quiet: QuietWindow): void {
    // A range that can't be marked reviewed has nothing to offer, and the host
    // has already said there was nothing there.
    if (!quiet.reviewable)
      return
    toast(`Nothing from your tracked lists for ${formatRange(quiet.start, quiet.end)}.`, {
      name: 'nothing-to-review',
      timeout: 0,
      action: {
        label: 'Mark reviewed',
        onClick: () => {
          const stored = facts
          if (stored)
            void this.markReviewed(stored, () => {})
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

/** The tracked lists' records as stored, each as the window starting on `start` takes it. */
async function recordsOf(lists: readonly TrackedList[], start: Day): Promise<Map<string, TrackedRead>> {
  const stored = await readStoredRecords(lists.map(list => list.id))
  return new Map(lists.map(list => [list.id, recordFor(list, stored.get(list.id), start)]))
}

/**
 * Take every day `option`'s watermark covers off the tracked lists' records,
 * and keep the works that only those days held for the next write to retire.
 *
 * Only while no page is reading them, under the read claim for as long as it
 * takes: a prune written beside a reading could put back a record from before
 * the page it just added. A reading, here or elsewhere, keeps the reviewed days
 * off as it goes instead.
 */
async function pruneRecords(option: TrackedListsOption): Promise<void> {
  if (reading)
    return
  const claim = await claimReads(PAGE_RUN)
  if (!claim)
    return
  try {
    const lists = option.lists.filter(list => list.tracked)
    const stored = await readStoredRecords(lists.map(list => list.id))
    const writes = new Map<string, TrackedRead>()
    for (const list of lists) {
      const record = storedRecordOf(list, stored.get(list.id))
      if (!record)
        continue
      const after = pruneReviewed(record, option.reviewedThrough)
      if (after.record === record)
        continue
      writes.set(list.id, after.record)
      for (const sid of after.dropped) {
        const id = fromShortId(sid)
        if (id)
          retireLater.add(id)
      }
    }
    await writeReadRecords(writes)
  }
  finally {
    await claim.release()
  }
}

/** The empty range a window stands for, for its toast. */
function quietOf(next: ReviewWindow): QuietWindow {
  return { start: next.window.start, end: next.window.end, reviewable: next.window.reviewable }
}

/** When the records were last written, as the status line says it: `14:02`. Null when none has been. */
function lastReadAt(records: ReadonlyMap<string, TrackedRead> | undefined): string | null {
  let at = 0
  for (const record of records?.values() ?? [])
    at = Math.max(at, record.readAt)
  return at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
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
 * A work outside the stored window is a leftover from a window that has moved
 * on, and can't be shown — unless it left the window while it was on screen,
 * and holds its slot there as gone. A work the reader has dealt with since the
 * window was computed — marked read on another page, saved from a menu — goes
 * too, which is how a stored window stays honest without being computed again.
 */
function belongsToWindow(work: Work): boolean {
  if (factsStale || !facts)
    return false
  const sid = toShortId(work.workId)
  if (sid === null)
    return false
  if (!(sid in facts.sources) && !goneHeld.has(sid))
    return false
  return !reviewed?.ids.has(work.workId)
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
    endOverride = undefined
    heldEnd = null
    await options.set({ trackedLists: { ...option, reviewedThrough: previous } })
    toast('Put the range back.', { type: 'success' })
  }
  catch {
    toast('Could not undo that. Please try again.', { type: 'error' })
  }
}

/**
 * Where This review lives, which its Start Review on the options page opens it
 * on when the reader's account isn't known there. A review is computed from
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

/** One bar per day of the window, tallest for the busiest, with the count on hover. */
function drawStrip(strip: HTMLElement, window: TrackedReviewCache): void {
  const days: [Day, number][] = []
  for (let day = window.start; day <= window.end; day++)
    days.push([day, window.days[String(day)] ?? 0])
  const peak = Math.max(1, ...days.map(([, count]) => count))
  strip.replaceChildren(...days.map(([day, count]) => {
    const label = `${formatDay(day)} — ${count} ${count === 1 ? 'work' : 'works'}`
    const bar = (<span class={`${BAR_CLASS}--day`} title={label} aria-label={label} role="img" data-ao3e-day={day} data-ao3e-count={count} />) as HTMLElement
    // A day with nothing in it still gets a sliver, so the run of quiet days a
    // range can hold is visible as a run rather than as a gap.
    bar.style.height = `${Math.max(8, Math.round((count / peak) * 100))}%`
    return bar
  }))
}

/** `5 lists · about 412 more to review`. */
function noteLine(lists: readonly TrackedList[], later: number | undefined): string {
  const tracked = lists.filter(list => list.tracked).length
  const parts = [`${tracked} ${tracked === 1 ? 'list' : 'lists'}`]
  if (later && later > 0)
    parts.push(`about ${later.toLocaleString()} more to review`)
  return parts.join(' · ')
}

/** The names of these lists, by id. */
function labelsOf(ids: readonly string[], lists: readonly TrackedList[]): string[] {
  return ids.map((id) => {
    const entry = lists.find(list => list.id === id)
    return entry ? sourceLabel(entry, lists) : id
  })
}

/** The lines under the toolbar that say what this window may be missing. */
function warningLines(set: ReviewedSet | null): HTMLElement[] {
  if (set && !set.savedKnown)
    return [warning('saved-unknown', 'Marked for Later not loaded on this browser. Open it once to skip saved works.')]
  return []
}

/** A warning line, which `kind` names. */
function warning(kind: string, text: string): HTMLElement {
  return (<div class={`${BAR_CLASS}--warning`} data-ao3e-warning={kind}>{text}</div>) as HTMLElement
}

/** What the reader is agreeing to when they mark a range whose lists couldn't all be read. */
function skipWarning(failed: readonly string[], window: TrackedReviewCache): string {
  const where = formatRange(window.start, window.end)
  return `${failed.map(label => `“${label}”`).join(', ')} couldn’t be loaded; ${failed.length === 1 ? 'its' : 'their'} works for ${where} will be skipped.`
}

/** A line of explanation with one or two buttons under it. */
function confirmRow(text: string, label: string, onConfirm: () => void, onCancel: (() => void) | null): HTMLElement {
  const confirm = (<button type="button" class={`${BAR_CLASS}--confirm`} data-ao3e-action="confirm">{label}</button>) as HTMLElement as HTMLButtonElement
  confirm.addEventListener('click', onConfirm)
  const row = (
    <div class={`${BAR_CLASS}--prompt-row`}>
      <span>{text}</span>
      {confirm}
    </div>
  ) as HTMLElement
  if (onCancel) {
    const cancel = (<button type="button" class={`${BAR_CLASS}--confirm`} data-ao3e-action="cancel">Cancel</button>) as HTMLElement as HTMLButtonElement
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
 * place of our button (or where it would be), and the item that *was* current
 * turned back into a link.
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
  const place = nav?.querySelector(`.${BUTTON_CLASS}`)?.closest('li') ?? anchorItem()
  place?.after(
    <li class={`${ADDON_CLASS}  ${CHROME_CLASS}`}><span class="current">{LIST_NAME}</span></li>,
  )
}
