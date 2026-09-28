import type { Options, SnapshotDescriptor } from '#common'
import type { Work } from '#content_script/blurb.js'

import { ADDON_CLASS, logger, toast } from '#common'
import { onArchiveWait } from '#content_script/archiveFetch.js'
import { hasNode } from '#content_script/blurb.js'
import { pruneDetachedTriggers } from '#content_script/contextTrigger.js'
import { extensionAlive } from '#content_script/extensionAlive.js'
import { refreshFilterToolbar } from '#content_script/units/FilterToolbar.tsx'
import React from '#dom'

import type { WriteSnapshotOptions } from './cache.ts'
import type { FacetValueRef, FilterState } from './engine.ts'
import type { SearchViewPrefs } from './prefs.ts'
import type { DeferredUpdate, SearchView, SearchViewConfig, ViewState } from './view.tsx'
import type { Recovered, RecoverOptions } from './workPageBlurb.tsx'

import { pristineBlurb, readSnapshot, snapshotSize, writeSnapshot } from './cache.ts'
import { cx, HOST, NATIVE_HIDDEN_CLASS } from './classes.ts'
import { collapseWork, decorateBlurb, decorateContainer, makeFacetHider } from './decorate.ts'
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

/** What the host tells a {@link SearchSource.load} about the load it wants. */
export interface LoadOptions {
  /** Aborted when the view is replaced, closed, or refreshed again. */
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
 * Set when a global re-run (e.g. an options change from a context menu) closed an
 * open view. Cleared by {@link closeSearchView}, so a user-initiated close (Back)
 * stays closed.
 */
let reopen: Reopen | null = null
/**
 * A {@link reopen} its unit has claimed through {@link takeReopen}, waiting for
 * the {@link openSearchView} that call leads to. Matched to it by the very state
 * object `takeReopen` handed out, so nothing but that open can pick it up.
 */
let claimed: Reopen | null = null

/** Whether a view is currently mounted (by this host, for any source). */
export function isSearchViewOpen(): boolean {
  return document.querySelector(`.${HOST}`) !== null
}

/**
 * Whether the view for `cacheKey` is on its way to the screen: an open of it has
 * started and not yet finished. A caller whose own open has just returned can
 * tell from this whether a newer one — a global re-run's — has taken over.
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
  const { source, view, scrapedAt, prefs } = active
  const snapshot: Reopen = {
    cacheKey: source.cacheKey,
    state: view.getState(),
    works: view.getWorks(),
    scrapedAt,
    prefs,
    scrollY: window.scrollY,
  }
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
  claimed = reopen
  reopen = null
  return claimed.state
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
  return applyHidden(works, options, { hidesNothing: source.hidesNothing })
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
  /**
   * A load that says in its own words what it is doing (see
   * {@link LoadOptions.onProgress}), because the page counter above assumes one
   * listing being read from the front.
   */
  onLoad: (text: string, done: number, total: number) => void
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
    onLoad: (text, done, total) => {
      progressText = text
      // A step of unknown length leaves the bar where it was rather than
      // snapping it back to nothing: the work already done wasn't undone.
      if (total > 0)
        fill.style.width = `${Math.round((Math.min(done, total) / total) * 100)}%`
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
async function reload(
  source: SearchSource,
  view: SearchView,
  options: Options,
  signal: AbortSignal,
  full: boolean,
  force: boolean,
): Promise<void> {
  const applied = force || source.viewConfig?.stablePages !== true
  const loaded = await source.load!({ signal, onProgress: () => {}, full, applied })
  if (signal.aborted)
    return
  if (loaded.blocked) {
    toast(`AO3 asked us to slow down, so the list wasn't refreshed. It is still showing what was stored. Try again in a few minutes.`, { type: 'error' })
    return
  }
  const works = renumber(belonging(source, loaded.works))
  if (works.length === 0 && await snapshotSize(source.cacheKey) > 0) {
    toast(`This list came back with no works in it, so it wasn't refreshed. It is still showing what was stored.`, { type: 'error' })
    return
  }
  if (signal.aborted)
    return
  await persist(source, works)
  view.update(works, prepare(source, works, options, true), { force })
  const now = Date.now()
  view.setRefreshedAt(now)
  if (active?.view === view)
    active.scrapedAt = now
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
  controller?.abort()
  const own = new AbortController()
  controller = own
  try {
    if (source.load) {
      await reload(source, view, options, own.signal, !topUp, force)
      return
    }
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
    // The same refusal the options-page refresh makes — see `NotWritten` in
    // {@link file://./refresh.ts} for the reasoning and for why it is the
    // *listing* being empty that counts, not the finished list. Writing an
    // empty scrape over a stored list would take the list, its side table, and
    // the blurbs and cached text of every work in it; keeping the stored copy on
    // screen is always recoverable.
    if (result.works.length === 0 && works.length === 0 && await snapshotSize(source.cacheKey) > 0) {
      toast(`AO3 returned this list with no works in it, so it wasn't refreshed. It is still showing what was stored.`, { type: 'error' })
      return
    }
    await persist(source, works, { listing: topUp ? undefined : result.works })
    view.update(works, prepare(source, works, options, true), { force })
    const now = Date.now()
    view.setRefreshedAt(now)
    if (active?.view === view)
      active.scrapedAt = now
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
 * otherwise scrapes the whole listing behind a progress bar first.
 */
export async function openSearchView(source: SearchSource, options: Options, opts: OpenOptions = {}): Promise<void> {
  // Claimed before anything can return early, so a reopen never outlives the
  // open it was meant for.
  const carried = takeClaimed(source, opts)
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
        // Forced: this is the reader asking, not a reload arriving.
        void refresh(source, view, options, undefined, true).finally(() => view.setUpdating(false))
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
      // After `active`, so a strip that starts work the moment it is built can
      // already reach the view. Built once per open and kept, since nothing in
      // an open shows twice and a rebuild would throw away whatever the reader
      // had set on it.
      headerEl ??= source.header?.(headerCtl) ?? null
      container.replaceChildren(...(headerEl ? [headerEl, view.el] : [view.el]))
      return view
    }

    const cached = carried && reusingWorks
      ? { works: undecorated(carried.works), scrapedAt: carried.scrapedAt, missing: 0 }
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
      // Render instantly, then refresh in the background (unless the caller
      // knows the works are fresh, e.g. a reopen right after a re-run).
      const view = show(stored, cached.scrapedAt)
      // Taking the old view down can shorten the page for as long as a layout
      // lasts, and a shorter page pulls the scroll position up with it.
      if (carried && window.scrollY !== carried.scrollY)
        window.scrollTo({ top: carried.scrollY, behavior: 'instant' })
      // A copy younger than the source's interval is taken as it is: reloading a
      // long list on every visit is how a reader gets rate-limited, and the
      // Refresh button is right there when they want it sooner.
      // Nor is a copy missing blurbs it names: only a reload can put them back.
      const age = Date.now() - cached.scrapedAt
      const recent = !cached.missing && age >= 0 && age < (source.refreshInterval?.() ?? 0)
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
      if (source.load) {
        // A source that produces its own works has no listing to budget, no
        // pages to count and nothing for the limit gate to ask about — it has
        // already decided how much to read. What follows the load is the same as
        // what follows a scrape: the refusal and empty guards, the write, the
        // view.
        // `applied`: there is nothing on screen yet for these works to
        // interrupt, so the view they open is the works they brought.
        const loaded = await source.load({ signal: own.signal, onProgress: progress.onLoad, full: true, applied: true })
        if (stale())
          return
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
        show(works, Date.now())
        if (loaded.blocked)
          toast('AO3 asked us to slow down before the whole list could be loaded. The rest will be tried again next time.', { type: 'error' })
        return
      }
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
