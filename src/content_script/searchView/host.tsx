import type { Options, SnapshotDescriptor } from '#common'
import type { Work } from '#content_script/blurb.js'

import { ADDON_CLASS, logger, toast } from '#common'
import { watchWaitLine } from '#content_script/archiveFetch.js'
import { hasNode } from '#content_script/blurb.js'
import { pruneDetachedTriggers } from '#content_script/contextTrigger.js'
import { extensionAlive } from '#content_script/extensionAlive.js'
import { PAGE_RUN } from '#content_script/pageRun.ts'
import { recordRuleTiming } from '#content_script/ruleTiming.ts'
import { refreshFilterToolbar } from '#content_script/units/FilterToolbar.tsx'
import React from '#dom'

import type { CachedSnapshot } from './cache.ts'
import type { FacetValueRef, FilterState } from './engine.ts'
import type { Handover, OnPage } from './handover.ts'
import type { ListRefresh, RefreshOutcome } from './listRefresh.ts'
import type { SearchViewPrefs } from './prefs.ts'
import type { Hold } from './refreshClaim.ts'
import type { ScrapeResult } from './scrape.ts'
import type { DeferredUpdate, SearchView, SearchViewConfig, ViewState } from './view.tsx'
import type { Recovered, RecoverOptions } from './workPageBlurb.tsx'

import { pristineBlurb, readSnapshot, snapshotSize, takeFromSnapshot, writeSnapshot } from './cache.ts'
import { cx, HOST, NATIVE_HIDDEN_CLASS } from './classes.ts'
import { collapseWork, decorateBlurb, decorateContainer, makeFacetHider } from './decorate.ts'
import { isFresh } from './freshness.ts'
import { onClaim, onClose, onOpen, onRelease, onRunEnd, onSuspend } from './handover.ts'
import { applyHidden } from './hidden.ts'
import { followState, sharesRefresh, updatingNote } from './listRefresh.ts'
import { mergeRefresh } from './partials.ts'
import { loadPrefs, savePrefs } from './prefs.ts'
import { acquireRefresh, requestCancel, watchRefresh } from './refreshClaim.ts'
import { isArchiveBusy, MAX_SCANNED_PAGES, scrapeListing } from './scrape.ts'
import { createSearchView } from './view.tsx'

/**
 * The plumbing every place that offers the in-memory search view needs: mount a
 * container, render the cached snapshot instantly (or scrape behind a progress
 * bar until the first pages are in, when there is none), refresh in the
 * background, and put the native page back on "Back to list". Everything
 * page-specific lives in a {@link SearchSource}.
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
   * rather than at the next reload. A view is reopened on every options change,
   * and each reopen asks this again, which is what makes that immediate.
   *
   * A source that sets it keeps its side records ({@link onPersist}) in step with
   * the *listing*, not with the pruned list — only a scrape has that, so only a
   * scrape calls `onPersist`. A work pruned here is exactly the kind of thing
   * those records exist to remember.
   */
  belongs?: (work: Work) => boolean
  /**
   * Hear of works leaving the list while its view is on screen, so the view
   * lets each one go the moment it leaves rather than at the next reload — the
   * Marked for Later list's works, marked read from their own menus. Handed
   * how to drop one; returns how to stop, which the host does when the view
   * goes.
   */
  leaving?: (drop: (workId: string) => void) => () => void
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
  /**
   * Produce this source's works some other way than by reading one listing page
   * by page. Set, it replaces the whole scrape — the budget, the pages, the
   * limit gate, the recovery — on the first load and on every refresh alike, so
   * {@link pageCount}, {@link pageUrl}, {@link select}, {@link satisfied} and
   * {@link recover} have nothing left to say and should be left off.
   *
   * For a view whose works aren't a listing at all: several saved queries read
   * over a date range and merged into one stream, where "which page of which
   * listing" has no single answer. Hence the free-text progress line rather than
   * the page counter — and hence no works ceiling applied afterwards either: the
   * limit exists to stop an open-ended listing being fetched forever, and a
   * source that decides for itself how much to read has already answered that.
   * Trimming its answer would take works out of a range it means to be complete.
   *
   * `full` distinguishes the reader asking from an automatic reload, exactly as
   * it does for {@link recover}. `blocked` means AO3 refused partway and what
   * came back is not to be trusted: the stored copy stays, on screen and on
   * disk. {@link belongs} still applies to what comes out.
   */
  load?: (opts: LoadOptions) => Promise<LoadResult>
  /**
   * Build a strip of this source's own controls, mounted above the view's
   * toolbar on every open and taken down with it.
   *
   * For a source whose view needs more than filtering: something with a range to
   * move, a total to report, an action that changes what the list even is. `ctl`
   * is the view seen from outside — enough to put a new set of works on screen,
   * to say that something is loading, and to ask for a reload — so the strip can
   * do its work without the source reaching into the host.
   */
  header?: (ctl: SearchHeaderControl) => HTMLElement
  /** The native elements hidden while the view is up, restored when it closes. */
  nativeElements: () => Iterable<Element>
  /**
   * The view *is* this page rather than something opened on top of it, so it
   * gets no "Back to list" button: there is no native list the reader is meant
   * to go back to. The Marked for Later page is one — its own AO3 listing is
   * replaced outright.
   */
  replacesListing?: boolean
  /**
   * Show every work this list holds, whatever the reader's hiding says about it:
   * no rule hides or collapses one, no mark does, and neither do the crossover
   * and language filters. The view's own facets are then the only thing that
   * narrows it.
   *
   * For the lists the reader built themselves — Marked for Later, the works they
   * have marked read. Hiding earns its keep on a listing *AO3* chose: a tag
   * search, a series, a fandom's newest, where the reader is being shown works
   * they never asked for one at a time. On a list they assembled work by work
   * it has nothing left to do — they already said yes to each of these — and
   * quietly dropping one for carrying a tag they usually skip only makes their
   * own list lie about its length.
   *
   * It follows that `autoExcludeHidden` has nothing to hand over here either
   * (see {@link file://./hidden.ts}): an exclusion takes the work off the list
   * exactly as hiding it would, and leaves a facet row ticked to say so.
   */
  hidesNothing?: boolean
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
   * Measured from the snapshot's `scrapedAt`, which only a real scrape moves,
   * and only for a snapshot read from the listing this source reads now: its
   * descriptor's `listUrl` and date filter ({@link isFresh}). The view's
   * Refresh button ignores it, as does a view opened with no stored copy at all.
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

/** What the host tells a {@link SearchSource.load} about the load it wants. */
export interface LoadOptions {
  /**
   * Aborted when the view is closed, another list is opened in its place, or
   * the list is refreshed again. A global re-run that takes the view down and
   * puts it back leaves it going.
   */
  signal: AbortSignal
  /**
   * Say what is being done and how far along it is. The text is the whole
   * progress line, because the page counter the scrape shows ("Loaded 3 of 8
   * pages") asks a question a merged load has no one answer to. `total` of 0
   * leaves the bar where it is, for a step whose length isn't known yet.
   *
   * Only wired up for the load a reader is waiting on. A background reload has
   * no panel to write to — its progress belongs in the source's own
   * {@link SearchSource.header}, which is still on screen.
   */
  onProgress: (text: string, done: number, total: number) => void
  /** False for an automatic reload, as in {@link SearchSource.recover}. */
  full: boolean
  /**
   * Whether what this load brings back goes on screen the moment it is done.
   *
   * False only for a background reload of a view holding its page layout
   * ({@link SearchViewConfig.stablePages}), which offers the new works instead
   * of springing them on a reader part-way through the pages. A source whose
   * {@link SearchSource.header} describes the list it just loaded has to hold
   * that description back for exactly as long: the reader is still looking at
   * the works it replaces. A reload the reader asked for is applied at once and
   * says so here.
   */
  applied: boolean
}

/** What a {@link SearchSource.load} comes back with. */
export interface LoadResult {
  /** The works, in the order the view should list them. */
  works: Work[]
  /**
   * AO3 refused before the load was finished, so this is not an answer about
   * what the list holds. The stored copy is kept instead — see the refusal
   * handling in {@link refresh}.
   */
  blocked: boolean
}

/**
 * The view, as a {@link SearchSource.header} sees it. Every method is a no-op
 * once the view this control belongs to has been replaced, so a strip that
 * outlives an abort can't write into someone else's view.
 */
export interface SearchHeaderControl {
  /**
   * Put `works` on screen in place of what the view holds: the host's own
   * preparation (statuses, the hide pass), the snapshot write, and the swap.
   * Unlike a background reload this is not deferred — the source is saying the
   * list *is* this now.
   */
  show: (works: Work[]) => void
  /** Toggle the view's "updating in the background" indicator. */
  setUpdating: (on: boolean) => void
  /** Reload from the source, exactly as the view's own Refresh button does. */
  refresh: () => void
  /**
   * Ask to hear about a reload a {@link SearchViewConfig.stablePages} view
   * declined to swap in, so the strip can offer it instead of the reader losing
   * their place. One listener; `null` stops listening, and while there is none
   * such a reload simply goes in.
   */
  onUpdateDeferred: (listener: ((update: DeferredUpdate) => void) | null) => void
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
 * The works a {@link SearchSource.load} produced, less any the source says no
 * longer belong. {@link SearchSource.select} has nothing to do here — a load
 * chose its own works rather than picking them out of a listing — but
 * {@link SearchSource.belongs} is about what the reader has done since, which a
 * load knows no more about than a scrape does.
 */
function belonging(source: SearchSource, works: Work[]): Work[] {
  return source.belongs ? works.filter(source.belongs) : works
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

/**
 * The view on screen, with what a re-run needs to put it straight back: when its
 * works were last fetched, and the layout prefs it is drawn with (kept in step
 * with every change the reader makes to them).
 */
let active: { source: SearchSource, view: SearchView, scrapedAt: number, prefs: Partial<SearchViewPrefs> } | null = null
/**
 * The source whose container is in the page, from the moment it is mounted —
 * which is before {@link active}, while a scrape is still running — so a close
 * at any point can hand it {@link SearchSource.unmount}.
 */
let mounted: SearchSource | null = null
/** How to stop hearing the {@link active} source's {@link SearchSource.leaving}. */
let stopLeaving: (() => void) | null = null
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
 * What the view on screen knows of its list's refresh, for a list that shares
 * its refresh between pages ({@link sharesRefresh}); null for any other.
 */
interface SharedRefresh {
  view: SearchView
  /** Stops watching the list's claim, with the view. */
  watching: AbortController
  /** When the view began following the list's claim: a refresh another page stores after that is news. */
  since: number
  /**
   * This view wanted a refresh and found another page's under way, or lost its
   * own claim to one: it refreshes the list itself should that page drop it,
   * as the reader asked (`force`, the Refresh button) or not.
   */
  waiting: { force: boolean } | null
  /** This view's own refresh, while it holds one. */
  hold: Hold | null
  /** The note is showing another page's refresh. */
  following: boolean
  /** Look at the list's claim again now: once this view's own refresh is over, which it ignores the claim during. */
  recheck: () => void
}
let shared: SharedRefresh | null = null

/**
 * A load of a list under way behind its view, held by the host rather than by
 * the view, so that a global re-run — every mark click is one — takes the view
 * down without stopping it. The view put back attaches to it and hears the rest;
 * until then it goes on with no view, and still stores what it read. A refresh
 * is one, and so is the rest of a first walk once its first pages are on screen.
 * {@link closeSearchView} stops it.
 */
interface LoadJob {
  readonly cacheKey: string
  readonly controller: AbortController
  /** The source and options of the open the job last fed: a reopen brings its own, which the rest of the load answers to. */
  source: SearchSource
  options: Options
  /** The view it feeds; null while a re-run has the view down. */
  view: SearchView | null
  /** This page's claim on the list's refresh, while it holds one ({@link sharesRefresh}). */
  hold: Hold | null
  /** Draw the job's *Updating…* note on its view. */
  draw: () => void
  /**
   * The works it last gave its view, or would have, with no view attached, and
   * when they were fetched: what a view put back shows when it carries nothing
   * newer. Null until it has any.
   */
  latest: { works: Work[], at: number } | null
  /** It finished while no view was attached: {@link latest} is its result, for the view put back to show. */
  ended: boolean
}

/** The {@link LoadJob}s under way, by list. */
const jobs = new Map<string, LoadJob>()

function stopJob(job: LoadJob): void {
  job.controller.abort()
  if (jobs.get(job.cacheKey) === job)
    jobs.delete(job.cacheKey)
}

/** Stop every load under way, but `keep`'s. */
function stopJobs(keep?: string): void {
  for (const job of [...jobs.values()]) {
    if (job.cacheKey !== keep)
      stopJob(job)
  }
}

/** What the view on screen knows of the refresh `job` runs, when it is that view's. */
function sharedOf(job: LoadJob): SharedRefresh | null {
  return job.view && shared?.view === job.view ? shared : null
}

/** Feed `job` into `view`, the view a reopen has just drawn of its list. */
function attach(job: LoadJob, source: SearchSource, view: SearchView, options: Options): void {
  job.source = source
  job.options = options
  job.view = view
  const share = sharedOf(job)
  if (share && job.hold)
    share.hold = job.hold
  job.draw()
}

/** Give `job`'s view the works loaded so far, which it grows into ({@link SearchView.grow}). */
function feed(job: LoadJob, works: Work[]): void {
  job.latest = { works, at: job.latest?.at ?? Date.now() }
  job.view?.grow(works, prepare(job.source, works, job.options, true))
}

/** Give a first walk's view the listing as far as it has landed, chosen and capped as the whole will be. */
function feedWalk(job: LoadJob, listing: Work[], limit: number): void {
  feed(job, applyLimit(renumber(selected(job.source, listing)), limit))
}

/**
 * Put what `job` finished with on its view, or keep it for the view put back
 * when a re-run has the view down. A load that has been feeding the view grows
 * it into the result; `force` as for {@link SearchView.update} otherwise.
 * `at` is when the works count as read: now, unless said otherwise.
 */
function land(job: LoadJob, works: Work[], how: { grow?: boolean, force?: boolean, at?: number } = {}): void {
  const now = how.at ?? Date.now()
  job.latest = { works, at: now }
  const { view } = job
  if (!view) {
    job.ended = true
    return
  }
  const autoExcludes = prepare(job.source, works, job.options, true)
  if (how.grow)
    view.grow(works, autoExcludes)
  else
    view.update(works, autoExcludes, { force: how.force })
  view.setRefreshedAt(now)
  if (active?.view === view)
    active.scrapedAt = now
}
/**
 * An open view a global re-run took down, with everything needed to put it back
 * as it was — without going back to storage for any of it.
 *
 * Every options change re-runs the page, and most of them are one mark on one
 * work: something the stored list has nothing new to say about. Reopening from
 * the snapshot meant reading every list the reader has ever stored and parsing
 * every blurb in this one again, while the list was off the screen. Its works are
 * still in memory, so they come back from there: the reopen starts and finishes
 * inside the re-run that closed it, and the list is never seen to leave.
 */
interface Reopen {
  cacheKey: string
  state: ViewState
  works: Work[]
  scrapedAt: number
  prefs: Partial<SearchViewPrefs>
  /** Where the reader was on the page, for a document that briefly got shorter. */
  scrollY: number
}

/**
 * A view on its way to the screen: from the moment its container goes into the
 * page until its view is drawn there, or it closes. A first open of a list
 * spends most of that walking the listing, which can take minutes, and a global
 * re-run in the middle hands it over whole rather than closing it — walk,
 * progress panel and all — for the re-run's own open of the list to take back
 * ({@link file://./handover.ts}).
 */
interface Opening {
  cacheKey: string
  /** What it was opened with, which the open that takes it back is given too. */
  opts: OpenOptions
  /** The view's container, holding the walk's progress, or its limit gate. */
  container: HTMLElement
  /** The walk of its listing, once it has had to start one. */
  walk: Walk | null
  /**
   * Settles when the opening is over: its view drawn, or closed, by whichever
   * open has it by then, or stopped. An open that has handed its opening over
   * waits for this, so that it settles when its view does.
   */
  done: Promise<void>
  end: () => void
}

function newOpening(cacheKey: string, opts: OpenOptions, container: HTMLElement): Opening {
  let end = (): void => {}
  const done = new Promise<void>((resolve) => {
    end = resolve
  })
  return { cacheKey, opts, container, walk: null, done, end }
}

/** The opening in the page, from its mount until it shows or closes. */
let current: Opening | null = null
/**
 * What the last global re-run took down and no unit has taken back yet: a view
 * to put back where the reader left it, or an opening still under way. Cleared
 * by {@link closeSearchView}, so a close the reader asked for (Back) stays
 * closed.
 */
let handover: Handover<Reopen, Opening> | null = null
/**
 * A view its unit has claimed from the {@link handover}, waiting for the
 * {@link openSearchView} the claim leads to. Matched to it by the very state
 * object the claim handed out, so nothing but that open can pick it up.
 */
let claimed: Reopen | null = null

/** Whether a view is currently mounted (by this host, for any source). */
export function isSearchViewOpen(): boolean {
  return document.querySelector(`.${HOST}`) !== null
}

/**
 * Whether the view for `cacheKey` is on its way to the screen: an open of it has
 * started and not yet finished. A caller whose own open has just returned can
 * tell from this whether a newer one has taken over: two runs of the page that
 * overlap can each open the same list.
 */
export function isOpening(cacheKey: string): boolean {
  return busy && mounted?.cacheKey === cacheKey
}

/**
 * The view on screen, as something a page can be tracked by: what it is a view
 * of (its source's {@link SnapshotDescriptor}, whose `listUrl` is the listing
 * it stands in for) and the filter the reader has set on it
 * ({@link SearchView.getReaderFilter}). Null while no view is drawn.
 *
 * Whether the view is *this page's* — the listing the page is, rather than a
 * list the page merely offers, like Marked for Later on a readings page — is the
 * caller's to judge from the descriptor.
 */
export function activeSearchFilter(): { descriptor: SnapshotDescriptor, filter: FilterState } | null {
  if (!active || !active.view.el.isConnected)
    return null
  return { descriptor: active.source.descriptor(), filter: active.view.getReaderFilter() }
}

/** End an opening for good: stop its walk, and let whatever waits on it settle. */
function stopOpening(opening: Opening): void {
  opening.walk?.controller.abort()
  opening.end()
}

/** Restore the native page: abort any scrape, remove the view, un-hide the list. */
export function closeSearchView(): void {
  stopJobs()
  takeDown()
}

/** Everything {@link closeSearchView} does but stop the loads under way. */
function takeDown(): void {
  generation++
  controller?.abort()
  controller = null
  shared?.watching.abort()
  shared = null
  active = null
  stopLeaving?.()
  stopLeaving = null
  busy = false
  // A close means "don't come back" unless the caller re-arms a reopen after,
  // and an opening a re-run took down is over with it.
  const { stopped } = onClose(handover)
  handover = null
  if (stopped)
    stopOpening(stopped)
  if (current)
    stopOpening(current)
  current = null
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

/** Hand what a re-run took down over ({@link file://./handover.ts}), stopping an opening it replaces. */
function handOver(page: OnPage<Reopen, Opening>): void {
  const next = onSuspend(handover, page)
  handover = next.handover
  if (next.stopped)
    stopOpening(next.stopped)
}

/**
 * Take the view down for a global re-run, handing it over for the unit's next
 * `ready()` to take back ({@link resumeSearchView}). A view on screen is closed,
 * and remembered as the reader left it. A view still opening is not closed: its
 * walk carries on off the page, the native listing stays hidden behind it, and
 * the open that was bringing it up leaves it to whichever open takes it back.
 * A load under way behind a view carries on without it ({@link LoadJob}).
 * For a unit's static `clean()`, which runs on every global re-run.
 */
export function suspendSearchView(): void {
  // Every unit's clean() runs on a re-run, so this is called once per search-view
  // unit. Only the one that had a view up has anything to suspend; the rest must
  // leave what is already handed over alone.
  if (active) {
    const { source, view, scrapedAt, prefs } = active
    const snapshot: Reopen = {
      cacheKey: source.cacheKey,
      state: view.getState(),
      works: view.getWorks(),
      scrapedAt,
      prefs,
      scrollY: window.scrollY,
    }
    for (const job of jobs.values())
      job.view = null
    takeDown()
    handOver({ view: { cacheKey: source.cacheKey, view: snapshot } })
    return
  }
  const opening = current
  if (!opening)
    return
  generation++
  busy = false
  controller = null
  current = null
  opening.container.remove()
  const was = mounted
  mounted = null
  was?.unmount?.()
  handOver({ opening: { cacheKey: opening.cacheKey, opening } })
}

/**
 * Put back what a global re-run took down of `cacheKey`'s view, through `open`,
 * the unit's own way of opening it: a view, where the reader left it, or one
 * still opening, as far as it had got — its walk is not started again. False
 * when the re-run took down nothing of this list's.
 *
 * For a unit's `ready()`, which has to call this as it runs rather than after
 * anything it awaits: an opening no unit has claimed by the end of the re-run
 * is stopped ({@link settleSearchView}). One whose `open` gives up before
 * taking it back is stopped then.
 */
export function resumeSearchView(cacheKey: string, open: (opts: OpenOptions) => Promise<void>): boolean {
  const next = onClaim(handover, cacheKey)
  handover = next.handover
  const taken = next.claimed
  if (!taken)
    return false
  if (taken.kind === 'view') {
    claimed = taken.view
    void open({ initialState: taken.view.state, refresh: false })
  }
  else {
    void open(taken.opening.opts).finally(() => {
      const released = onRelease(handover, cacheKey)
      handover = released.handover
      if (released.stopped) {
        stopOpening(released.stopped)
        closeSearchView()
      }
    })
  }
  return true
}

/**
 * The end of a global re-run, every unit ready: an opening the re-run took down
 * that no unit claimed — its feature switched off by the change, say — is
 * stopped, and the native page put back; so is the load under way behind a
 * view the re-run took down that no unit put back. For the content script,
 * after every run of the page.
 */
export function settleSearchView(): void {
  const next = onRunEnd(handover)
  handover = next.handover
  if (next.stopped) {
    stopOpening(next.stopped)
    closeSearchView()
  }
  const job = handover?.kind === 'view' ? jobs.get(handover.cacheKey) : undefined
  if (job && !job.view)
    stopJob(job)
}

/** The claimed reopen this open was handed, if it is one. One-shot, like the claim. */
function takeClaimed(source: SearchSource, opts: OpenOptions): Reopen | null {
  const carried = claimed
  claimed = null
  return carried && carried.cacheKey === source.cacheKey && carried.state === opts.initialState ? carried : null
}

/**
 * A reopened view's works, ready to be shown again: the same parsed works, with
 * everything the last view and its decorations did to their blurbs taken off, as
 * a stored copy's would be. The new view decorates them under today's options.
 */
function undecorated(works: Work[]): Work[] {
  // A work whose node was never built was never decorated either.
  for (const work of works) {
    if (hasNode(work))
      pristineBlurb(work.el, { inPlace: true })
  }
  return works
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
  return applyHidden(works, options, { hidesNothing: source.hidesNothing, log: log.log, timed: recordRuleTiming })
}

/**
 * Write the blurb snapshot of a read just made, plus whatever else the source
 * keeps in step with it. `readAt` dates the copy instead of now, for a read
 * that fell short of the whole list.
 */
async function persist(source: SearchSource, works: Work[], opts: { listing?: Work[], readAt?: number } = {}): Promise<void> {
  await writeSnapshot(source.cacheKey, works, source.descriptor(), { scrapedAt: opts.readAt })
  // A pruned list says nothing about what the listing holds; see `belongs`.
  if (!source.belongs || opts.listing)
    await source.onPersist?.(opts.listing ?? works)
}

/**
 * Take works the reader has taken off the view off its stored copy too. No
 * read, so the copy keeps saying which read it is, and is trusted no more than
 * it was: an open reading the listing again behind it may not get to write that
 * read before the page is left.
 */
function takeOff(source: SearchSource, works: Work[]): void {
  void takeFromSnapshot(source.cacheKey, works.map(work => work.workId))
    .catch(err => log.error(`Failed to take works off the stored copy of ${source.id}`, err))
}

/**
 * Hide the source's native listing and insert a view container for it: an
 * empty one, or the container of an opening a re-run handed over, which puts
 * that opening's progress back where it was.
 */
function mountContainer(source: SearchSource, existing?: HTMLElement): HTMLElement {
  for (const el of source.nativeElements())
    el.classList.add(NATIVE_HIDDEN_CLASS)
  const container = existing ?? (<div class={`${ADDON_CLASS}  ${HOST}  ${ADDON_CLASS}--${source.id}`} />) as HTMLElement
  mounted = source
  source.mount(container)
  return container
}

interface ProgressPanel {
  onProgress: (done: number, total: number) => void
  /** Fetching works one page each, after the listing (see `SearchSource.recover`). */
  onRecover: (done: number, total: number) => void
  /**
   * A load that says in its own words what it is doing (see
   * {@link LoadOptions.onProgress}), because the page counter above assumes one
   * listing being read from the front.
   */
  onLoad: (text: string, done: number, total: number) => void
  /** What the panel says now: the pause being sat out, or how far the load has got. */
  text: () => string
  /** Hear every change to {@link text} (null: stop): once the view has taken the panel's place, its note says it instead. */
  listen: (listener: (() => void) | null) => void
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
  let waitText: string | null = null
  let listener: (() => void) | null = null

  const draw = (): void => {
    label.textContent = waitText ?? progressText
    listener?.()
  }

  const progress: ProgressPanel = {
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
    onLoad: (text, done, total) => {
      progressText = text
      // A step of unknown length leaves the bar where it was rather than
      // snapping it back to nothing: the work already done wasn't undone.
      if (total > 0)
        fill.style.width = `${Math.round((Math.min(done, total) / total) * 100)}%`
      draw()
    },
    text: () => waitText ?? progressText,
    listen: (next) => {
      listener = next
    },
    dispose: () => {},
  }
  // The pause is held for the whole pool, so one subscription says it once
  // rather than once per worker sitting inside it.
  progress.dispose = watchWaitLine((line) => {
    waitText = line
    draw()
  })
  return progress
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
 * A first walk of a source's listing, or its own {@link SearchSource.load}: what
 * an open with no stored copy has to do before there is anything to show. It
 * runs apart from the open that started it, so that a global re-run can hand it
 * to another open rather than lose it ({@link file://./handover.ts}). The open
 * that has it draws the view once the listing's first pages are in, and a
 * {@link LoadJob} takes the rest of the walk on from there; a walk over before
 * then (a source's own load, a refusal, a listing with nothing worth showing
 * until its end) is the open's to finish.
 */
interface Walk {
  controller: AbortController
  outcome: Promise<WalkOutcome>
  /** The progress panel the walk keeps up to date: the one put back after the limit gate, if it asked. */
  progress: ProgressPanel
  /**
   * The listing as it has landed so far from page 1 on, once it holds a work
   * the source means to show ({@link SearchSource.select}), and the works
   * ceiling it is read under.
   */
  partial: { works: Work[], limit: number } | null
  /** Settles once there is a {@link partial} to show, or the walk is over. */
  first: Promise<void>
  ended: boolean
  /** The load that has taken the walk on, once its view is up. */
  job: LoadJob | null
}

/**
 * How a walk ended: with a source's own load, or a scrape of its listing; or
 * `stopped` short of either, the reader having backed out at the limit gate,
 * or the walk having been cancelled or stopped.
 */
type WalkOutcome
  = | { kind: 'loaded', loaded: LoadResult }
    | { kind: 'scraped', budget: Budget, result: ScrapeResult, completed: { works: Work[], blocked: boolean } }
    | { kind: 'stopped' }
    | { kind: 'failed', err: unknown }

/**
 * Start walking `source` behind a progress panel in `container`. A listing too
 * big for the reader's ceiling gets a say-so first — it's their request being
 * narrowed, not ours.
 */
function startWalk(source: SearchSource, options: Options, container: HTMLElement): Walk {
  let show = (): void => {}
  const walking: Omit<Walk, 'outcome'> = {
    controller: new AbortController(),
    // Counting the listing's pages can itself be a request (see
    // `SearchSource.pageCount`), so the progress panel — and its Cancel button
    // — goes up before the count rather than after it.
    progress: mountProgress(container),
    partial: null,
    first: new Promise<void>((resolve) => {
      show = resolve
    }),
    ended: false,
    job: null,
  }
  const outcome = walk(source, options, container, walking, show).finally(() => {
    walking.ended = true
    show()
  })
  return Object.assign(walking, { outcome })
}

async function walk(source: SearchSource, options: Options, container: HTMLElement, w: Omit<Walk, 'outcome'>, show: () => void): Promise<WalkOutcome> {
  const { signal } = w.controller
  try {
    if (source.load) {
      // A source that produces its own works has no listing to budget, no
      // pages to count and nothing for the limit gate to ask about — it has
      // already decided how much to read.
      // `applied`: there is nothing on screen yet for these works to
      // interrupt, so the view they open is the works they brought.
      return { kind: 'loaded', loaded: await source.load({ signal, onProgress: w.progress.onLoad, full: true, applied: true }) }
    }
    const budget = await budgetFor(source, options)
    if (signal.aborted)
      return { kind: 'stopped' }
    // No gate for a source that selects: what the gate asks about is loading
    // the first N of a listing instead of all of it, and for a haystack that
    // is neither what is being loaded nor what the reader would get. Its page
    // cap and `satisfied` bound the reading instead, and the progress panel's
    // Cancel is the say-so.
    if (isTruncated(budget) && !source.select) {
      if (!await mountLimitGate(container, source, budget, signal))
        return { kind: 'stopped' }
      // The gate replaced the progress panel with its question; put it back.
      w.progress.dispose()
      w.progress = mountProgress(container)
    }
    const { progress } = w
    const result = await scrapeListing({
      pageCount: budget.pages,
      pageUrl: source.pageUrl,
      blurbSelector: source.blurbSelector,
      firstPageDoc: source.firstPageDoc?.(),
      satisfied: source.satisfied,
      onProgress: progress.onProgress,
      onPartial: (works) => {
        if (w.job) {
          feedWalk(w.job, works, budget.limit)
          return
        }
        // An empty view would say the list holds nothing, which only its end
        // can say.
        if (!selected(source, works).length)
          return
        w.partial = { works, limit: budget.limit }
        show()
      },
      signal,
    })
    if (signal.aborted)
      return { kind: 'stopped' }
    const completed = result.blocked
      ? { works: selected(source, result.works), blocked: true }
      : await complete(source, selected(source, result.works), { signal, full: true, onProgress: progress.onRecover })
    return { kind: 'scraped', budget, result, completed }
  }
  catch (err) {
    return { kind: 'failed', err }
  }
  finally {
    w.progress.dispose()
  }
}

/** A load that failed: say so, unless it was only stopped, and put the native page back. */
function failLoad(source: SearchSource, err: unknown): void {
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

/** Store the list a first walk read, with the side records the source keeps in step with its listing. */
async function persistWalk(source: SearchSource, works: Work[], result: ScrapeResult): Promise<void> {
  // Not persisted when the archive refused us outright: an empty scrape
  // would otherwise overwrite a perfectly good stored list with nothing,
  // and "AO3 said no" is not news about what is on the reader's list.
  if (!result.blocked || works.length)
    await persist(source, works, { listing: result.works })
}

/** Whether a first walk came back with nothing to show, in which case it says why and closes the view. */
function closedEmpty(source: SearchSource, works: Work[], result: ScrapeResult): boolean {
  if (works.length)
    return false
  // Two different things, and telling them apart matters: an empty list is
  // a fact about the reader, a refusal is a fact about this minute.
  toast(result.blocked ? RATE_LIMITED : source.emptyMessage, { type: 'error' })
  closeSearchView()
  return true
}

/** Tell the reader a first walk fell short of the whole listing, and why. */
function shortfallToast(result: ScrapeResult, completed: { blocked: boolean }): void {
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

/**
 * The rest of a first walk whose view went up with its first pages: grow the
 * view into the whole list, store it, and say how it went — whether or not a
 * view is attached by then. A walk stopped on the way stores nothing.
 */
async function finishWalk(job: LoadJob, walked: Walk): Promise<void> {
  const outcome = await walked.outcome
  const current = (): boolean => jobs.get(job.cacheKey) === job
  if (!current())
    return
  walked.progress.listen(null)
  try {
    if (outcome.kind !== 'scraped') {
      if (outcome.kind === 'failed')
        failLoad(job.source, outcome.err)
      else
        closeSearchView()
      return
    }
    const { result, completed } = outcome
    // As the view now on screen was opened: a re-run may have marked works
    // since, or brought a new ceiling.
    const works = applyLimit(renumber(belonging(job.source, completed.works)), limitFor(job.options))
    await persistWalk(job.source, works, result)
    if (!current() || closedEmpty(job.source, works, result))
      return
    land(job, works, { grow: true })
    if (!job.ended)
      jobs.delete(job.cacheKey)
    if (job.view) {
      job.view.setUpdating(false)
      followShared(job.source, job.view, job.options, Date.now())
    }
    shortfallToast(result, completed)
  }
  catch (err) {
    if (current())
      failLoad(job.source, err)
  }
}

/**
 * The background half of {@link SearchSource.load}: ask the source for the list
 * again and feed the answer into the live view and the cache.
 *
 * The same two refusals the scrape path makes, for the same reasons. A load that
 * was cut short says nothing about what the list holds, so the stored copy is
 * left alone — on screen and on disk — rather than being written over with
 * whatever arrived before AO3 stopped answering. And a load that comes back
 * empty over a list that *has* a stored copy is treated the same way: dropping
 * every work, every side record and every cached blurb on one bad minute is not
 * recoverable, and keeping yesterday's copy up always is.
 *
 * Whether the fresh works reach the screen is the view's decision, not this
 * one's: a view holding its page layout hands them to the source to offer
 * instead (see {@link SearchViewConfig.stablePages}). They are written and
 * timestamped either way, because they were fetched either way — the next open
 * should show them without asking again. `force` is the one exception, and
 * means the reader pressed Refresh: they are waiting for this list, so it goes
 * in rather than being offered back to them.
 */
async function reload(job: LoadJob, full: boolean, force: boolean): Promise<void> {
  const { signal } = job.controller
  const applied = force || job.source.viewConfig?.stablePages !== true
  const loaded = await job.source.load!({ signal, onProgress: () => {}, full, applied })
  if (signal.aborted)
    return
  if (loaded.blocked) {
    toast(`AO3 asked us to slow down, so the list wasn't refreshed. It is still showing what was stored. Try again in a few minutes.`, { type: 'error' })
    return
  }
  const works = renumber(belonging(job.source, loaded.works))
  if (works.length === 0 && await snapshotSize(job.cacheKey) > 0) {
    toast(`This list came back with no works in it, so it wasn't refreshed. It is still showing what was stored.`, { type: 'error' })
    return
  }
  if (signal.aborted)
    return
  await persist(job.source, works)
  land(job, works, { force })
}

/**
 * Re-scrape in the background and feed the result into the live view + cache.
 * With `topUp`, only look for what the stored works lack, and add it to them.
 *
 * `force` says the reader pressed Refresh. It only matters to a view holding
 * its page layout, which otherwise offers a reload rather than swapping it in —
 * right for one that arrives on its own, and wrong for the button the reader is
 * waiting on, which would answer them with a second thing to click.
 */
async function refresh(
  source: SearchSource,
  view: SearchView,
  options: Options,
  topUp?: { plan: TopUp, stored: Work[] },
  force = false,
): Promise<void> {
  const previous = jobs.get(source.cacheKey)
  if (previous)
    stopJob(previous)
  const own = new AbortController()
  // The list stays on screen while this runs, so a pause is all there is to
  // say — and minutes of a bare "Updating…" would read as hung.
  let line: string | null = null
  const job: LoadJob = {
    cacheKey: source.cacheKey,
    controller: own,
    source,
    options,
    view,
    hold: null,
    draw: () => {
      const { view: on, hold } = job
      if (!on)
        return
      if (hold)
        on.setUpdating(true, { text: updatingNote(hold.claim, Date.now()), onStop: hold.cancel })
      else
        on.setUpdating(true, { text: line && `Updating… ${line}` })
    },
    latest: null,
    ended: false,
  }
  jobs.set(source.cacheKey, job)
  const current = (): boolean => jobs.get(source.cacheKey) === job
  // A list another page may be refreshing is refreshed by one page at a time:
  // this view follows that one's instead ({@link followShared}).
  const share = sharedOf(job)
  if (share) {
    const acquired = await acquireRefresh(source.cacheKey, {
      holder: 'page',
      onCancel: () => own.abort(),
      onLost: (leaving) => {
        // A newer refresh of this page's own took it over: that one is the wait.
        const waiting = current() && !leaving ? sharedOf(job) : null
        if (waiting)
          waiting.waiting = { force }
        own.abort()
      },
      onChange: () => job.draw(),
    })
    // A re-run may have put another view in this one's place while the claim
    // was being made: what is known of the refresh is that view's now.
    const sharing = sharedOf(job)
    if (acquired.kind === 'follow' || own.signal.aborted) {
      if (acquired.kind === 'hold')
        await acquired.hold.release('dropped')
      else if (!own.signal.aborted && sharing)
        sharing.waiting = { force }
      if (current())
        jobs.delete(source.cacheKey)
      return
    }
    job.hold = acquired.hold
    if (sharing)
      sharing.hold = job.hold
  }
  /** How the refresh ended, for a page following it; a refresh stopped short of any end was dropped. */
  let outcome: RefreshOutcome = 'dropped'
  /**
   * Put the works the view held as the refresh began back on it: for a refresh
   * that showed part of the list and then stored none of it (stopped, failed),
   * so the view goes on showing what is stored.
   */
  let putBack = null as (() => void) | null
  job.draw()
  const unwatch = watchWaitLine((next) => {
    line = next
    job.draw()
  })
  try {
    if (source.load) {
      await reload(job, !topUp, force)
      return
    }
    // Re-budgeted rather than reused: the reader may have changed the ceiling,
    // and the listing may have grown, since the view was opened.
    const budget = await budgetFor(source, options)
    if (own.signal.aborted)
      return
    // What is on screen as the refresh begins, and when it was read: each page
    // of the listing read so far goes in front of it, in place of the stored
    // copies of the works it holds, and the rest stay as they were.
    const stored = topUp ? topUp.stored : view.getWorks()
    const storedAt = active?.view === view ? active.scrapedAt : Date.now()
    /** The listing read so far over the stored works, as the view has it, and as the source's side records would. */
    let merged = null as { works: Work[], listing: Work[] } | null
    const result = await scrapeListing({
      pageCount: budget.pages,
      pageUrl: source.pageUrl,
      blurbSelector: source.blurbSelector,
      firstPageDoc: source.firstPageDoc?.(),
      satisfied: topUp ? topUp.plan.satisfied : source.satisfied,
      signal: own.signal,
      onProgress: job.hold ? job.hold.progress : undefined,
      onPartial: (listing) => {
        const found = topUp ? topUp.plan.select(listing) : selected(job.source, listing)
        const works = applyLimit(renumber(belonging(job.source, mergeRefresh(found, stored))), limitFor(job.options))
        merged = { works, listing: mergeRefresh(listing, stored) }
        putBack ??= () => feed(job, applyLimit(renumber(belonging(job.source, [...stored])), limitFor(job.options)))
        feed(job, works)
      },
    })
    if (own.signal.aborted)
      return
    // A refusal taught us nothing about the rest of the list: what the archive
    // let through before it stopped answering goes in front of the stored
    // works, and every work it didn't reach keeps its stored copy — on screen,
    // on disk and, for Marked for Later, in the saved-work index. Dropping
    // works on the strength of a bad minute isn't recoverable; a list that is
    // partly older than it might be is. The copy is no more trusted than it
    // was, so the next open still reads the list again.
    if (result.blocked) {
      outcome = 'blocked'
      if (!merged) {
        toast(`AO3 asked us to slow down, so the list wasn't refreshed. It is still showing what was stored. Try again in a few minutes.`, { type: 'error' })
        return
      }
      await persist(job.source, merged.works, { listing: topUp ? undefined : merged.listing, readAt: storedAt })
      putBack = null
      land(job, merged.works, { grow: true, at: storedAt })
      toast(`AO3 asked us to slow down, so only part of the list was refreshed. The rest is still what was stored. Try again in a few minutes.`, { type: 'error' })
      return
    }
    const kept = topUp
      ? [...topUp.plan.select(result.works), ...topUp.stored]
      : selected(job.source, result.works)
    // A reload the reader asked for retries works an earlier one couldn't get;
    // a top-up is automatic, and leaves them be.
    const completed = await complete(job.source, kept, { signal: own.signal, full: !topUp })
    if (own.signal.aborted)
      return
    // The ceiling as the view now on screen was opened with: a re-run may have
    // brought a new one.
    const works = applyLimit(renumber(completed.works), limitFor(job.options))
    // The same refusal the options-page refresh makes — see `NotWritten` in
    // {@link file://./refresh.ts} for the reasoning and for why it is the
    // *listing* being empty that counts, not the finished list. Writing an
    // empty scrape over a stored list would take the list, its side table, and
    // the blurbs and cached text of every work in it; keeping the stored copy on
    // screen is always recoverable.
    if (result.works.length === 0 && works.length === 0 && await snapshotSize(source.cacheKey) > 0) {
      outcome = 'refused'
      toast(`AO3 returned this list with no works in it, so it wasn't refreshed. It is still showing what was stored.`, { type: 'error' })
      return
    }
    await persist(job.source, works, { listing: topUp ? undefined : result.works })
    outcome = 'written'
    putBack = null
    land(job, works, { grow: true })
    if (completed.blocked)
      toast('AO3 asked us to slow down before every work could be fetched. The rest keep their stored copies and will be tried again.', { type: 'error' })
    // A scrape that stopped because it had found everything it came for is not
    // a scrape that fell short.
    else if (!result.satisfied && result.loadedPages < result.totalPages)
      toast(`Updated with ${result.loadedPages} of ${result.totalPages} pages.`, { type: 'error' })
  }
  catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      outcome = 'failed'
      log.error(`Background refresh failed for ${source.id}`, err)
    }
  }
  finally {
    unwatch()
    const { hold } = job
    if (hold) {
      job.hold = null
      const holding = sharedOf(job)
      if (holding?.hold === hold)
        holding.hold = null
      await hold.release(outcome === 'dropped' && hold.cancelled ? 'cancelled' : outcome)
      sharedOf(job)?.recheck()
    }
    // A newer refresh has the note now, or the view has gone with the page's.
    // What landed with no view to show it on waits for the view put back.
    if (current()) {
      if (!job.ended)
        jobs.delete(source.cacheKey)
      putBack?.()
      job.view?.setUpdating(false)
    }
  }
}

/**
 * Keep the view of a list that shares its refresh in step with a refresh another
 * page holds: its progress on the note, with a Stop that asks that page to stop;
 * the list, once that page has stored it; and the refresh itself, should that
 * page drop it while this view was waiting on it. Nothing for any other list.
 */
function followShared(source: SearchSource, view: SearchView, options: Options, since: number): void {
  if (!sharesRefresh(source.id))
    return
  shared?.watching.abort()
  const state: SharedRefresh = { view, watching: new AbortController(), since, waiting: null, hold: null, following: false, recheck: () => {} }
  shared = state
  const look = (stored: ListRefresh | null): void => {
    if (state.hold)
      return
    const now = Date.now()
    const step = followState(stored, PAGE_RUN, state.since, now)
    if (step.kind === 'following') {
      state.following = true
      const { id } = step.claim
      view.setUpdating(true, {
        text: updatingNote(step.claim, now),
        onStop: () => void requestCancel(source.cacheKey, id).catch(err => log.error(`Could not ask for the refresh of ${source.id} to stop`, err)),
      })
      return
    }
    if (state.following)
      view.setUpdating(false)
    state.following = false
    if (step.kind === 'free') {
      const { waiting } = state
      state.waiting = null
      if (waiting)
        void refresh(source, view, options, undefined, waiting.force)
      return
    }
    state.waiting = null
    // Past its end, so the same release is news once.
    state.since = stored!.endedAt + 1
    if (step.kind === 'landed')
      void showStored(source, view, options).catch(err => log.error(`Could not show the refreshed ${source.id}`, err))
  }
  state.recheck = watchRefresh(source.cacheKey, look, state.watching.signal)
}

/** Show the list another page has just stored in place of the works on screen, as an open from the stored copy would. */
async function showStored(source: SearchSource, view: SearchView, options: Options): Promise<void> {
  const stored = await readSnapshot(source.cacheKey)
  if (!stored || active?.view !== view)
    return
  const works = applyLimit(selected(source, stored.works), limitFor(options))
  view.update(works, prepare(source, works, options, true))
  view.setRefreshedAt(stored.scrapedAt)
  active.scrapedAt = stored.scrapedAt
}

export interface OpenOptions {
  /** Restore a prior view state (a reopen after a global re-run). */
  initialState?: ViewState
  /**
   * Open with these selections rather than a blank filter — a tracked list's
   * own, put back when the reader arrives to refine it
   * ({@link SearchViewConfig.seed}). Ignored alongside {@link initialState}.
   */
  seed?: FilterState
  /** Skip the background re-scrape, when the cache is known to be fresh. */
  refresh?: boolean
  /**
   * Whether a reopen may show the works the closed view was holding. True by
   * default, and right for nearly every reopen: a mark click closes and reopens
   * the view within one re-run, and the works it was showing are the works it
   * should show — going back to storage for them would cost a read and a reparse
   * to arrive at the same list.
   *
   * `false` is for the case where the source itself has moved the list on in the
   * meantime, and the works in hand are the *old* answer. The reader's filters,
   * sort and layout still come across; the works are read from storage, where
   * the source has just written the new ones. The frozen page layout is dropped
   * with them (see {@link ViewState.order}) — it describes a set that has gone.
   */
  reuseWorks?: boolean
}

/**
 * Open the in-memory view for `source`, in place of its native listing. Renders
 * instantly from the cached snapshot when there is one (refreshing behind it);
 * otherwise walks the listing behind a progress bar until its first pages are
 * in, and grows the view as the rest arrive. An opening of the same list that
 * a global re-run handed over is taken back instead, as far as it had got, and
 * a load of it still under way feeds the view this open draws.
 *
 * Settles when the view is drawn or closed — whichever open has the opening by
 * then, should a re-run hand it on.
 */
export async function openSearchView(source: SearchSource, options: Options, opts: OpenOptions = {}): Promise<void> {
  // Claimed before anything can return early, so a reopen never outlives the
  // open it was meant for.
  const carried = takeClaimed(source, opts)
  // This list is already on screen, or on its way there: a second click, or a
  // unit re-running, has nothing to add. "On screen" is the container being in
  // the page; a global re-run takes it out, and hands over the opening it held.
  const step = onOpen(handover, source.cacheKey, isSearchViewOpen() && mounted?.cacheKey === source.cacheKey)
  if (step.plan === 'stay')
    return
  // An orphaned page could still scrape the listing — the fetches are the
  // reader's own session, not ours — but nothing it learned would survive:
  // there is no snapshot to read, none to write, and no mark it could record.
  // A whole listing's worth of requests to AO3 for a view that forgets
  // everything is worse than saying so (see
  // {@link file://./../extensionAlive.ts}).
  if (!extensionAlive())
    return
  // Only one list is shown at a time, so only its load goes on. A source that
  // has moved its list on since (`reuseWorks: false`) is loading something new,
  // and a load of the old list would only bring back the old answer.
  stopJobs(opts.reuseWorks === false ? undefined : source.cacheKey)
  handover = step.handover
  if (step.stopped)
    stopOpening(step.stopped)
  // A different list is up, or loading: this one replaces it. Two readings lists
  // share one page, and the reader moving from one to the other should get the
  // one they asked for, not a refusal because the other got there first.
  if (step.stopped || busy || isSearchViewOpen())
    closeSearchView()
  const gen = ++generation
  const stale = (): boolean => gen !== generation
  busy = true
  let opening: Opening | null = null
  try {
    const container = mountContainer(source, step.adopted?.container)
    opening = step.adopted ?? newOpening(source.cacheKey, opts, container)
    current = opening
    // A walk taken back is this open's to cancel now, and to stop if the page
    // moves on.
    if (opening.walk)
      controller = opening.walk.controller
    // Local (never-synced) layout prefs for this application of the view. A
    // reopen has the ones it was showing — and nothing on its way back to the
    // screen may wait on storage, or the page is drawn without it.
    let prefs = carried ? carried.prefs : await loadPrefs(source.id)
    if (stale())
      return
    /**
     * The source's own strip, built once for this open and kept across the
     * renders inside it, and the one listener it may register for reloads the
     * view would rather not spring on the reader.
     */
    let headerEl: HTMLElement | null = null
    let onDeferred: ((update: DeferredUpdate) => void) | null = null
    const reusingWorks = opts.reuseWorks !== false
    const config: SearchViewConfig = {
      perPage: options.searchPerPage,
      decorateBlurb: blurb => decorateBlurb(blurb, options, { hidesNothing: source.hidesNothing }),
      decorateContainer: root => decorateContainer(root, options),
      onRendered: refreshFilterToolbar,
      hideFacetValue: makeFacetHider(options),
      ...source.viewConfig,
      initialState: reusingWorks || !opts.initialState
        ? opts.initialState
        : { ...opts.initialState, order: undefined },
      seed: opts.seed,
      // How a work that has to keep a slot it no longer earns is drawn. Only a
      // view holding its page layout ever asks.
      collapseWork,
      onUpdateDeferred: (update) => {
        // Nothing on screen to offer it with, so a frozen layout is not worth
        // losing a reload over: it goes in as it would in any other view.
        if (onDeferred)
          onDeferred(update)
        else
          update.apply()
      },
      prefs,
      onPrefsChange: (next) => {
        prefs = next
        if (active?.source === source)
          active.prefs = next
        void savePrefs(source.id, next).catch(err => log.error('Failed to save search-view prefs', err))
      },
      // Fires when a work is taken out of the view; keep the snapshot in step.
      onWorkRemoved: work => takeOff(source, [work]),
    }
    const handlers = {
      onBack: source.replacesListing ? undefined : () => closeSearchView(),
      onRefresh: () => {
        if (!active)
          return
        // Forced: this is the reader asking, not a reload arriving.
        void refresh(source, active.view, options, undefined, true)
      },
    }
    // Everything a source's own strip can ask of the view. Each call checks that
    // the view it was made for is still the one on screen: a strip built during
    // an open that another open replaced must not write into the replacement.
    const headerCtl: SearchHeaderControl = {
      show: (works) => {
        if (active?.source !== source)
          return
        const next = renumber(belonging(source, works))
        void persist(source, next).catch(err => log.error(`Failed to persist the search-view snapshot for ${source.id}`, err))
        // Forced: the source is not reporting a change, it is making one.
        active.view.update(next, prepare(source, next, options, true), { force: true })
      },
      setUpdating: (on) => {
        if (active?.source === source)
          active.view.setUpdating(on)
      },
      refresh: () => handlers.onRefresh(),
      onUpdateDeferred: (listener) => {
        onDeferred = listener
      },
    }

    // Set for the one call that follows a scrape; a cached render is not fresh.
    let fresh = false
    const show = (works: Work[], refreshedAt: number): SearchView => {
      const autoExcludes = prepare(source, works, options, fresh)
      const view = createSearchView(works, handlers, { ...config, autoExcludes, refreshedAt })
      active = { source, view, scrapedAt: refreshedAt, prefs }
      stopLeaving?.()
      stopLeaving = source.leaving?.((workId) => {
        if (active?.view === view)
          view.remove(workId)
      }) ?? null
      // After `active`, so a strip that starts work the moment it is built can
      // already reach the view. Built once per open and kept, since nothing in
      // an open shows twice and a rebuild would throw away whatever the reader
      // had set on it.
      headerEl ??= source.header?.(headerCtl) ?? null
      container.replaceChildren(...(headerEl ? [headerEl, view.el] : [view.el]))
      return view
    }

    /**
     * Feed `view` from `job`, a load of this list under way; or, should it have
     * finished while this open read the stored copy, with what it brought.
     */
    const adopt = (job: LoadJob, view: SearchView): void => {
      attach(job, source, view, options)
      if (job.ended && job.latest) {
        jobs.delete(source.cacheKey)
        view.setUpdating(false)
        land(job, applyLimit(selected(source, job.latest.works), limitFor(options)), { grow: true })
      }
    }

    // An opening taken back may have walked as far as it was going to already:
    // a walk is never started twice, and its works don't wait on the copy.
    if (!opening.walk) {
      // A load that finished while a re-run had the view down has newer works
      // than the view it took down carried; this open is what it waited for.
      // One still under way has the works it has loaded so far, for an open
      // that carries none: a first walk has nothing stored to read.
      const pending = jobs.get(source.cacheKey)
      const landed = pending?.ended ? pending.latest : null
      if (pending?.ended) {
        jobs.delete(source.cacheKey)
        fresh = true
      }
      const inHand = (works: Work[], scrapedAt: number): CachedSnapshot => ({ works, scrapedAt, missing: 0, descriptor: source.descriptor() })
      const cached = landed
        ? inHand(undecorated(landed.works), landed.at)
        : carried && reusingWorks
          ? inHand(undecorated(carried.works), carried.scrapedAt)
          : pending?.latest
            ? inHand(undecorated(pending.latest.works), pending.latest.at)
            : await readSnapshot(source.cacheKey)
      if (stale())
        return
      const kept = cached ? selected(source, cached.works) : []
      if (cached && kept.length) {
        // Works that stopped belonging since the snapshot was taken, or since the
        // view a re-run closed was drawn — marked read off Marked for Later, or
        // unmarked off the read list — come out of the stored copy now, not at the
        // next reload. This is also how the change reaches the screen: an options
        // change reopens the view through here.
        if (kept.length < cached.works.length) {
          const stays = new Set(kept)
          takeOff(source, cached.works.filter(work => !stays.has(work)))
        }
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
        if (!source.belongs && !pending)
          void source.onPersist?.(stored).catch(err => log.error(`Failed to seed records for ${source.id}`, err))
        // Render instantly, then refresh in the background (unless the caller
        // knows the works are fresh, e.g. a reopen right after a re-run).
        const view = show(stored, cached.scrapedAt)
        followShared(source, view, options, Date.now())
        // Taking the old view down can shorten the page for as long as a layout
        // lasts, and a shorter page pulls the scroll position up with it.
        if (carried && window.scrollY !== carried.scrollY)
          window.scrollTo({ top: carried.scrollY, behavior: 'instant' })
        fresh = false
        // A load of this list still under way, a re-run having taken its view
        // down, feeds this view instead of a new one starting: even a reopen,
        // which reads nothing itself, gets what it brings.
        const job = jobs.get(source.cacheKey)
        if (job) {
          adopt(job, view)
          return
        }
        // A copy younger than the source's interval is taken as it is: reloading a
        // long list on every visit is how a reader gets rate-limited, and the
        // Refresh button is right there when they want it sooner.
        const wanted = source.descriptor()
        const recent = isFresh(
          { scrapedAt: cached.scrapedAt, missing: cached.missing, listUrl: cached.descriptor?.listUrl, dateFilter: cached.descriptor?.dateFilter },
          { intervalMs: source.refreshInterval?.() ?? 0, listUrl: wanted.listUrl, dateFilter: wanted.dateFilter, now: Date.now() },
        )
        // `undefined` is a full reload, `null` is a top-up with nothing to find.
        const plan = !recent && opts.refresh !== false && source.topUp ? source.topUp(stored) : undefined
        if (opts.refresh !== false && !recent && plan !== null)
          void refresh(source, view, options, plan ? { plan, stored } : undefined)
        return
      }

      // No cache: walk the listing behind a progress bar before showing the
      // view. Its controller is registered before the count and the gate so a
      // "Back", or a re-run's stop, which aborts the live controller, releases
      // either of them rather than leaving one running behind a page that has
      // moved on. A load of the list under way whose works have all stopped
      // belonging since is still the load to wait on.
      const running = jobs.get(source.cacheKey)
      if (running) {
        const view = show([], running.latest?.at ?? Date.now())
        followShared(source, view, options, Date.now())
        adopt(running, view)
        return
      }
      opening.walk = startWalk(source, options, container)
      controller = opening.walk.controller
    }
    const walked = opening.walk
    await walked.first
    // Handed on by a re-run, or replaced: what the walk found is the newer
    // open's to show, and the view on screen now is not this one's to close.
    if (stale())
      return
    if (controller === walked.controller)
      controller = null
    // The listing's first pages are in and the rest are still coming: the view
    // goes up with what there is, and a load job takes the walk on from here.
    if (!walked.ended && walked.partial) {
      const works = applyLimit(renumber(selected(source, walked.partial.works)), walked.partial.limit)
      fresh = true
      const now = Date.now()
      const view = show(works, now)
      const job: LoadJob = {
        cacheKey: source.cacheKey,
        controller: walked.controller,
        source,
        options,
        view,
        hold: null,
        // The panel's line and its Cancel, which leaves the list unstored.
        draw: () => job.view?.setUpdating(true, { text: walked.progress.text(), onStop: () => closeSearchView() }),
        latest: { works, at: now },
        ended: false,
      }
      jobs.set(source.cacheKey, job)
      walked.job = job
      walked.progress.listen(() => job.draw())
      job.draw()
      void finishWalk(job, walked)
      return
    }
    const outcome = await walked.outcome
    if (stale())
      return
    try {
      if (outcome.kind === 'failed') {
        failLoad(source, outcome.err)
        return
      }
      if (outcome.kind === 'stopped') {
        closeSearchView()
        return
      }
      if (outcome.kind === 'loaded') {
        // What follows a source's own load is the same as what follows a
        // scrape: the refusal and empty guards, the write, the view.
        const { loaded } = outcome
        const works = renumber(belonging(source, loaded.works))
        // Not written when AO3 refused us outright and gave us nothing: an empty
        // load would otherwise overwrite a perfectly good stored list, and "AO3
        // said no" is not news about what is on the reader's list.
        if (!loaded.blocked || works.length)
          await persist(source, works)
        if (stale())
          return
        if (!works.length) {
          // An empty list is a fact about the reader; a refusal is a fact about
          // this minute. Telling them apart is the whole point of `blocked`.
          toast(loaded.blocked ? RATE_LIMITED : source.emptyMessage, { type: 'error' })
          closeSearchView()
          return
        }
        fresh = true
        const now = Date.now()
        followShared(source, show(works, now), options, now)
        if (loaded.blocked)
          toast('AO3 asked us to slow down before the whole list could be loaded. The rest will be tried again next time.', { type: 'error' })
        return
      }
      const { budget, result, completed } = outcome
      const works = applyLimit(renumber(completed.works), budget.limit)
      await persistWalk(source, works, result)
      if (stale() || closedEmpty(source, works, result))
        return
      fresh = true
      const now = Date.now()
      followShared(source, show(works, now), options, now)
      shortfallToast(result, completed)
    }
    catch (err) {
      // Replaced while it was being written: the view on screen now is not
      // this one's to close.
      if (!stale())
        failLoad(source, err)
    }
  }
  finally {
    if (!stale())
      busy = false
    if (opening) {
      if (!stale()) {
        if (current === opening)
          current = null
        opening.end()
      }
      else {
        // Handed on by a re-run, this open settles when the view does.
        await opening.done
      }
    }
  }
}
