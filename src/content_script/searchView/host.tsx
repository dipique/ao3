import type { Options } from '#common'
import type { Work } from '#content_script/blurb.js'

import { ADDON_CLASS, logger, toast } from '#common'
import { pruneDetachedTriggers } from '#content_script/contextTrigger.js'
import React from '#dom'

import type { SearchView, SearchViewConfig, ViewState } from './view.tsx'

import { readSnapshot, writeSnapshot } from './cache.ts'
import { decorateBlurb, decorateContainer, makeFacetHider } from './decorate.ts'
import { loadPrefs, savePrefs } from './prefs.ts'
import { scrapeListing } from './scrape.ts'
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

const HOST = `${ADDON_CLASS}--search-host`
const cx = (suffix: string): string => `${HOST}--${suffix}`
/** Added to the native list + pagination to hide them while the view is shown. */
const NATIVE_HIDDEN_CLASS = cx('native-hidden')

const log = logger.child('searchView')

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
  /** Builds the URL of a 1-based page of the source listing. */
  pageUrl: (page: number) => string
  /** How many pages that listing has. Read from the live page, at load time. */
  pageCount: () => number
  /**
   * How many works the listing says it holds, when it says so at all. Only used
   * to explain a truncated load ({@link budgetFor}) — the cap itself is counted
   * in pages, which every listing reports.
   */
  resultCount?: () => number | null
  /** Where blurbs sit in a fetched page (see `DEFAULT_BLURB_SELECTOR`). */
  blurbSelector?: string
  /** The native elements hidden while the view is up, restored when it closes. */
  nativeElements: () => Iterable<Element>
  /** Insert the (empty, already classed) container where the view belongs. */
  mount: (container: HTMLElement) => void
  /**
   * Stamp or seed a set of works before the view sees them — readiness, saved
   * state, anything that isn't a property of the blurb. Runs on every load,
   * cached or fresh.
   */
  prepare?: (works: Work[]) => void
  /** Persist alongside the blurb snapshot the host always writes (e.g. an id index). */
  onPersist?: (works: Work[]) => Promise<void>
  /** Source-specific view config, layered over the host's shared defaults. */
  viewConfig?: SearchViewConfig
  /** Shown when the source turns out to hold no works at all. */
  emptyMessage: string
  /** Shown when the load fails outright. */
  errorMessage: string
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
function budgetFor(source: SearchSource, options: Options): Budget {
  // A ceiling under one page would fetch nothing at all; one page is the floor.
  const limit = Math.max(WORKS_PER_PAGE, Math.floor(options.searchMaxResults) || WORKS_PER_PAGE)
  const totalPages = Math.max(1, source.pageCount())
  return { limit, totalPages, pages: Math.min(totalPages, Math.ceil(limit / WORKS_PER_PAGE)) }
}

/** Whether `budget` leaves part of the listing unread. */
function isTruncated(budget: Budget): boolean {
  return budget.pages < budget.totalPages
}

/** Drop everything past the budget's ceiling, in place. */
function applyLimit(works: Work[], budget: Budget): Work[] {
  if (works.length > budget.limit)
    works.length = budget.limit
  return works
}

let active: { source: SearchSource, view: SearchView } | null = null
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
  controller?.abort()
  controller = null
  active = null
  busy = false
  // A close means "don't come back" unless the caller re-arms reopen after.
  reopen = null
  for (const el of document.querySelectorAll(`.${HOST}`))
    el.remove()
  for (const el of document.querySelectorAll(`.${NATIVE_HIDDEN_CLASS}`))
    el.classList.remove(NATIVE_HIDDEN_CLASS)
  // Release the context-menu triggers on the now-removed blurbs (the native
  // page's still-connected triggers are left intact).
  pruneDetachedTriggers()
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

/** Write the blurb snapshot, plus whatever else the source keeps in step with it. */
async function persist(source: SearchSource, works: Work[]): Promise<void> {
  await writeSnapshot(source.cacheKey, works)
  await source.onPersist?.(works)
}

/** Hide the source's native listing and insert an empty view container for it. */
function mountContainer(source: SearchSource): HTMLElement {
  for (const el of source.nativeElements())
    el.classList.add(NATIVE_HIDDEN_CLASS)
  const container = (<div class={`${ADDON_CLASS}  ${HOST}  ${ADDON_CLASS}--${source.id}`} />) as HTMLElement
  source.mount(container)
  return container
}

/** Determinate progress panel shown while a fresh scrape runs. */
function mountProgress(container: HTMLElement): (done: number, total: number) => void {
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
  return (done, total) => {
    label.textContent = `Loaded ${done} of ${total} pages…`
    fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`
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

/** Re-scrape in the background and feed the result into the live view + cache. */
async function refresh(source: SearchSource, view: SearchView, options: Options): Promise<void> {
  controller?.abort()
  const own = new AbortController()
  controller = own
  try {
    // Re-budgeted rather than reused: the reader may have changed the ceiling,
    // and the listing may have grown, since the view was opened.
    const budget = budgetFor(source, options)
    const result = await scrapeListing({
      pageCount: budget.pages,
      pageUrl: source.pageUrl,
      blurbSelector: source.blurbSelector,
      signal: own.signal,
    })
    if (own.signal.aborted)
      return
    applyLimit(result.works, budget)
    await persist(source, result.works)
    source.prepare?.(result.works)
    view.update(result.works)
    if (result.loadedPages < result.totalPages)
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
  if (busy || isSearchViewOpen())
    return
  busy = true
  try {
    const container = mountContainer(source)
    // Local (never-synced) layout prefs for this application of the view.
    const prefs = await loadPrefs(source.id)
    const config: SearchViewConfig = {
      perPage: options.searchPerPage,
      decorateBlurb: blurb => decorateBlurb(blurb, options),
      decorateContainer: root => decorateContainer(root, options),
      hideFacetValue: makeFacetHider(options),
      ...source.viewConfig,
      initialState: opts.initialState,
      prefs,
      onPrefsChange: (next) => {
        void savePrefs(source.id, next).catch(err => log.error('Failed to save search-view prefs', err))
      },
      // Fires when a blurb action drops a work; keep the snapshot in step.
      onWorksChanged: (works) => {
        void persist(source, works).catch(err => log.error('Failed to persist the search-view snapshot', err))
      },
    }
    const handlers = {
      onBack: () => closeSearchView(),
      onRefresh: () => {
        if (!active)
          return
        const { view } = active
        view.setUpdating(true)
        void refresh(source, view, options).finally(() => view.setUpdating(false))
      },
    }

    const show = (works: Work[]): SearchView => {
      source.prepare?.(works)
      const view = createSearchView(works, handlers, config)
      active = { source, view }
      container.replaceChildren(view.el)
      return view
    }

    const cached = await readSnapshot(source.cacheKey)
    if (cached && cached.works.length) {
      // A snapshot taken under a higher ceiling than the reader now has; trim it
      // to what they asked for rather than waiting for the refresh to say so.
      applyLimit(cached.works, budgetFor(source, options))
      // The snapshot itself is already on disk — but whatever the source keeps in
      // step with it may not be (a snapshot from before that record existed, or a
      // refresh that failed), so re-derive it from the cache. The refresh below
      // normally overwrites it within seconds.
      void source.onPersist?.(cached.works).catch(err => log.error(`Failed to seed records for ${source.id}`, err))
      // Render instantly from cache, then refresh in the background (unless the
      // caller knows the cache is fresh, e.g. a reopen right after a re-run).
      const view = show(cached.works)
      if (opts.refresh !== false) {
        view.setUpdating(true)
        void refresh(source, view, options).finally(() => view.setUpdating(false))
      }
      return
    }

    // No cache: scrape with a progress bar before showing the view. A listing
    // too big for the reader's ceiling gets a say-so first — it's their request
    // being narrowed, not ours.
    const budget = budgetFor(source, options)
    const own = new AbortController()
    // Registered before the gate so a "Back"/re-run teardown, which aborts the
    // live controller, also releases a gate still waiting on an answer.
    controller = own
    if (isTruncated(budget) && !await mountLimitGate(container, source, budget, own.signal)) {
      closeSearchView()
      return
    }
    const onProgress = mountProgress(container)
    try {
      const result = await scrapeListing({
        pageCount: budget.pages,
        pageUrl: source.pageUrl,
        blurbSelector: source.blurbSelector,
        onProgress,
        signal: own.signal,
      })
      applyLimit(result.works, budget)
      await persist(source, result.works)
      if (!result.works.length) {
        toast(source.emptyMessage, { type: 'error' })
        closeSearchView()
        return
      }
      show(result.works)
      if (result.loadedPages < result.totalPages)
        toast(`Loaded ${result.loadedPages} of ${result.totalPages} pages — some couldn't be fetched.`, { type: 'error' })
    }
    catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        log.error(`Failed to load ${source.id}`, err)
        toast(source.errorMessage, { type: 'error' })
      }
      closeSearchView()
    }
    finally {
      if (controller === own)
        controller = null
    }
  }
  finally {
    busy = false
  }
}
