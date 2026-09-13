import type { Options, SnapshotDescriptor } from '#common'
import type { Work } from '#content_script/blurb.js'

import { ADDON_CLASS, logger, toast } from '#common'
import { onArchiveWait } from '#content_script/archiveFetch.js'
import { pruneDetachedTriggers } from '#content_script/contextTrigger.js'
import { extensionAlive } from '#content_script/extensionAlive.js'
import { refreshFilterToolbar } from '#content_script/units/FilterToolbar.tsx'
import React from '#dom'

import type { WriteSnapshotOptions } from './cache.ts'
import type { FacetValueRef } from './engine.ts'
import type { SearchView, SearchViewConfig, ViewState } from './view.tsx'
import type { Recovered, RecoverOptions } from './workPageBlurb.tsx'

import { readSnapshot, writeSnapshot } from './cache.ts'
import { cx, HOST, NATIVE_HIDDEN_CLASS } from './classes.ts'
import { decorateBlurb, decorateContainer, makeFacetHider } from './decorate.ts'
import { applyHidden } from './hidden.ts'
import { loadPrefs, savePrefs } from './prefs.ts'
import { isArchiveBusy, MAX_SCANNED_PAGES, scrapeListing } from './scrape.ts'
import { createSearchView } from './view.tsx'

/**
 * The plumbing every place that offers the in-memory search view needs: mount a
 * container, render the cached snapshot instantly (or scrape with a progress bar
 * when there is none), refresh in the background, and put the native page back on
 * "Back to list". Everything page-specific lives in a {@link SearchSource}.
 *
 * State is module-level rather than per-source because at most one view can be
 * open at a time — each source belongs to a different AO3 page, and a content
 * script only ever sees one.
 */

const log = logger.child('searchView')

/**
 * What to say when AO3 turned us away and kept turning us away. Deliberately not
 * worded as a failure: nothing is wrong, we were asking too often, and the one
 * useful thing the reader can do is come back in a few minutes.
 */
const RATE_LIMITED = 'AO3 asked us to slow down. Try again in a few minutes.'

/**
 * Everything that differs between the places the search view is offered: where
 * its works come from, where the view goes, and what it stands in for.
 */
export interface SearchSource {
  /**
   * Identifies this application of the view. Used as a CSS hook and as the id
   * for local layout prefs, so one id per *feature* — not per user or per tag —
   * lets a layout follow the reader around.
   */
  id: string
  /** Snapshot cache key: the id plus whatever varies inside it (user, tag, …). */
  cacheKey: string
  /**
   * The serializable half of this source — enough to re-fetch the listing from
   * the options page, which has none of these closures and no AO3 document to
   * read. Stored with every snapshot; see {@link SnapshotDescriptor}.
   */
  descriptor: () => SnapshotDescriptor
  /** Builds the URL of a 1-based page of the source listing. */
  pageUrl: (page: number) => string
  /**
   * How many pages that listing has, at load time — read off the live page when
   * that page *is* the listing. A source offered somewhere else (the read-items
   * view, which is offered on the Marked for Later page too) has to fetch page 1
   * to find out, so this may answer with a promise; such a source hands the page
   * it fetched back through {@link firstPageDoc} rather than letting the scrape
   * ask AO3 for it twice.
   */
  pageCount: () => number | Promise<number>
  /**
   * Page 1 of the listing, if {@link pageCount} had to fetch it. Consumed once
   * per count — a later scrape gets its own — so returning a stale document
   * here would be a bug rather than a saving.
   */
  firstPageDoc?: () => Document | undefined
  /**
   * How many works the listing says it holds, when it says so at all. Only used
   * to explain a truncated load ({@link budgetFor}) — the cap itself is counted
   * in pages, which every listing reports.
   */
  resultCount?: () => number | null
  /** Where blurbs sit in a fetched page (see `DEFAULT_BLURB_SELECTOR`). */
  blurbSelector?: string
  /**
   * Which of the listing's works this source actually means to show.
   *
   * Most sources show their listing; the read list does not. Its works are the
   * ones the reader has marked, which the extension knows only as work ids —
   * a mark table holds no titles, tags or authors — so the listing it scrapes
   * (the archive's own history) is a **haystack it reads to find their blurbs**,
   * not the answer. Everything the reader sees, everything cached, and
   * everything faceted is what this returns.
   *
   * A source that sets it is budgeted differently: the works ceiling bounds what
   * comes out rather than how much is read, and {@link satisfied} is how it
   * avoids reading more of the haystack than it has to.
   */
  select?: (works: Work[]) => Work[]
  /**
   * Whether a work still belongs on the list, given what the reader has done
   * since it was stored — applied wherever {@link select} is, and to the stored
   * copy on every open.
   *
   * The Marked for Later list uses it for works the reader has marked read: AO3
   * may well still list one (the request to take it off can fail), but the
   * reader has said they're done with it, so it goes the moment they say so
   * rather than at the next reload. A view reopens from its snapshot on every
   * options change, which is what makes that immediate.
   *
   * A source that sets it keeps its side records ({@link onPersist}) in step with
   * the *listing*, not with the pruned list — only a scrape has that, so only a
   * scrape calls `onPersist`. A work pruned here is exactly the kind of thing
   * those records exist to remember.
   */
  belongs?: (work: Work) => boolean
  /**
   * Fetch, some other way, the works the list should hold that its listing
   * didn't turn up — given every work the list does hold. Runs after each scrape
   * that isn't refused; what it returns goes on the end of the list.
   *
   * The read list's works are marks and its listing is the reader's history,
   * where a work marked read without being opened simply isn't; its own work
   * page is where such a work's details are found instead.
   */
  recover?: (works: Work[], opts: RecoverOptions) => Promise<Recovered>
  /**
   * Whether the scrape can stop, given the work ids seen so far — passed
   * straight through to the scraper, which is where it is explained.
   */
  satisfied?: (ids: ReadonlySet<string>) => boolean
  /** The native elements hidden while the view is up, restored when it closes. */
  nativeElements: () => Iterable<Element>
  /**
   * The view *is* this page rather than something opened on top of it, so it
   * gets no "Back to list" button: there is no native list the reader is meant
   * to go back to. The Marked for Later page is one — its own AO3 listing is
   * replaced outright.
   */
  replacesListing?: boolean
  /** Insert the (empty, already classed) container where the view belongs. */
  mount: (container: HTMLElement) => void
  /**
   * Undo whatever {@link mount} did to the page besides inserting the container
   * — which the host removes itself — however the view closes: Back, Cancel, a
   * failed load, or a global re-run suspending it. Anything native it hid should
   * be in {@link nativeElements}, which the host puts back on its own.
   */
  unmount?: () => void
  /**
   * How long, in ms, a stored snapshot is recent enough that opening the view
   * shows it without re-scraping the listing behind it. Absent or `0` refreshes
   * on every open, which suits a listing that costs a page or two.
   *
   * Measured from the snapshot's `scrapedAt`, which only a real scrape moves.
   * The view's Refresh button ignores it, as does a view opened with no stored
   * copy at all.
   */
  refreshInterval?: () => number
  /**
   * An automatic reload that only *adds to* the stored list, for a list too long
   * to re-read on a timer and too stable to need it.
   *
   * Given the stored works, return what to go looking for — or null when the
   * stored copy already has everything, in which case the reload makes no request
   * at all. What it finds is put in front of the stored works (a listing's
   * newest entries come first) and the whole is stored as the new snapshot.
   * Nothing already stored is fetched again, so a work that has changed on AO3
   * keeps its old blurb until the reader presses Refresh, which re-reads the list
   * in full whatever this says.
   *
   * Absent means an automatic reload re-reads the whole listing, like Refresh.
   */
  topUp?: (stored: Work[]) => TopUp | null
  /**
   * Stamp or seed a set of works before the view sees them — readiness, saved
   * state, anything that isn't a property of the blurb. Runs on every load,
   * cached or fresh, and is told which: a source with something to *say* about
   * the set it was handed can only say it honestly of one that was just
   * scraped. A snapshot is by definition the answer to an older question.
   */
  prepare?: (works: Work[], opts: { fresh: boolean }) => void
  /** Persist alongside the blurb snapshot the host always writes (e.g. an id index). */
  onPersist?: (works: Work[]) => Promise<void>
  /** Source-specific view config, layered over the host's shared defaults. */
  viewConfig?: SearchViewConfig
  /** Shown when the source turns out to hold no works at all. */
  emptyMessage: string
  /** Shown when the load fails outright. */
  errorMessage: string
}

/** What a {@link SearchSource.topUp} goes looking for. */
export interface TopUp {
  /** Whether the scrape has found everything it came for (see `ScrapeOptions.satisfied`). */
  satisfied: (ids: ReadonlySet<string>) => boolean
  /** The works, of those the scrape brought back, that are new to the list. */
  select: (works: Work[]) => Work[]
}

/**
 * Works per page in every AO3 listing the view scrapes from. Only used to turn
 * the reader's works ceiling into a page ceiling; a listing that ever served
 * fewer just means we fetch a page or two more than strictly needed, and the
 * hard trim on the collected works still holds the ceiling exactly.
 */
const WORKS_PER_PAGE = 20

/** How much of a listing we're willing to fetch, and how much it actually has. */
interface Budget {
  /** Pages to fetch: the listing's own count, capped by {@link limit}. */
  pages: number
  /** Pages the listing really has. `> pages` means the load is truncated. */
  totalPages: number
  /** Works to keep. Never exceeded, whatever the pages turn out to hold. */
  limit: number
}

/**
 * Work out how much of `source` to load under the reader's `searchMaxResults`
 * ceiling. AO3 serves a text search for a common word half a million works deep
 * — 25,000 page requests — so no source is ever scraped whole on trust.
 */
async function budgetFor(source: SearchSource, options: Options): Promise<Budget> {
  const limit = limitFor(options)
  const totalPages = Math.max(1, await source.pageCount())
  // A source that selects from its listing is searching a haystack: its works
  // ceiling bounds what comes *out*, and twenty pages of history might hold one
  // work the reader wants or none at all. So the pages get their own cap, and
  // `satisfied` is what usually ends the scrape long before it.
  const pages = source.select
    ? Math.min(totalPages, MAX_SCANNED_PAGES)
    : Math.min(totalPages, Math.ceil(limit / WORKS_PER_PAGE))
  return { limit, totalPages, pages }
}

/**
 * The works a source means to show, out of what its listing held. Applied to a
 * cached snapshot too: the snapshot stores what was selected last time, and the
 * reader's marks move on between visits.
 */
function selected(source: SearchSource, works: Work[]): Work[] {
  const chosen = source.select ? source.select(works) : works
  return source.belongs ? chosen.filter(source.belongs) : chosen
}

/**
 * Renumber a list put together from more than one place — a scrape, a stored
 * copy, works fetched one by one — in the order it now stands, which is what
 * the "listing order" sort reads.
 */
function renumber(works: Work[]): Work[] {
  works.forEach((work, index) => {
    work.markedOrder = index
  })
  return works
}

/**
 * The list a scrape produced, completed by the source's {@link SearchSource.recover}.
 *
 * If AO3 stopped answering partway through, every work the stored copy had that
 * this didn't reach keeps its stored copy — a refusal is no reason to drop a
 * work from the list, and saving what *was* fetched means the next attempt
 * starts further on instead of from scratch.
 */
async function complete(
  source: SearchSource,
  kept: Work[],
  opts: RecoverOptions,
): Promise<{ works: Work[], blocked: boolean }> {
  if (!source.recover)
    return { works: kept, blocked: false }
  const recovered = await source.recover(kept, opts)
  const works = [...kept, ...recovered.works]
  if (recovered.blocked) {
    const have = new Set(works.map(work => work.workId))
    const previous = await readSnapshot(source.cacheKey)
    works.push(...selected(source, previous?.works ?? []).filter(work => !have.has(work.workId)))
  }
  return { works, blocked: recovered.blocked }
}

/**
 * The reader's works ceiling alone, without asking the source how long it is —
 * which for some sources is a request ({@link SearchSource.pageCount}). All a
 * caller trimming an already-loaded set needs.
 *
 * Exported because a source that means to report on its own shortfall has to
 * know it: a list cut short by the reader's own ceiling is not a list with
 * anything missing from it.
 */
export function limitFor(options: Options): number {
  // A ceiling under one page would fetch nothing at all; one page is the floor.
  return Math.max(WORKS_PER_PAGE, Math.floor(options.searchMaxResults) || WORKS_PER_PAGE)
}

/** Whether `budget` leaves part of the listing unread. */
function isTruncated(budget: Budget): boolean {
  return budget.pages < budget.totalPages
}

/** Drop everything past the reader's ceiling, in place. */
function applyLimit(works: Work[], limit: number): Work[] {
  if (works.length > limit)
    works.length = limit
  return works
}

let active: { source: SearchSource, view: SearchView } | null = null
/**
 * The source whose container is in the page, from the moment it is mounted —
 * which is before {@link active}, while a scrape is still running — so a close
 * at any point can hand it {@link SearchSource.unmount}.
 */
let mounted: SearchSource | null = null
/**
 * Bumped by every open and every close. An open awaits several times — prefs,
 * the snapshot, the page count, the scrape — and another view can replace it
 * during any of them, so after each it checks it is still the current one
 * rather than rendering into a container that is gone, or closing the view that
 * replaced it.
 */
let generation = 0
let controller: AbortController | null = null
let busy = false
/**
 * Set when a global re-run (e.g. an options change from a context menu) closed an
 * open view, carrying the state needed to reopen it where it left off. Cleared by
 * {@link closeSearchView}, so a user-initiated close (Back) stays closed.
 */
let reopen: { cacheKey: string, state: ViewState } | null = null

/** Whether a view is currently mounted (by this host, for any source). */
export function isSearchViewOpen(): boolean {
  return document.querySelector(`.${HOST}`) !== null
}

/** Restore the native page: abort any scrape, remove the view, un-hide the list. */
export function closeSearchView(): void {
  generation++
  controller?.abort()
  controller = null
  active = null
  busy = false
  // A close means "don't come back" unless the caller re-arms reopen after.
  reopen = null
  for (const el of document.querySelectorAll(`.${HOST}`))
    el.remove()
  // Before the native page comes back, so the source's stand-ins are never on
  // screen alongside the things they stood in for.
  const was = mounted
  mounted = null
  was?.unmount?.()
  for (const el of document.querySelectorAll(`.${NATIVE_HIDDEN_CLASS}`))
    el.classList.remove(NATIVE_HIDDEN_CLASS)
  // Release the context-menu triggers on the now-removed blurbs (the native
  // page's still-connected triggers are left intact).
  pruneDetachedTriggers()
  // The view's collapsed works went with it, and the native listing's are back:
  // both change what the peek pill should be counting.
  refreshFilterToolbar()
}

/**
 * Close the view but remember where it was, so the unit's next `ready()` can put
 * it back. For a unit's static `clean()`, which runs on every global re-run.
 */
export function suspendSearchView(): void {
  // Every unit's clean() runs on a re-run, so this is called once per search-view
  // unit. Only the one that had a view open has anything to suspend; the rest
  // must leave an already-armed reopen alone.
  if (!active)
    return
  const snapshot = { cacheKey: active.source.cacheKey, state: active.view.getState() }
  closeSearchView()
  reopen = snapshot
}

/**
 * Claim the pending reopen state for `cacheKey`, if a {@link suspendSearchView}
 * left one. One-shot: a reopen is only ever honoured once.
 */
export function takeReopen(cacheKey: string): ViewState | null {
  if (!reopen || reopen.cacheKey !== cacheKey)
    return null
  const { state } = reopen
  reopen = null
  return state
}

/**
 * Everything the works need before the view sees them, cached or fresh: the
 * source's own seeding (readiness, saved state), and the one pass every source
 * shares — working out which works the reader's rules take away outright, so the
 * view can page around them. Deliberately after {@link persist}: what's stamped
 * here answers to today's options, and the snapshot is the blurbs alone.
 *
 * Returns the facet exclusions that pass hands to the view in place of hiding
 * the works outright (see {@link file://./hidden.ts}); empty unless the reader
 * has `autoExcludeHidden` on.
 */
function prepare(source: SearchSource, works: Work[], options: Options, fresh: boolean): FacetValueRef[] {
  source.prepare?.(works, { fresh })
  return applyHidden(works, options)
}

/** Write the blurb snapshot, plus whatever else the source keeps in step with it. */
async function persist(
  source: SearchSource,
  works: Work[],
  opts: WriteSnapshotOptions & { listing?: Work[] } = {},
): Promise<void> {
  await writeSnapshot(source.cacheKey, works, source.descriptor(), { keepScrapedAt: opts.keepScrapedAt })
  // A pruned list says nothing about what the listing holds; see `belongs`.
  if (!source.belongs || opts.listing)
    await source.onPersist?.(opts.listing ?? works)
}

/** Hide the source's native listing and insert an empty view container for it. */
function mountContainer(source: SearchSource): HTMLElement {
  for (const el of source.nativeElements())
    el.classList.add(NATIVE_HIDDEN_CLASS)
  const container = (<div class={`${ADDON_CLASS}  ${HOST}  ${ADDON_CLASS}--${source.id}`} />) as HTMLElement
  mounted = source
  source.mount(container)
  return container
}

/** `2:05`, or `9s` under a minute — a wait too short to need the colon. */
function countdown(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const seconds = total % 60
  return total >= 60 ? `${Math.floor(total / 60)}:${String(seconds).padStart(2, '0')}` : `${seconds}s`
}

interface ProgressPanel {
  onProgress: (done: number, total: number) => void
  /** Fetching works one page each, after the listing (see `SearchSource.recover`). */
  onRecover: (done: number, total: number) => void
  /** Stop watching for pauses. The panel itself goes with whatever replaces it. */
  dispose: () => void
}

/**
 * Determinate progress panel shown while a fresh scrape runs.
 *
 * It also watches for fetching to pause ({@link file://./../archiveFetch.ts}),
 * because a scrape that has been asked to wait stands still for minutes at a
 * time and would otherwise be indistinguishable from one that has hung. The bar
 * keeps whatever it had reached — nothing has been lost, and the pages already
 * in hand are still in hand — and the line says what we are waiting for and how
 * much longer.
 */
function mountProgress(container: HTMLElement): ProgressPanel {
  const label = (<div class={cx('progress-label')}>Preparing…</div>) as HTMLElement
  const fill = (<div class={cx('progress-fill')} />) as HTMLElement
  const cancel = (<button type="button" class={cx('progress-cancel')}>Cancel</button>) as HTMLElement
  cancel.addEventListener('click', () => closeSearchView())
  const panel = (
    <div class={cx('progress')}>
      {label}
      <div class={cx('progress-track')}>{fill}</div>
      {cancel}
    </div>
  )
  container.replaceChildren(panel)

  let progressText = 'Preparing…'
  let waitUntil = 0
  let waitText = ''
  let ticker: ReturnType<typeof setInterval> | undefined

  const draw = (): void => {
    const left = Math.max(0, waitUntil - Date.now())
    if (left <= 0 && ticker !== undefined) {
      clearInterval(ticker)
      ticker = undefined
    }
    label.textContent = left > 0 ? `${waitText} — trying again in ${countdown(left)}` : progressText
  }

  // The pause is held for the whole pool, so one subscription says it once
  // rather than once per worker sitting inside it.
  const unwatch = onArchiveWait((until, reason) => {
    waitUntil = until
    waitText = reason === 'refused' ? 'AO3 asked us to slow down' : 'Giving AO3 a moment'
    if (until && ticker === undefined)
      ticker = setInterval(draw, 1000)
    draw()
  })

  return {
    onProgress: (done, total) => {
      progressText = `Loaded ${done} of ${total} pages…`
      fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`
      draw()
    },
    onRecover: (done, total) => {
      progressText = `Fetching ${done} of ${total} works from their own pages…`
      fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`
      draw()
    },
    dispose: () => {
      unwatch()
      clearInterval(ticker)
    },
  }
}

/**
 * Ask before loading a listing too big to load whole. What comes back isn't
 * "the results" but the first N of them in the source's own order, which is a
 * different thing to search — so the reader gets to see the numbers and decide,
 * rather than discovering the truncation from a toast after the fact.
 *
 * Resolves true to go ahead, false if the reader backed out.
 */
function mountLimitGate(
  container: HTMLElement,
  source: SearchSource,
  budget: Budget,
  signal: AbortSignal,
): Promise<boolean> {
  const n = (value: number): string => value.toLocaleString()
  const found = source.resultCount?.()
  // Prefer the listing's own total; fall back to what its page count implies.
  const total = found && found > 0
    ? `${n(found)} works`
    : `about ${n(budget.totalPages * WORKS_PER_PAGE)} works (${n(budget.totalPages)} pages)`

  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const load = (<button type="button" class={cx('gate-load')}>{`Load the first ${n(budget.limit)}`}</button>) as HTMLElement
    const cancel = (<button type="button" class={cx('gate-cancel')}>Cancel</button>) as HTMLElement
    load.addEventListener('click', () => resolve(true))
    cancel.addEventListener('click', () => resolve(false))
    signal.addEventListener('abort', () => resolve(false), { once: true })
    container.replaceChildren(
      <div class={cx('gate')}>
        <div class={cx('gate-title')}>Too many results to load</div>
        <p class={cx('gate-body')}>
          {`This list holds ${total} — far more than can be fetched a page at a time. `}
          {`Only the first ${n(budget.limit)} would be loaded, in the order the Archive lists them, `}
          so narrowing the search first will give you a better set to filter.
        </p>
        <p class={cx('gate-note')}>
          You can raise the limit in the extension's Search &amp; browsing options.
        </p>
        <div class={cx('gate-actions')}>
          {cancel}
          {load}
        </div>
      </div>,
    )
  })
}

/**
 * Re-scrape in the background and feed the result into the live view + cache.
 * With `topUp`, only look for what the stored works lack, and add it to them.
 */
async function refresh(
  source: SearchSource,
  view: SearchView,
  options: Options,
  topUp?: { plan: TopUp, stored: Work[] },
): Promise<void> {
  controller?.abort()
  const own = new AbortController()
  controller = own
  try {
    // Re-budgeted rather than reused: the reader may have changed the ceiling,
    // and the listing may have grown, since the view was opened.
    const budget = await budgetFor(source, options)
    if (own.signal.aborted)
      return
    const result = await scrapeListing({
      pageCount: budget.pages,
      pageUrl: source.pageUrl,
      blurbSelector: source.blurbSelector,
      firstPageDoc: source.firstPageDoc?.(),
      satisfied: topUp ? topUp.plan.satisfied : source.satisfied,
      signal: own.signal,
    })
    if (own.signal.aborted)
      return
    // A refusal taught us nothing about the list, so the list is left exactly as
    // it was — neither written over nor taken off the screen. What came back is
    // whatever the archive let through before it stopped answering, and putting
    // *that* in front of a reader already looking at the whole list would drop
    // works from under them and write the gap to disk (and, for Marked for
    // Later, out of the saved-work index) on the strength of a bad minute.
    if (result.blocked) {
      toast(`AO3 asked us to slow down, so the list wasn't refreshed. It is still showing what was stored. Try again in a few minutes.`, { type: 'error' })
      return
    }
    const kept = topUp
      ? [...topUp.plan.select(result.works), ...topUp.stored]
      : selected(source, result.works)
    // A reload the reader asked for retries works an earlier one couldn't get;
    // a top-up is automatic, and leaves them be.
    const completed = await complete(source, kept, { signal: own.signal, full: !topUp })
    if (own.signal.aborted)
      return
    const works = applyLimit(renumber(completed.works), budget.limit)
    await persist(source, works, { listing: topUp ? undefined : result.works })
    view.update(works, prepare(source, works, options, true))
    view.setRefreshedAt(Date.now())
    if (completed.blocked)
      toast('AO3 asked us to slow down before every work could be fetched. The rest keep their stored copies and will be tried again.', { type: 'error' })
    // A scrape that stopped because it had found everything it came for is not
    // a scrape that fell short.
    else if (!result.satisfied && result.loadedPages < result.totalPages)
      toast(`Updated with ${result.loadedPages} of ${result.totalPages} pages.`, { type: 'error' })
  }
  catch (err) {
    if ((err as Error)?.name !== 'AbortError')
      log.error(`Background refresh failed for ${source.id}`, err)
  }
  finally {
    if (controller === own)
      controller = null
  }
}

export interface OpenOptions {
  /** Restore a prior view state (a reopen after a global re-run). */
  initialState?: ViewState
  /** Skip the background re-scrape, when the cache is known to be fresh. */
  refresh?: boolean
}

/**
 * Open the in-memory view for `source`, in place of its native listing. Renders
 * instantly from the cached snapshot when there is one (refreshing behind it);
 * otherwise scrapes the whole listing behind a progress bar first.
 */
export async function openSearchView(source: SearchSource, options: Options, opts: OpenOptions = {}): Promise<void> {
  // This list is already on screen, or on its way there: a second click, or a
  // unit re-running, has nothing to add. "On screen" is the container being in
  // the page — a global re-run removes it mid-load, and a load with nowhere to
  // render has to be started again, not waited for.
  if (isSearchViewOpen() && mounted?.cacheKey === source.cacheKey)
    return
  // An orphaned page could still scrape the listing — the fetches are the
  // reader's own session, not ours — but nothing it learned would survive:
  // there is no snapshot to read, none to write, and no mark it could record.
  // A whole listing's worth of requests to AO3 for a view that forgets
  // everything is worse than saying so (see
  // {@link file://./../extensionAlive.ts}).
  if (!extensionAlive())
    return
  // A different list is up, or loading: this one replaces it. Two readings lists
  // share one page, and the reader moving from one to the other should get the
  // one they asked for, not a refusal because the other got there first.
  if (busy || isSearchViewOpen())
    closeSearchView()
  const gen = ++generation
  const stale = (): boolean => gen !== generation
  busy = true
  try {
    const container = mountContainer(source)
    // Local (never-synced) layout prefs for this application of the view.
    const prefs = await loadPrefs(source.id)
    if (stale())
      return
    const config: SearchViewConfig = {
      perPage: options.searchPerPage,
      decorateBlurb: blurb => decorateBlurb(blurb, options),
      decorateContainer: root => decorateContainer(root, options),
      onRendered: refreshFilterToolbar,
      hideFacetValue: makeFacetHider(options),
      ...source.viewConfig,
      initialState: opts.initialState,
      prefs,
      onPrefsChange: (next) => {
        void savePrefs(source.id, next).catch(err => log.error('Failed to save search-view prefs', err))
      },
      // Fires when a blurb action drops a work; keep the snapshot in step.
      onWorksChanged: (works) => {
        void persist(source, works, { keepScrapedAt: true }).catch(err => log.error('Failed to persist the search-view snapshot', err))
      },
    }
    const handlers = {
      onBack: source.replacesListing ? undefined : () => closeSearchView(),
      onRefresh: () => {
        if (!active)
          return
        const { view } = active
        view.setUpdating(true)
        void refresh(source, view, options).finally(() => view.setUpdating(false))
      },
    }

    // Set for the one call that follows a scrape; a cached render is not fresh.
    let fresh = false
    const show = (works: Work[], refreshedAt: number): SearchView => {
      const autoExcludes = prepare(source, works, options, fresh)
      const view = createSearchView(works, handlers, { ...config, autoExcludes, refreshedAt })
      active = { source, view }
      container.replaceChildren(view.el)
      return view
    }

    const cached = await readSnapshot(source.cacheKey)
    if (stale())
      return
    const kept = cached ? selected(source, cached.works) : []
    if (cached && kept.length) {
      // Works that stopped belonging since the snapshot was taken — marked read
      // off Marked for Later, or unmarked off the read list — come out of the
      // stored copy now, not at the next reload. This is also how the change
      // reaches the screen: an options change reopens the view from here.
      if (kept.length < cached.works.length)
        void persist(source, [...kept], { keepScrapedAt: true }).catch(err => log.error(`Failed to prune the stored copy of ${source.id}`, err))
      // A snapshot taken under a higher ceiling than the reader now has; trim it
      // to what they asked for rather than waiting for the refresh to say so.
      // The ceiling alone: how long the listing is only matters to a scrape, and
      // asking can cost a request.
      const stored = applyLimit(kept, limitFor(options))
      // The snapshot itself is already on disk — but whatever the source keeps in
      // step with it may not be (a snapshot from before that record existed, or a
      // refresh that failed), so re-derive it from the cache. The refresh below
      // normally overwrites it within seconds. Not for a source that prunes its
      // stored copy: that copy is no longer the listing (see `belongs`).
      if (!source.belongs)
        void source.onPersist?.(stored).catch(err => log.error(`Failed to seed records for ${source.id}`, err))
      // Render instantly from cache, then refresh in the background (unless the
      // caller knows the cache is fresh, e.g. a reopen right after a re-run).
      const view = show(stored, cached.scrapedAt)
      // A copy younger than the source's interval is taken as it is: reloading a
      // long list on every visit is how a reader gets rate-limited, and the
      // Refresh button is right there when they want it sooner.
      const age = Date.now() - cached.scrapedAt
      const recent = age >= 0 && age < (source.refreshInterval?.() ?? 0)
      // `undefined` is a full reload, `null` is a top-up with nothing to find.
      const plan = !recent && opts.refresh !== false && source.topUp ? source.topUp(stored) : undefined
      if (opts.refresh !== false && !recent && plan !== null) {
        view.setUpdating(true)
        void refresh(source, view, options, plan ? { plan, stored } : undefined).finally(() => view.setUpdating(false))
      }
      return
    }

    // No cache: scrape with a progress bar before showing the view. A listing
    // too big for the reader's ceiling gets a say-so first — it's their request
    // being narrowed, not ours.
    const own = new AbortController()
    // Registered before the count and the gate so a "Back"/re-run teardown,
    // which aborts the live controller, releases either of them rather than
    // leaving one running behind a page that has moved on.
    controller = own
    // Counting the listing's pages can itself be a request (see
    // `SearchSource.pageCount`), so the progress panel — and its Cancel button
    // — goes up before the count rather than after it.
    let progress = mountProgress(container)
    try {
      const budget = await budgetFor(source, options)
      if (stale())
        return
      if (own.signal.aborted) {
        closeSearchView()
        return
      }
      // No gate for a source that selects: what the gate asks about is loading
      // the first N of a listing instead of all of it, and for a haystack that
      // is neither what is being loaded nor what the reader would get. Its page
      // cap and `satisfied` bound the reading instead, and the progress panel's
      // Cancel is the say-so.
      if (isTruncated(budget) && !source.select) {
        const go = await mountLimitGate(container, source, budget, own.signal)
        if (stale())
          return
        if (!go) {
          closeSearchView()
          return
        }
        // The gate replaced the progress panel with its question; put it back.
        progress.dispose()
        progress = mountProgress(container)
      }
      const result = await scrapeListing({
        pageCount: budget.pages,
        pageUrl: source.pageUrl,
        blurbSelector: source.blurbSelector,
        firstPageDoc: source.firstPageDoc?.(),
        satisfied: source.satisfied,
        onProgress: progress.onProgress,
        signal: own.signal,
      })
      if (stale())
        return
      const completed = result.blocked
        ? { works: selected(source, result.works), blocked: true }
        : await complete(source, selected(source, result.works), { signal: own.signal, full: true, onProgress: progress.onRecover })
      if (stale())
        return
      const works = applyLimit(renumber(completed.works), budget.limit)
      // Not persisted when the archive refused us outright: an empty scrape
      // would otherwise overwrite a perfectly good stored list with nothing,
      // and "AO3 said no" is not news about what is on the reader's list.
      if (!result.blocked || works.length)
        await persist(source, works, { listing: result.works })
      if (stale())
        return
      if (!works.length) {
        // Two different things, and telling them apart matters: an empty list is
        // a fact about the reader, a refusal is a fact about this minute.
        toast(result.blocked ? RATE_LIMITED : source.emptyMessage, { type: 'error' })
        closeSearchView()
        return
      }
      fresh = true
      show(works, Date.now())
      // A scrape that stopped because it had found everything it came for is not
      // a scrape that fell short.
      if (completed.blocked && !result.blocked) {
        toast('AO3 asked us to slow down before every work could be fetched. The rest will be tried again next time.', { type: 'error' })
      }
      else if (!result.satisfied && result.loadedPages < result.totalPages) {
        toast(result.blocked
          ? `AO3 asked us to slow down — only ${result.loadedPages} of ${result.totalPages} pages loaded. Refresh in a few minutes for the rest.`
          : `Loaded ${result.loadedPages} of ${result.totalPages} pages — some couldn't be fetched.`, { type: 'error' })
      }
    }
    catch (err) {
      // Replaced while it loaded: the abort is the replacement's doing, and the
      // view on screen now is not this one's to close.
      if (stale())
        return
      if ((err as Error)?.name !== 'AbortError') {
        log.error(`Failed to load ${source.id}`, err)
        // Counting the listing's pages is a request of its own for some sources
        // ({@link SearchSource.pageCount}), so it can be refused before the
        // scrape has fetched anything at all — which is not the source being
        // unreachable, and should not be reported as though it were.
        toast(isArchiveBusy(err) ? RATE_LIMITED : source.errorMessage, { type: 'error' })
      }
      closeSearchView()
    }
    finally {
      progress.dispose()
      if (controller === own)
        controller = null
    }
  }
  finally {
    if (!stale())
      busy = false
  }
}
