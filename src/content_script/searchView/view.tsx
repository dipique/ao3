import MdiArrowLeft from '~icons/mdi/arrow-left.jsx'
import MdiCheckCircle from '~icons/mdi/check-circle.jsx'
import MdiChevronDown from '~icons/mdi/chevron-down.jsx'
import MdiChevronUp from '~icons/mdi/chevron-up.jsx'
import MdiMinusCircle from '~icons/mdi/minus-circle.jsx'
import MdiPlusCircle from '~icons/mdi/plus-circle.jsx'
import MdiRefresh from '~icons/mdi/refresh.jsx'

import type { Work } from '#content_script/blurb.js'

import { ADDON_CLASS } from '#common'
import { hasNode } from '#content_script/blurb.js'
import React from '#dom'

import type { FacetCounts, FacetDir, FacetKey, FacetSelection, FacetValueCount, FacetValueRef, FilterState, SortKey, StableDrop } from './engine.ts'
import type { FacetRowFacts } from './facetRows.ts'
import type { SearchViewPrefs } from './prefs.ts'
import type { TextSearchPhase, WorkTextSearcher } from './textSearch.ts'

import { planChildren } from './childOrder.ts'
import { VIEW_HIDDEN_CLASS, VIEW_ROOT } from './classes.ts'
import {
  buildFacets,
  cloneFilterState,
  completionOf,
  completionValue,
  computeView,
  emptyFilterState,
  FACET_KEYS,
  FACET_LABELS,
  facetValueKey,
  facetValues,
  layoutStablePages,
  orderFacetKeys,
  readerFilter,
  SORT_LABELS,
  sortWorks,
} from './engine.ts'
import { notifyFacetChange, registerFacetBridge } from './facetBridge.ts'
import { groupCountText, layoutFacetRows, leftOutNote, nameRanks } from './facetRows.ts'
import { DEFAULT_STATUS, SIDEBAR_WIDTH } from './prefs.ts'
import { pristineBlurb } from './pristine.ts'
import { describeTextSearch, parseTextQuery } from './textSearch.ts'

const ROOT = VIEW_ROOT
/** Body class while the filter column is being dragged — see ReaderMode, same idea. */
const RESIZING_CLASS = `${ADDON_CLASS}--resizing`
const cx = (suffix: string): string => `${ROOT}--${suffix}`
const HIDDEN_CLASS = VIEW_HIDDEN_CLASS
const ACTIVE_CLASS = cx('active')
// Name tiebreaker for facet-row ordering; mirrors engine's value sort.
const rowCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/**
 * What the host does when the view asks. Both are optional, and each button is
 * only drawn where its handler is: an exported copy of a list has no native
 * listing behind it to go back to and nothing to re-scrape from, so it passes
 * neither and gets a toolbar with just the count on it.
 */
export interface SearchViewHandlers {
  /** Restore the native page (remove the aggregated view). */
  onBack?: () => void
  /** Re-scrape from the source and feed the result back via {@link SearchView.update}. */
  onRefresh?: () => void
}

/** A snapshot of what the user has dialled in, so the view can be rebuilt as-is. */
export interface ViewState {
  filter: FilterState
  pageIndex: number
  /** Per-facet "contains" filter box text, keyed by facet (omitted when empty). */
  facetQueries: Partial<Record<FacetKey, string>>
  /** Facet groups the user had collapsed (the rest default open). */
  collapsedFacets: FacetKey[]
  /**
   * Rule-implied exclusions the reader has lifted by hand, as `key:value`.
   *
   * Part of the state rather than of the view, because a view is torn down and
   * rebuilt on every options change — which is every mark click — and a lifted
   * exclusion that lived only in the old view's closure came straight back each
   * time, against what {@link SearchViewConfig.autoExcludes} promises.
   */
  releasedAutoExcludes: string[]
  /**
   * The selection sections (a group's required / included / excluded values) the
   * reader has opened or shut by hand, keyed `key:dir`. The rest sit at their
   * default — open, except the excluded ones, which rule-implied exclusions can
   * fill faster than anyone wants to scroll past.
   */
  openSelections: Record<string, boolean>
  /**
   * The ids of every work the pages were cut from, in page order, as of the last
   * time the reader said what they wanted — only recorded, and only honoured, by
   * a view built with {@link SearchViewConfig.stablePages}.
   *
   * It is what lets a view be torn down and rebuilt — which happens on every
   * options change, so on every mark click — and come back holding the same works
   * on the same page, instead of closing the gap left by whatever the reader just
   * did and sliding a work off the next page onto one they have already read.
   */
  order?: string[]
  /**
   * The work-text search box ({@link SearchViewConfig.textSearch}) and, once a
   * search over it has finished, the works it found. Carrying the answer lets a
   * rebuilt view open showing it, rather than every work until the search has
   * run again.
   */
  workText?: { query: string, hits?: string[] }
  /**
   * Works the source took out of the list with {@link SearchView.merge}, which
   * hold their slots drawn as gone: carried across the teardown and rebuild with
   * {@link order}.
   */
  gone?: string[]
}

/**
 * Fresh works a {@link SearchViewConfig.stablePages} view declined to swap in,
 * handed to the host so it can offer them rather than reshuffle a list the
 * reader is part-way through.
 */
export interface DeferredUpdate {
  /** The works as loaded, for the offer to describe ("+3 −1"). */
  works: Work[]
  /** Swap them in after all: the view takes them on and goes back to page 1. */
  apply: () => void
}

export interface SearchView {
  /** The view root — insert this into the page. */
  el: HTMLElement
  /**
   * Swap in freshly scraped works (e.g. after a background refresh), keeping
   * filters. `autoExcludes` re-states the exclusions the reader's hide rules
   * imply over the new set; omit it to keep the ones the view already has.
   *
   * A {@link SearchViewConfig.stablePages} view refuses: swapping the list jumps
   * to page 1 over a different set of works, which is the one thing a frozen
   * layout exists to prevent. It hands the works to
   * {@link SearchViewConfig.onUpdateDeferred} instead, for whoever can ask the
   * reader. `force` overrides that, for a caller who *is* the reader's answer.
   */
  update: (works: Work[], autoExcludes?: FacetValueRef[], opts?: { force?: boolean }) => void
  /**
   * Toggle the subtle "updating in the background" indicator. `text` replaces
   * its plain "Updating…" while there is more to say (how far it has got, a
   * pause it is sitting out), and `onStop` puts a Stop button beside it.
   */
  setUpdating: (updating: boolean, opts?: { text?: string | null, onStop?: () => void }) => void
  /** Record when the works were last fetched, for the Refresh button to say. */
  setRefreshedAt: (at: number) => void
  /** Current filter/sort/page, so a caller can rebuild the view where it left off. */
  getState: () => ViewState
  /**
   * The filter the reader has dialled in themselves (`readerFilter` in the
   * engine): the selections, the text and the word count, less the exclusions
   * their hide rules imply unless they put one back by hand, and with the Status
   * and List source groups empty. What a tracked list made from this view keeps.
   */
  getReaderFilter: () => FilterState
  /**
   * The works the view holds right now — what it was given, less any
   * {@link remove} has since taken out. Their blurbs are still decorated, and
   * still the view's own nodes.
   */
  getWorks: () => Work[]
  /**
   * Take the work with this id out of the view: its blurb goes, and the view
   * re-renders over the rest with the reader's filters as they were. Reported
   * through {@link SearchViewConfig.onWorkRemoved}. A work the view doesn't hold
   * is ignored.
   */
  remove: (workId: string) => void
  /**
   * Add works to the view and take others out, keeping the page on screen, the
   * filters, the sort, the text search and the facets' open and closed groups.
   * The facets are rebuilt, so a new value gets a row, and a text search is run
   * again over the works it now holds.
   *
   * In a {@link SearchViewConfig.stablePages} view no page before the one on
   * screen changes: a work added goes where the sort puts it, or first on the
   * page on screen when that would be an earlier page, and a work taken out
   * keeps its slot, drawn collapsed with {@link SearchViewConfig.goneReason}.
   * A work added that the view holds as gone is put back. `autoExcludes`
   * re-states the exclusions the reader's hide rules imply over the works it
   * now holds, as for {@link update}.
   */
  merge: (added: Work[], goneIds: ReadonlySet<string>, autoExcludes?: FacetValueRef[]) => void
}

export interface SearchViewConfig {
  /** Works rendered per page. Paging bounds layout/paint cost on large lists. */
  perPage?: number
  /**
   * Decorate one blurb with the per-blurb enhancements (kudos ratio, highlights,
   * …). Called the first time a blurb appears on a page, so a large list only
   * pays to decorate what's actually viewed.
   */
  decorateBlurb?: (blurb: HTMLElement) => void
  /**
   * Wire container-wide enhancements (the right-click / long-press context-menu
   * toolbars) over the results list. Called once per (re-)mount.
   */
  decorateContainer?: (resultsRoot: HTMLElement) => void
  /**
   * Whether a facet value should be left out of the sidebar entirely — the
   * in-memory counterpart of the native filter rows HideFilters hides. A hidden
   * value keeps counting towards the works it's on; it just can't be seen or
   * filtered by, and any selection on it is dropped.
   */
  hideFacetValue?: (key: FacetKey, value: string) => boolean
  /**
   * Facet values to keep excluded on the reader's behalf: the exclusions their
   * hide rules imply, worked out over the whole set by the host (see
   * {@link file://./hidden.ts}). Seeded before the first render, re-stated after
   * a refresh, and restored by "Reset filters" — but never forced back onto a
   * value the reader has deliberately un-excluded, which is the one way they can
   * say "show me those after all".
   */
  autoExcludes?: FacetValueRef[]
  /** Called after {@link SearchView.remove} takes a work out, so the host can take it off the stored copy too. */
  onWorkRemoved?: (work: Work) => void
  /**
   * Called whenever the view has finished re-rendering — a filter, a sort, a page
   * turn, or fresh works. What the reader can actually see has changed, which is
   * what page-level furniture outside the view (the floating filter toolbar's
   * count of hidden works) needs to know.
   */
  onRendered?: () => void
  /** Restore a prior {@link SearchView.getState} snapshot (filters, sort, page). */
  initialState?: ViewState
  /**
   * Selections to open with on a fresh open: a tracked list's own filter, put
   * back on screen when the reader comes to refine the list. Its facet
   * selections, text and word count go over what the view would otherwise open
   * with; the sort, the Status default and the layout prefs still come from
   * {@link prefs}. Ignored when there is an {@link initialState}, which is the
   * view as it last was and already holds whatever this once put there.
   *
   * Every value it selects counts as the reader's own choice, as it was when
   * the filter was saved: a rule-implied exclusion ({@link autoExcludes}) of the
   * same value is not imposed over it, and one it excludes itself stays the
   * reader's, and so stays in {@link SearchView.getReaderFilter}.
   */
  seed?: FilterState
  /**
   * Local (never-synced) layout prefs restored on open: collapsed facet groups,
   * custom facet order, and last sort. Seeded from {@link onPrefsChange}'s prior
   * output. `initialState` (an in-memory reopen) wins over these for the fields
   * they share, since it reflects exactly what the user last had on screen.
   */
  prefs?: Partial<SearchViewPrefs>
  /** Called whenever a persisted layout pref changes (collapse, sort, reorder). */
  onPrefsChange?: (prefs: SearchViewPrefs) => void
  /**
   * Overrides for individual sort-option labels. The `marked` sort is really
   * "the order the source listed them in", which reads as the date you marked a
   * work for later on a to-read list and as the Archive's own ordering anywhere
   * else — so the label has to come from the host.
   */
  sortLabels?: Partial<Record<SortKey, string>>
  /**
   * Epoch ms the works were last fetched from AO3. Shown on the Refresh button,
   * which matters once a stored copy can be days old on purpose.
   */
  refreshedAt?: number
  /**
   * Status values the view opens (and resets) with when the user has no saved
   * selection. Defaults to {@link DEFAULT_STATUS} — "only what's ready", which
   * is triage for a to-read list but would silently hide works when browsing, so
   * hosts that aren't triaging pass `[]`.
   */
  defaultStatus?: string[]
  /**
   * Freeze which works sit on which page, so that nothing but the reader can
   * move one.
   *
   * For a list meant to be *worked through* rather than browsed, where the reader
   * pages from the first work to the last and acts on what they find. Every such
   * action — a mark, a rule added from a context menu — re-runs the page and
   * rebuilds this view, with the hide pass and the facet filters applied afresh;
   * anything that drops a work at that point shortens the list and slides every
   * work after it back a slot, so the work that headed the next page lands on the
   * page just read and is never seen again. A frozen layout keeps the slot and
   * draws the work collapsed instead ({@link collapseWork}).
   *
   * What the reader dials in themselves — the filter, the sort, the search text,
   * the word count — recomputes the layout and goes back to page 1, since a
   * reshuffle they asked for is no surprise. Facet counts are live throughout;
   * the freeze is only over the page each work sits on.
   *
   * The frozen layout travels in {@link ViewState.order}, which is what carries
   * it across the teardown and rebuild.
   */
  stablePages?: boolean
  /**
   * Draw one blurb as a work holding a slot it no longer earns: a line saying
   * what happened and a button to show it anyway. Only ever called for a
   * {@link stablePages} view. Absent leaves such a work drawn as it was, which
   * for a work a rule now hides means an empty slot.
   */
  collapseWork?: (blurb: HTMLElement, reason: string) => void
  /**
   * Take the fresh works a {@link stablePages} view would not swap in, so they
   * can be offered to the reader instead. Without it, `update` swaps as usual —
   * a frozen layout is worth less than works that never appear.
   */
  onUpdateDeferred?: (update: DeferredUpdate) => void
  /** What a work {@link SearchView.merge} took out of a {@link stablePages} view says in its slot. */
  goneReason?: string
  /**
   * Search inside the works themselves, where the host holds copies of them.
   * Draws a second search box whose results narrow the view like any filter,
   * with an excerpt under each blurb showing where the text matched.
   *
   * No part of the {@link FilterState}: nothing that keeps a filter beyond the
   * view (a tracked list, the saved prefs) could run it again, since it needs
   * text that only this host has.
   */
  textSearch?: WorkTextSearcher
}

const DEFAULT_PER_PAGE = 50

/** The wrapper HideWorks moves a collapsed blurb's contents into. */
const HIDE_WRAPPER_CLASS = `${ADDON_CLASS}--hide-works--wrapper`

/**
 * What a work holding a slot it no longer earns is told it is doing there —
 * deliberately about the *kind* of thing that happened rather than the specific
 * rule, which the hiding decoration says better wherever it can say it at all.
 */
const DROP_REASONS: Record<StableDrop, string> = {
  hidden: 'Now hidden by your rules or marks',
  filtered: 'No longer matches your filters',
  gone: 'No longer in this list',
}

/**
 * The works that count as results: everything the reader's rules haven't taken
 * away outright (see {@link Work.hidden}). Works a rule merely *collapses* are
 * still results — they keep their slot, which is what collapsing is for.
 */
function results(works: Work[]): Work[] {
  return works.filter(work => !work.hidden)
}

/** `just now`, `5 minutes ago`, `3 hours ago`, `2 days ago`. */
function timeAgo(at: number, now: number = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000)
  const say = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} ago`
  if (minutes < 1)
    return 'just now'
  if (minutes < 60)
    return say(minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? say(hours, 'hour') : say(Math.floor(hours / 24), 'day')
}

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout>
  return (...args: A) => {
    clearTimeout(timer)
    timer = setTimeout(fn, ms, ...args)
  }
}

/**
 * Make `parent`'s children `desired`, moving only those out of place — or, when
 * most of them would move or go, swapping them all at once, which the browser
 * does faster than that many single moves.
 */
function placeChildren(parent: Element, desired: readonly Element[]): void {
  const { remove, insert } = planChildren([...parent.children], desired)
  if (remove.length + insert.length > desired.length) {
    parent.replaceChildren(...desired)
    return
  }
  for (const node of remove)
    node.remove()
  for (const { node, before } of insert)
    parent.insertBefore(node, before)
}

function setText(el: Element, text: string): void {
  if (el.textContent !== text)
    el.textContent = text
}

/** Parse a word-count bound; blank/invalid -> null (unbounded). */
function parseBound(value: string): number | null {
  const digits = value.replace(/\D/g, '')
  return value.trim() === '' || digits === '' ? null : Number(digits)
}

/**
 * Build a self-contained, filterable/sortable view over a list of works. Pure
 * UI: it knows nothing about where the works came from, so it is reusable for
 * any aggregated AO3 listing. The caller mounts {@link SearchView.el} and, for a
 * background refresh, calls {@link SearchView.update} with the new works.
 */
export function createSearchView(initialWorks: Work[], handlers: SearchViewHandlers, config: SearchViewConfig = {}): SearchView {
  let works = initialWorks
  // Everything the view treats as a result. A work a rule hides outright is not
  // one: it stays in `works` (mounted, and part of what the host persists) but
  // counts for nothing here — no facet count, no total, no slot on a page. That
  // is the whole difference between a hide rule and a collapse rule in a view we
  // page ourselves; see {@link Work.hidden}.
  /** Ids of works {@link SearchView.merge} took out, which hold their slots but are no result. */
  let gone = new Set<string>(config.initialState?.gone ?? [])
  /** The results among `works`, less the works taken out. */
  const resultsOf = (all: Work[]): Work[] => gone.size ? results(all).filter(work => !gone.has(work.workId)) : results(all)
  let pool = resultsOf(works)
  // The exclusions the reader's hide rules imply over the current set, and the
  // ones they have since lifted by hand. Kept apart from `state` because they
  // are re-derived from the works rather than dialled in: a refresh restates
  // them, and only a deliberate un-exclude takes one off again.
  let autoExcludes: FacetValueRef[] = config.autoExcludes ?? []
  let autoKeys = new Set(autoExcludes.map(({ key, value }) => `${key}:${value}`))
  // Seeded from the snapshot, so a view reopened after a re-run does not re-impose
  // what the reader lifted before it. See `ViewState.releasedAutoExcludes`.
  const released = new Set<string>(config.initialState?.releasedAutoExcludes ?? [])
  // Selection sections opened or shut by hand; see `ViewState.openSelections`.
  // Kept per view rather than per group, so a facet rebuild (a refresh) keeps them.
  const openSelections = new Map<string, boolean>(Object.entries(config.initialState?.openSelections ?? {}))
  // Restore a prior snapshot (e.g. after a global re-run reopened the view), else
  // start blank. cloneFilterState so we never mutate the caller's snapshot.
  const state: FilterState = config.initialState ? cloneFilterState(config.initialState.filter) : emptyFilterState()
  const defaultStatus = config.defaultStatus ?? DEFAULT_STATUS
  const sortLabels: Record<SortKey, string> = { ...SORT_LABELS, ...config.sortLabels }
  // Seed the sort from saved prefs on a fresh open. An in-memory reopen
  // (initialState) already carries the user's live sort, so it wins.
  if (!config.initialState && config.prefs) {
    if (config.prefs.sort)
      state.sort = config.prefs.sort
    if (config.prefs.dir)
      state.dir = config.prefs.dir
    // Status is the one facet with a default selection, seeded here rather
    // than in emptyFilterState(), which must go on meaning "nothing filtered" —
    // it's what "Reset filters" and every other caller start from. `readiness`
    // is what the pref was called before the group grew past it.
    for (const value of config.prefs.status ?? config.prefs.readiness ?? defaultStatus)
      state.facets.status.include.add(value)
    // ...but only values this set actually has. `update()` prunes selections
    // whose values have gone, and does it on a *refresh* — a sticky "Waiting"
    // with nothing waiting would open on "No works match" with nothing on screen
    // to explain why.
    const present = new Set(pool.flatMap(work => facetValues(work, 'status')))
    for (const value of [...state.facets.status.include]) {
      if (!present.has(value))
        state.facets.status.include.delete(value)
    }
  }
  // A saved filter to open with, over the defaults just seeded. Its values are
  // the reader's own, so each is marked as lifted from the rules: no rule-implied
  // exclusion is pressed over one, and one it excludes itself stays theirs.
  if (!config.initialState && config.seed) {
    const seed = config.seed
    const dirs = ['require', 'include', 'exclude'] as const
    for (const key of FACET_KEYS) {
      for (const dir of dirs) {
        for (const value of seed.facets[key][dir]) {
          for (const other of dirs)
            state.facets[key][other].delete(value)
          state.facets[key][dir].add(value)
          released.add(facetValueKey(key, value))
        }
      }
    }
    state.text = seed.text
    state.wordsMin = seed.wordsMin
    state.wordsMax = seed.wordsMax
  }
  // The user's custom facet-group order (persisted locally), applied on every
  // (re)build and mutated by the per-group reorder arrows.
  let facetOrder: FacetKey[] = orderFacetKeys(config.prefs?.order)
  const perPage = Math.max(1, config.perPage ?? DEFAULT_PER_PAGE)
  // Current page (0-based). Sorted full set is cached; filtering never reorders.
  let pageIndex = config.initialState?.pageIndex ?? 0
  const stablePages = config.stablePages === true
  /**
   * The page layout this view is holding to, as work ids in page order — see
   * {@link SearchViewConfig.stablePages}. Null means the next render lays the
   * pages out from what passes the filter and freezes *that*, which is how the
   * view opens and what every change the reader dials in goes back to.
   */
  let frozenOrder: string[] | null = stablePages ? (config.initialState?.order ?? null) : null
  /**
   * Works this view has drawn collapsed in a slot they no longer earn. Kept so a
   * swap that does happen can take the collapse back off: the same work can be a
   * proper result in the next set, and its blurb node comes along with it.
   */
  const collapsedInPlace = new Set<Work>()
  let sortedWorks: Work[] = works
  // Blurbs already run through config.decorateBlurb, so each is decorated at most
  // once (and only when first shown). A WeakSet so replaced works are forgotten.
  const decorated = new WeakSet<HTMLElement>()
  // The per-group facet UI (filter text, collapsed groups) is restored from the
  // saved snapshot/prefs only once, on the first build. Later rebuilds (a
  // refresh) instead carry over the live on-screen state (see renderFacets).
  let facetUiRestored = false

  // The work-text search: the query whose answer narrows the view and the works
  // it found, and the search under way, if any. Kept out of `state` along with
  // the rest of it; see `SearchViewConfig.textSearch`.
  const textSearch = config.textSearch
  const restoredText = textSearch ? config.initialState?.workText : undefined
  let textApplied: { query: string, hits: Set<string> } | null
    = restoredText?.hits && parseTextQuery(restoredText.query).length
      ? { query: restoredText.query, hits: new Set(restoredText.hits) }
      : null
  let textRun: { query: string, controller: AbortController } | null = null
  // Excerpts drawn into blurbs, all cut for `snippetQuery`.
  const snippetEls = new Map<Work, HTMLElement>()
  let snippetQuery = ''

  // Registry of facet rows, rebuilt whenever the facet list changes, so render()
  // can sync toggle state and live drill-down counts against the current filter
  // without re-creating the DOM (which would reset the open/closed groups).
  // Every value has its counts here; its elements are built the first time it
  // shows, since a large list has thousands that never do.
  interface FacetRowRef extends FacetRowFacts {
    dom: FacetRowDom | null
  }
  interface FacetRowDom {
    row: HTMLElement
    /** Drill-down count: results you'd get if you also *included* this value. */
    countEl: HTMLElement
    /** Result count: results remaining if you additionally *required* this value. */
    resultCountEl: HTMLElement
    /** The require button, toggled disabled when requiring would empty results. */
    requireBtn: HTMLButtonElement
    buttons: { dir: FacetDir, btn: HTMLButtonElement }[]
  }
  /** One collapsible run of a group's selected values, all in one direction. */
  interface SelectionSectionRef {
    dir: FacetDir
    el: HTMLElement
    head: HTMLButtonElement
    countEl: HTMLElement
    /** Where this direction's selected rows are moved to by layoutGroup(). */
    body: HTMLElement
  }
  interface FacetGroupRef {
    key: FacetKey
    details: HTMLElement
    countEl: HTMLElement
    /** The container the value rows live in, re-ordered as counts/selection change. */
    body: HTMLElement
    rows: FacetRowRef[]
    /** This group's value-filter box, if it's large enough to have one. */
    filter: HTMLInputElement | null
    /** Current text in this group's value filter. */
    query: string
    /** What the rows are sorted by (secondary to selection-first): a count or the name. */
    valueSort: 'count' | 'result' | 'name'
    /** Direction of the value sort. */
    valueSortDir: 'asc' | 'desc'
    /** The selected values, by direction, above the unselected rows. */
    sections: SelectionSectionRef[]
    /** The reorder arrows, disabled at the ends of the list. */
    upBtn: HTMLButtonElement
    downBtn: HTMLButtonElement
    /** Under the rows while the cap leaves some out, saying how many. */
    leftOutEl: HTMLElement
  }
  // Large groups (> this many values) get a "contains" filter box for their values.
  const FACET_FILTER_THRESHOLD = 10
  let facetGroups: FacetGroupRef[] = []

  // Filled in once the tree below is built; every use guards for that, because
  // `clampSidebar` runs one line later to seed the width.
  let layoutEl: HTMLElement | null = null
  let sidebarWidth = clampSidebar(config.prefs?.sidebarWidth ?? SIDEBAR_WIDTH.default)

  /** Snapshot the persistable layout prefs (collapse/order/sort) to the host. */
  function persist(): void {
    if (!config.onPrefsChange)
      return
    const collapsed = facetGroups
      .filter(g => !(g.details as HTMLDetailsElement).open)
      .map(g => g.key)
    // savePrefs takes a whole SearchViewPrefs, so everything persisted has to be
    // rebuilt here — there's no partial write.
    config.onPrefsChange({
      collapsed,
      order: [...facetOrder],
      sort: state.sort,
      dir: state.dir,
      status: [...state.facets.status.include],
      sidebarWidth,
    })
  }

  const countEl = (<span class={cx('count')} />) as HTMLElement
  const updatingText = (<span class={cx('updating-text')}>Updating…</span>) as HTMLElement
  const updatingStop = (<button type="button" class={cx('updating-stop')} title="Stop updating this list" hidden>Stop</button>) as HTMLElement
  let onUpdatingStop: (() => void) | undefined
  updatingStop.addEventListener('click', () => onUpdatingStop?.())
  const updatingEl = (
    <span class={cx('updating')}>
      {updatingText}
      {updatingStop}
    </span>
  ) as HTMLElement
  const resultsOl = (<ol class={`work index group ${cx('results')}`} />) as HTMLElement as HTMLOListElement
  const facetsEl = (<div class={cx('facets')} />) as HTMLElement
  const pagerEl = (<nav class={cx('pager')} aria-label="Results pages" />) as HTMLElement

  // ---- Filter-column width -------------------------------------------------
  // The column is a grid track, so resizing is a matter of rewriting one custom
  // property; the handle is a real grid item sitting in the gap between the two
  // columns rather than something floated over them, so nothing can end up
  // underneath it.
  const resizerEl = (
    <div
      class={cx('resizer')}
      role="separator"
      aria-orientation="vertical"
      aria-label="Filter column width"
      tabindex={0}
      title="Drag to resize the filters — double-click to reset"
    />
  ) as HTMLElement

  /** Keep a width inside its bounds — and inside the space actually available. */
  function clampSidebar(px: number): number {
    const available = layoutEl?.getBoundingClientRect().width ?? 0
    // Leave the results at least as much room as the filters, so dragging can
    // never squeeze the works into a strip. Before first layout `available` is
    // 0, in which case only the fixed bounds apply.
    const ceiling = available > 0
      ? Math.min(SIDEBAR_WIDTH.max, available * 0.6)
      : SIDEBAR_WIDTH.max
    return Math.round(Math.min(Math.max(px, SIDEBAR_WIDTH.min), Math.max(ceiling, SIDEBAR_WIDTH.min)))
  }

  /** Write the width to the grid and tell assistive tech where the divider sits. */
  function applySidebarWidth(): void {
    if (!layoutEl)
      return
    layoutEl.style.setProperty('--ao3e-sidebar-width', `${sidebarWidth}px`)
    resizerEl.setAttribute('aria-valuenow', String(sidebarWidth))
    resizerEl.setAttribute('aria-valuemin', String(SIDEBAR_WIDTH.min))
    resizerEl.setAttribute('aria-valuemax', String(SIDEBAR_WIDTH.max))
  }

  /** Set the width, apply it, and persist — the one path that changes it. */
  function setSidebarWidth(px: number): void {
    const next = clampSidebar(px)
    if (next === sidebarWidth)
      return
    sidebarWidth = next
    applySidebarWidth()
    persist()
  }

  resizerEl.addEventListener('pointerdown', (e: PointerEvent) => {
    // Only the primary button, and never while the columns are stacked — there
    // is no width to drag when the filters sit above the results.
    if (e.button !== 0 || !layoutEl || getComputedStyle(resizerEl).display === 'none')
      return
    e.preventDefault()
    resizerEl.setPointerCapture(e.pointerId)
    document.body.classList.add(RESIZING_CLASS)
    const left = layoutEl.getBoundingClientRect().left

    const onMove = (ev: PointerEvent): void => {
      // Width from the layout's left edge to the pointer, so the handle tracks
      // the cursor rather than drifting by however far into it you grabbed.
      sidebarWidth = clampSidebar(ev.clientX - left)
      applySidebarWidth()
    }
    const onUp = (): void => {
      if (resizerEl.hasPointerCapture(e.pointerId))
        resizerEl.releasePointerCapture(e.pointerId)
      document.body.classList.remove(RESIZING_CLASS)
      resizerEl.removeEventListener('pointermove', onMove)
      resizerEl.removeEventListener('pointerup', onUp)
      resizerEl.removeEventListener('lostpointercapture', onUp)
      // Persist once, at the end — a write per pointermove would hammer storage.
      persist()
    }
    resizerEl.addEventListener('pointermove', onMove)
    resizerEl.addEventListener('pointerup', onUp)
    resizerEl.addEventListener('lostpointercapture', onUp)
  })

  // A divider you can only drag is unusable without a pointer, so the arrows
  // move it too and Home puts it back.
  resizerEl.addEventListener('keydown', (e: KeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16
    if (e.key === 'ArrowLeft')
      setSidebarWidth(sidebarWidth - step)
    else if (e.key === 'ArrowRight')
      setSidebarWidth(sidebarWidth + step)
    else if (e.key === 'Home')
      setSidebarWidth(SIDEBAR_WIDTH.default)
    else
      return
    e.preventDefault()
  })

  resizerEl.addEventListener('dblclick', () => setSidebarWidth(SIDEBAR_WIDTH.default))

  // --- Controls -------------------------------------------------------------

  const searchInput = (
    <input type="search" class={cx('input')} placeholder="Title, author, summary, tags…" aria-label="Search works" />
  ) as HTMLElement as HTMLInputElement
  searchInput.value = state.text
  searchInput.addEventListener('input', debounce(() => {
    state.text = searchInput.value
    filterChanged()
  }, 120))

  const textInput = textSearch
    ? (<input type="search" class={`${cx('input')}  ${cx('text-input')}`} placeholder='Words, or "a phrase"…' aria-label="Search inside works" />) as HTMLElement as HTMLInputElement
    : null
  const textStatus = (<p class={cx('text-status')} aria-live="polite" />) as HTMLElement
  if (textInput) {
    textInput.value = restoredText?.query ?? ''
    // Slower than the box above: every pause starts a pass over the works.
    textInput.addEventListener('input', debounce(() => searchText(textInput.value), 350))
    textInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter')
        searchText(textInput.value)
    })
  }

  function showTextStatus(phase: TextSearchPhase): void {
    textStatus.textContent = describeTextSearch(phase)
  }

  function showTextCoverage(): void {
    if (textSearch)
      showTextStatus({ kind: 'idle', searchable: pool.filter(work => textSearch.has(work.workId)).length, total: pool.length })
  }

  /**
   * Search the works' text for `query`, abandoning whatever search is under way.
   *
   * A `restore` is the same search asked again on the reader's behalf — over a
   * rebuilt view, or a fresh set of works — so it leaves their page where it is
   * and redraws only if the answer changed. Anything else is the reader asking,
   * and goes back to the first page like any other filter; a query that only
   * differs in spacing or case asks nothing new and is ignored.
   */
  function searchText(query: string, { restore = false } = {}): void {
    if (!textSearch)
      return
    const terms = parseTextQuery(query)
    const asked = textRun?.query ?? textApplied?.query ?? ''
    if (!restore && terms.join('\0') === parseTextQuery(asked).join('\0'))
      return
    textRun?.controller.abort()
    textRun = null
    if (!terms.length) {
      showTextCoverage()
      if (textApplied) {
        textApplied = null
        filterChanged()
      }
      return
    }
    const run = { query, controller: new AbortController() }
    textRun = run
    textSearch.search(pool.map(work => work.workId), query, {
      signal: run.controller.signal,
      onProgress: (done, total) => {
        if (textRun === run)
          showTextStatus({ kind: 'searching', done, total })
      },
    }).then(({ hits, searched, unavailable }) => {
      if (textRun !== run)
        return
      textRun = null
      const before = textApplied
      textApplied = { query, hits }
      showTextStatus({ kind: 'done', hits: hits.size, searched, unavailable })
      if (!restore)
        filterChanged()
      else if (!before || before.query !== query || before.hits.size !== hits.size || [...hits].some(id => !before.hits.has(id)))
        render()
    }, (error: unknown) => {
      if (textRun !== run)
        return
      textRun = null
      showTextStatus({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    })
  }

  /** Empty the work-text search box, and stop narrowing the view by it. */
  function clearTextSearch(): void {
    if (!textInput)
      return
    textInput.value = ''
    textRun?.controller.abort()
    textRun = null
    textApplied = null
    showTextCoverage()
  }

  /**
   * Under each blurb on the page that the applied work-text search found, the
   * stretch of the work where it matched — and once that search is no longer
   * the one applied, none of them.
   */
  function syncSnippets(page: Work[]): void {
    const query = textApplied?.query ?? ''
    if (query !== snippetQuery) {
      for (const el of snippetEls.values())
        el.remove()
      snippetEls.clear()
      snippetQuery = query
    }
    if (!textSearch || !textApplied)
      return
    for (const work of page) {
      if (snippetEls.has(work) || !textApplied.hits.has(work.workId))
        continue
      const el = (<blockquote class={`${ADDON_CLASS}  ${cx('snippet')}`} />) as HTMLElement
      snippetEls.set(work, el)
      void textSearch.snippet(work.workId, query).then((snippet) => {
        if (!snippet || snippetEls.get(work) !== el)
          return
        el.replaceChildren(
          `${snippet.clippedStart ? '…' : ''}${snippet.before}`,
          <mark>{snippet.match}</mark>,
          `${snippet.after}${snippet.clippedEnd ? '…' : ''}`,
        )
        // Inside the wrapper of a work a rule has collapsed, so that the excerpt
        // is put away with the rest of it.
        const host = work.el.querySelector(`:scope > .${HIDE_WRAPPER_CLASS}`) ?? work.el
        host.append(el)
      })
    }
  }

  const sortSelect = (
    <select class={cx('select')} aria-label="Sort by">
      {(Object.keys(sortLabels) as SortKey[]).map(key => <option value={key}>{sortLabels[key]}</option>)}
    </select>
  ) as HTMLElement as HTMLSelectElement
  sortSelect.value = state.sort
  sortSelect.addEventListener('change', () => {
    state.sort = sortSelect.value as SortKey
    sortChanged()
  })

  const dirBtn = (<button type="button" class={cx('dir')} />) as HTMLElement as HTMLButtonElement
  function syncDir(): void {
    dirBtn.textContent = state.dir === 'asc' ? '↑ Asc' : '↓ Desc'
    dirBtn.title = state.dir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'
  }
  dirBtn.addEventListener('click', () => {
    state.dir = state.dir === 'asc' ? 'desc' : 'asc'
    syncDir()
    sortChanged()
  })
  syncDir()

  const minInput = (<input type="number" min="0" inputmode="numeric" class={cx('input')} placeholder="min" aria-label="Minimum words" />) as HTMLElement as HTMLInputElement
  const maxInput = (<input type="number" min="0" inputmode="numeric" class={cx('input')} placeholder="max" aria-label="Maximum words" />) as HTMLElement as HTMLInputElement
  minInput.value = state.wordsMin != null ? String(state.wordsMin) : ''
  maxInput.value = state.wordsMax != null ? String(state.wordsMax) : ''
  const onWords = debounce(() => {
    state.wordsMin = parseBound(minInput.value)
    state.wordsMax = parseBound(maxInput.value)
    filterChanged()
  }, 200)
  minInput.addEventListener('input', onWords)
  maxInput.addEventListener('input', onWords)

  const resetBtn = (<button type="button" class={cx('reset')}>Reset filters</button>) as HTMLElement as HTMLButtonElement
  resetBtn.addEventListener('click', () => {
    const fresh = emptyFilterState()
    state.text = fresh.text
    state.facets = fresh.facets
    // "Reset filters" restores the host's default status, not "no filter": on
    // a to-read list, showing only what's ready is the state the view is meant to
    // sit in, and resetting to everything would quietly turn the feature off.
    // Hosts that browse rather than triage default to nothing, so this is a no-op
    // for them.
    for (const value of defaultStatus)
      state.facets.status.include.add(value)
    // "Reset filters" is back to how the view opens, and it opens with the
    // reader's own rules applied — including the ones they had lifted since.
    released.clear()
    applyAutoExcludes()
    state.wordsMin = null
    state.wordsMax = null
    state.sort = fresh.sort
    state.dir = fresh.dir
    searchInput.value = ''
    clearTextSearch()
    minInput.value = ''
    maxInput.value = ''
    sortSelect.value = state.sort
    for (const group of facetGroups) {
      group.query = ''
      if (group.filter)
        group.filter.value = ''
    }
    syncDir()
    filterChanged()
    // The blurbs' include/exclude/require icons show the same selections a
    // second time, and every one of them just moved.
    notifyFacetChange()
    // Sort reset to default is a visible change; keep the stored pref in step.
    persist()
  })

  const onBack = handlers.onBack
  const backBtn = onBack
    ? (() => {
        const button = (
          <button type="button" class={cx('back')}>
            <MdiArrowLeft />
            {' '}
            Back to list
          </button>
        ) as HTMLElement as HTMLButtonElement
        button.addEventListener('click', onBack)
        return button
      })()
    : null
  let refreshedAt = config.refreshedAt
  const onRefresh = handlers.onRefresh
  const refreshBtn = onRefresh
    ? (() => {
        const button = (
          <button type="button" class={cx('refresh')} title="Refresh">
            <MdiRefresh />
          </button>
        ) as HTMLElement as HTMLButtonElement
        button.addEventListener('click', onRefresh)
        // Worked out on hover rather than when set, so "just now" doesn't go on
        // saying so an hour later on a tab left open.
        button.addEventListener('mouseenter', () => {
          button.title = refreshedAt === undefined ? 'Refresh' : `Refresh — last refreshed ${timeAgo(refreshedAt)}`
        })
        return button
      })()
    : null

  // --- Facets ---------------------------------------------------------------

  const FACET_DIRS: FacetDir[] = ['require', 'include', 'exclude']

  /** Take on a fresh set of rule-implied exclusions (a refresh re-derived them). */
  function setAutoExcludes(next: FacetValueRef[]): void {
    autoExcludes = next
    autoKeys = new Set(next.map(({ key, value }) => `${key}:${value}`))
  }

  /**
   * Put the rule-implied exclusions back into the filter, skipping any the reader
   * has lifted. Idempotent, so it can run on every render path that rebuilds the
   * selections: the first assembly, a refresh, and "Reset filters".
   */
  function applyAutoExcludes(): void {
    for (const { key, value } of autoExcludes) {
      if (released.has(`${key}:${value}`))
        continue
      state.facets[key].include.delete(value)
      state.facets[key].require.delete(value)
      state.facets[key].exclude.add(value)
    }
  }

  function toggleSelection(key: FacetKey, dir: FacetDir, value: string): void {
    const sel = state.facets[key][dir]
    // Lifting a rule-implied exclusion — by clearing it, or by including or
    // requiring the same value — is the reader overruling their own rule for
    // this view, so it must survive the next refresh restating it.
    const wasExcluded = state.facets[key].exclude.has(value)
    if (sel.has(value)) {
      sel.delete(value)
    }
    else {
      sel.add(value)
      // The three directions are mutually exclusive for one value.
      for (const other of FACET_DIRS) {
        if (other !== dir)
          state.facets[key][other].delete(value)
      }
    }
    if (wasExcluded && !state.facets[key].exclude.has(value) && autoKeys.has(`${key}:${value}`))
      released.add(`${key}:${value}`)
    filterChanged()
    // The blurbs carry the same selection a second time (the little include /
    // exclude / require icons the tag menus leave next to a tag), so tell them
    // it moved — whether the toggle came from a facet row or from one of those
    // menus. Mirrors what the native sidebar's `notifyFilterChange` does.
    notifyFacetChange()
    // Status is the one facet whose selection is a saved preference rather
    // than something dialled in for this visit.
    if (key === 'status')
      persist()
  }

  const SECTION_LABELS: Record<FacetDir, string> = { require: 'Required', include: 'Included', exclude: 'Excluded' }

  function isSectionOpen(key: FacetKey, dir: FacetDir): boolean {
    return openSelections.get(`${key}:${dir}`) ?? dir !== 'exclude'
  }

  function selectionSection(key: FacetKey, dir: FacetDir): SelectionSectionRef {
    const countEl = (<span class={cx('sel-count')} />) as HTMLElement
    const head = (
      <button type="button" class={cx('sel-head')}>
        <MdiChevronDown class={cx('sel-chevron')} />
        <span class={cx('sel-label')}>{SECTION_LABELS[dir]}</span>
        {countEl}
      </button>
    ) as HTMLElement as HTMLButtonElement
    const body = (<div class={cx('sel-body')} />) as HTMLElement
    const el = (
      <div class={`${cx('sel')}  ${cx(`sel-${dir}`)}`}>
        {head}
        {body}
      </div>
    ) as HTMLElement
    const section: SelectionSectionRef = { dir, el, head, countEl, body }
    head.addEventListener('click', () => {
      openSelections.set(`${key}:${dir}`, !isSectionOpen(key, dir))
      const group = facetGroups.find(g => g.key === key)
      if (group)
        layoutGroup(group)
    })
    return section
  }

  function facetRow({ value, count }: FacetValueCount, nameRank: number): FacetRowRef {
    return { value, lower: value.toLowerCase(), count, resultCount: count, nameRank, dom: null }
  }

  function facetRowDom(group: FacetGroupRef, { value }: FacetRowRef): FacetRowDom {
    const { key } = group
    const require = (
      <button type="button" class={`${cx('toggle')}  ${cx('toggle-require')}`} aria-pressed="false" title={`Require "${value}" — every shown work must have this tag`}>
        <MdiCheckCircle />
      </button>
    ) as HTMLElement as HTMLButtonElement
    const include = (
      <button type="button" class={`${cx('toggle')}  ${cx('toggle-include')}`} aria-pressed="false" title={`Include "${value}" — show works with this tag (any of the included)`}>
        <MdiPlusCircle />
      </button>
    ) as HTMLElement as HTMLButtonElement
    const exclude = (
      <button type="button" class={`${cx('toggle')}  ${cx('toggle-exclude')}`} aria-pressed="false" title={`Hide works tagged "${value}"`}>
        <MdiMinusCircle />
      </button>
    ) as HTMLElement as HTMLButtonElement
    require.addEventListener('click', () => toggleSelection(key, 'require', value))
    include.addEventListener('click', () => toggleSelection(key, 'include', value))
    exclude.addEventListener('click', () => toggleSelection(key, 'exclude', value))

    // Two counts: the drill-down count (what including this would surface) and,
    // in parentheses, how many of the *current* results have this value (what
    // requiring it would leave).
    const countEl = (<span class={cx('row-count')} role="button" title="Results if you include this value — click to sort by this count" />) as HTMLElement
    const resultCountEl = (<span class={cx('row-result-count')} role="button" title="Results remaining if you require this value — click to sort by this count" />) as HTMLElement
    // The full value is the tooltip (names truncate); it also acts as a button to
    // sort the group's rows alphabetically, mirroring the click-to-sort counts.
    const nameEl = (<span class={cx('row-name')} role="button" title={`${value} — click to sort by name`}>{value}</span>) as HTMLElement
    // Clicking either count sorts the group's rows by that number, and clicking
    // a name sorts them alphabetically (selection still floats to the top);
    // clicking the active one flips direction.
    nameEl.addEventListener('click', () => setValueSort(group, 'name'))
    countEl.addEventListener('click', () => setValueSort(group, 'count'))
    resultCountEl.addEventListener('click', () => setValueSort(group, 'result'))
    const row = (
      <div class={cx('row')}>
        <span class={cx('row-toggles')}>
          {require}
          {include}
          {exclude}
        </span>
        {nameEl}
        {countEl}
        {resultCountEl}
      </div>
    ) as HTMLElement

    return {
      row,
      countEl,
      resultCountEl,
      requireBtn: require,
      buttons: [{ dir: 'require', btn: require }, { dir: 'include', btn: include }, { dir: 'exclude', btn: exclude }],
    }
  }

  function renderFacets(): void {
    // Before discarding the current groups, snapshot their live collapse/filter
    // state so a rebuild (a background refresh) preserves what the user has on
    // screen instead of resetting every group to open with empty filters.
    const liveCollapsed = new Set<FacetKey>()
    const liveQueries = new Map<FacetKey, string>()
    for (const group of facetGroups) {
      if (!(group.details as HTMLDetailsElement).open)
        liveCollapsed.add(group.key)
      if (group.query)
        liveQueries.set(group.key, group.query)
    }
    facetGroups = []
    // Row identity is fixed from the full set; render() updates the live
    // drill-down counts and puts in the page only the rows that still match.
    const facets = buildFacets(pool)
    // Seed the facet UI: the first build restores from the saved snapshot (an
    // in-memory reopen via initialState wins, else the persisted local prefs);
    // later rebuilds (a refresh) carry over the live on-screen state captured above.
    const firstBuild = !facetUiRestored
    const restore = firstBuild ? config.initialState : null
    const prefCollapsed = firstBuild && !restore ? new Set(config.prefs?.collapsed ?? []) : null
    facetUiRestored = true
    for (const key of facetOrder) {
      // Drop the values the user has muted ("hide filter"), and with them any
      // selection they carried — an unreachable row must not keep filtering.
      const values = config.hideFacetValue
        ? facets[key].filter(({ value }) => {
            if (!config.hideFacetValue!(key, value))
              return true
            for (const dir of FACET_DIRS)
              state.facets[key][dir].delete(value)
            return false
          })
        : facets[key]
      if (!values.length)
        continue
      const ranks = nameRanks(values.map(({ value }) => value), rowCollator.compare)
      const rows = values.map((value, i) => facetRow(value, ranks[i]!))
      const groupCountEl = (<span class={cx('group-count')}>{groupCountText(values.length)}</span>) as HTMLElement
      // Long value lists (tags, fandoms, characters…) get a "contains" filter.
      const label = FACET_LABELS[key].toLowerCase()
      const filterInput = values.length > FACET_FILTER_THRESHOLD
        ? (<input type="search" class={cx('group-filter')} placeholder={`Filter ${label}…`} aria-label={`Filter ${FACET_LABELS[key]}`} />) as HTMLElement as HTMLInputElement
        : null
      // Apply the filter text / collapsed state for this group: on the first
      // build from the saved snapshot/prefs, on a rebuild from the live state.
      const savedQuery = filterInput
        ? (firstBuild ? (restore?.facetQueries[key] ?? '') : (liveQueries.get(key) ?? ''))
        : ''
      if (filterInput)
        filterInput.value = savedQuery
      const collapsed = firstBuild
        ? (restore ? restore.collapsedFacets.includes(key) : (prefCollapsed?.has(key) ?? false))
        : liveCollapsed.has(key)
      const upBtn = (
        <button type="button" class={`${cx('group-move')}  ${cx('group-move-up')}`} title={`Move ${FACET_LABELS[key]} up`} aria-label={`Move ${FACET_LABELS[key]} up`}>
          <MdiChevronUp />
        </button>
      ) as HTMLElement as HTMLButtonElement
      const downBtn = (
        <button type="button" class={`${cx('group-move')}  ${cx('group-move-down')}`} title={`Move ${FACET_LABELS[key]} down`} aria-label={`Move ${FACET_LABELS[key]} down`}>
          <MdiChevronDown />
        </button>
      ) as HTMLElement as HTMLButtonElement
      // Reorder on click; stop the summary's default toggle so the arrows don't
      // also collapse/expand the group.
      const onMove = (delta: -1 | 1) => (e: Event): void => {
        e.preventDefault()
        e.stopPropagation()
        moveGroup(key, delta)
      }
      upBtn.addEventListener('click', onMove(-1))
      downBtn.addEventListener('click', onMove(1))
      const sections = FACET_DIRS.map(dir => selectionSection(key, dir))
      const leftOutEl = (<div class={cx('group-capped')} />) as HTMLElement
      const bodyEl = (
        <div class={cx('group-body')}>
          {sections.map(s => s.el)}
        </div>
      ) as HTMLElement
      const group = (
        <details class={cx('group')} open={!collapsed}>
          <summary class={cx('group-title')}>
            <span class={cx('group-label')}>
              {FACET_LABELS[key]}
              {' '}
              {groupCountEl}
            </span>
            <span class={cx('group-moves')}>
              {upBtn}
              {downBtn}
            </span>
          </summary>
          {filterInput}
          {bodyEl}
        </details>
      ) as HTMLElement
      const groupRef: FacetGroupRef = {
        key,
        details: group,
        countEl: groupCountEl,
        body: bodyEl,
        rows,
        filter: filterInput,
        query: savedQuery,
        valueSort: 'count',
        valueSortDir: 'desc',
        sections,
        upBtn,
        downBtn,
        leftOutEl,
      }
      filterInput?.addEventListener('input', () => {
        groupRef.query = filterInput.value
        layoutGroup(groupRef)
      })
      // Persist collapse/expand as the user toggles the group open or shut.
      group.addEventListener('toggle', () => persist())
      facetGroups.push(groupRef)
    }
    facetsEl.replaceChildren(...facetGroups.map(g => g.details))
    syncReorderButtons()
  }

  /** Grey out the up arrow on the first group and the down arrow on the last. */
  function syncReorderButtons(): void {
    facetGroups.forEach((group, i) => {
      group.upBtn.disabled = i === 0
      group.downBtn.disabled = i === facetGroups.length - 1
    })
  }

  /**
   * Move a facet group one slot up (-1) or down (1). Reorders the live group
   * nodes in place (preserving their open/filter state), updates the saved order,
   * and persists — no facet rebuild needed.
   */
  function moveGroup(key: FacetKey, delta: -1 | 1): void {
    const from = facetGroups.findIndex(g => g.key === key)
    const to = from + delta
    if (from < 0 || to < 0 || to >= facetGroups.length)
      return
    const [moved] = facetGroups.splice(from, 1)
    facetGroups.splice(to, 0, moved!)
    facetsEl.replaceChildren(...facetGroups.map(g => g.details))
    // Rebuild the saved order: visible groups in their new order, then any facet
    // keys without a group on this page, kept in their prior relative position.
    const visibleOrder = facetGroups.map(g => g.key)
    const visibleSet = new Set(visibleOrder)
    facetOrder = [...visibleOrder, ...facetOrder.filter(k => !visibleSet.has(k))]
    syncReorderButtons()
    persist()
  }

  // --- Render ---------------------------------------------------------------

  /**
   * Put a group's value rows where {@link layoutFacetRows} says they go: the
   * selected ones in their direction's section, the rest below, with a line
   * under them when the cap left some out, and a row that doesn't show out of
   * the page altogether. Only the rows that change place are moved, and only
   * the rows that show are drawn (built, the first time), so a render that
   * shifts a few counts restyles a few rows, not every value a large list has.
   * Then the counts and which sections are open.
   */
  function layoutGroup(group: FacetGroupRef): void {
    group.body.classList.toggle(cx('sort-by-result'), group.valueSort === 'result')
    group.body.classList.toggle(cx('sort-by-count'), group.valueSort === 'count')
    group.body.classList.toggle(cx('sort-by-name'), group.valueSort === 'name')
    const sel = state.facets[group.key]
    const layout = layoutFacetRows(group.rows, sel, {
      query: group.query,
      sort: group.valueSort,
      dir: group.valueSortDir,
    })
    const draw = (row: FacetRowRef): HTMLElement => drawRow(group, row, sel)
    // While the reader types in the filter box every section opens, so a match
    // isn't found only to sit inside a shut one.
    const filtering = group.query.trim() !== ''
    // Sections first: a row moving out of one is taken from it before the
    // group body is laid out, and one moving in is taken from the body.
    for (const section of group.sections) {
      const rows = layout.sections[section.dir]
      placeChildren(section.body, rows.map(draw))
      section.el.classList.toggle(HIDDEN_CLASS, rows.length === 0)
      setText(section.countEl, String(rows.length))
      const open = filtering || isSectionOpen(group.key, section.dir)
      section.el.classList.toggle(cx('sel-open'), open)
      section.body.classList.toggle(HIDDEN_CLASS, !open)
      section.head.setAttribute('aria-expanded', String(open))
      section.head.title = `${open ? 'Hide' : 'Show'} ${SECTION_LABELS[section.dir].toLowerCase()} ${FACET_LABELS[group.key].toLowerCase()}`
    }
    const note = leftOutNote(layout)
    setText(group.leftOutEl, note ?? '')
    placeChildren(group.body, [
      ...group.sections.map(s => s.el),
      ...layout.rest.map(draw),
      ...(note ? [group.leftOutEl] : []),
    ])
    setText(group.countEl, groupCountText(layout.matching))
    group.details.classList.toggle(HIDDEN_CLASS, layout.relevant === 0)
  }

  /**
   * Switch a group's rows to sort by the clicked column (a count or the name);
   * clicking the one that's already active flips its direction. A fresh switch
   * starts descending for counts (highest first) but ascending for the name
   * (A→Z). Selection-first ordering is unaffected.
   */
  function setValueSort(group: FacetGroupRef, which: 'count' | 'result' | 'name'): void {
    if (group.valueSort === which) {
      group.valueSortDir = group.valueSortDir === 'desc' ? 'asc' : 'desc'
    }
    else {
      group.valueSort = which
      group.valueSortDir = which === 'name' ? 'asc' : 'desc'
    }
    layoutGroup(group)
  }

  /**
   * Bring a row's counts and toggles in line with its latest counts and the
   * group's selection, building its elements if it has none yet, and return
   * them. Writes are guarded, so an unchanged row touches no DOM.
   */
  function drawRow(group: FacetGroupRef, row: FacetRowRef, sel: FacetSelection): HTMLElement {
    const dom = row.dom ??= facetRowDom(group, row)
    setText(dom.countEl, String(row.count))
    setText(dom.resultCountEl, `(${row.resultCount})`)
    // Requiring a value narrows to the visible works that have it; if that's
    // zero (and it isn't already the required value), requiring it would wipe
    // the results — so disable the button to mark it a dead end.
    const wouldEmpty = row.resultCount === 0 && !sel.require.has(row.value)
    if (dom.requireBtn.disabled !== wouldEmpty) {
      dom.requireBtn.disabled = wouldEmpty
      dom.requireBtn.classList.toggle(cx('toggle-empty'), wouldEmpty)
    }
    for (const { dir, btn } of dom.buttons) {
      const active = sel[dir].has(row.value)
      if ((btn.getAttribute('aria-pressed') === 'true') !== active) {
        btn.classList.toggle(ACTIVE_CLASS, active)
        btn.setAttribute('aria-pressed', String(active))
      }
    }
    return dom.row
  }

  /**
   * Refresh the facet sidebar from precomputed drill-down counts: each value
   * takes its new counts, then {@link layoutGroup} decides what shows and draws
   * that. A row out of the page is drawn, or built, when it next shows.
   */
  function syncFacets(facetCounts: FacetCounts, resultCounts: FacetCounts): void {
    for (const group of facetGroups) {
      const groupCounts = facetCounts[group.key]
      const groupResultCounts = resultCounts[group.key]
      for (const row of group.rows) {
        row.count = groupCounts.get(row.value) ?? 0
        row.resultCount = groupResultCounts.get(row.value) ?? 0
      }
      layoutGroup(group)
    }
  }

  // The sort the cached `sortedWorks` was made under (`sort|dir`); '' forces a
  // re-sort. Filtering never reorders, so the works are only sorted again when
  // this changes.
  let sortSig = ''
  // Works whose blurbs are in the results list. A blurb is mounted the first
  // time its work lands on a page, and stays mounted (hidden when off the page)
  // until the works are replaced: a list of thousands only ever builds and lays
  // out the blurbs someone has paged to, and a work read back from storage has
  // no node at all until then.
  let mounted = new Set<Work>()
  // The works on the page currently shown, in the order their blurbs sit at the
  // end of the list — so an unchanged page touches no node at all.
  let shown: Work[] = []

  /**
   * Drop a work from the view, detach its node, and re-render over the reduced
   * set. Facet rows aren't rebuilt — a value that hit zero just hides via the
   * normal drill-down visibility — so the user's facet UI state (filter boxes,
   * collapsed groups) is preserved. Reports the work so the host can take it off
   * the stored copy.
   */
  function removeWork(workId: string): void {
    const work = works.find(w => w.workId === workId)
    if (!work)
      return
    const next = works.filter(w => w !== work)
    works = next
    gone.delete(workId)
    pool = resultsOf(works)
    if (mounted.delete(work)) {
      work.el.remove()
      decorated.delete(work.el)
    }
    sortSig = '' // force a re-sort over the reduced set
    render()
    config.onWorkRemoved?.(work)
  }

  /**
   * A filter (not sort/page) changed: jump back to the first page, then render.
   *
   * The reader asked for this, so a {@link SearchViewConfig.stablePages} view
   * lets go of its frozen layout here and lays the pages out afresh. Every
   * reshuffle a reader can see is one they started.
   */
  function filterChanged(): void {
    pageIndex = 0
    frozenOrder = null
    render()
  }

  /**
   * The sort or its direction changed. Ordinarily the page number is kept —
   * the reader is looking at the same results from another angle — but a frozen
   * layout is a *page* order, and there is nothing left of it once the sort
   * moves, so a stable-paged view treats it like any other thing the reader
   * dialled in.
   */
  function sortChanged(): void {
    if (stablePages)
      filterChanged()
    else
      render()
    persist()
  }

  /** Page numbers to show around the current one; `null` marks an elided gap. */
  function pageWindow(current: number, count: number): (number | null)[] {
    const keep = new Set<number>()
    for (let p = 1; p <= count; p++) {
      if (p === 1 || p === count || Math.abs(p - current) <= 1)
        keep.add(p)
    }
    const out: (number | null)[] = []
    let prev = 0
    for (const p of [...keep].sort((a, b) => a - b)) {
      if (prev && p - prev > 1)
        out.push(null)
      out.push(p)
      prev = p
    }
    return out
  }

  function goToPage(target: number): void {
    pageIndex = target
    render()
  }

  function renderPager(pageCount: number): void {
    if (pageCount <= 1) {
      pagerEl.replaceChildren()
      return
    }
    const current = pageIndex + 1
    const nav = (label: string, target: number, disabled: boolean, title: string): HTMLButtonElement => {
      const btn = (<button type="button" class={cx('page')} title={title}>{label}</button>) as HTMLElement as HTMLButtonElement
      btn.disabled = disabled
      if (!disabled)
        btn.addEventListener('click', () => goToPage(target))
      return btn
    }
    const nodes: HTMLElement[] = [nav('‹ Prev', pageIndex - 1, current === 1, 'Previous page')]
    for (const p of pageWindow(current, pageCount)) {
      if (p === null) {
        nodes.push((<span class={cx('page-gap')}>…</span>) as HTMLElement)
        continue
      }
      const btn = (<button type="button" class={cx('page')}>{String(p)}</button>) as HTMLElement as HTMLButtonElement
      if (p === current) {
        btn.classList.add(ACTIVE_CLASS)
        btn.setAttribute('aria-current', 'page')
      }
      else {
        btn.addEventListener('click', () => goToPage(p - 1))
      }
      nodes.push(btn)
    }
    nodes.push(nav('Next ›', pageIndex + 1, current === pageCount, 'Next page'))
    pagerEl.replaceChildren(...nodes)
  }

  function render(): void {
    const applied = textApplied
    const candidates = applied ? pool.filter(work => applied.hits.has(work.workId)) : pool
    const { visible, facetCounts, resultCounts } = computeView(candidates, state)

    // Re-sort (and cache the order) only when the sort changed or the works did —
    // filtering never reorders, so this stays off the hot path.
    const orderSig = `${state.sort}|${state.dir}`
    if (orderSig !== sortSig) {
      sortedWorks = sortWorks(works, state.sort, state.dir)
      sortSig = orderSig
    }

    // Visible works in sort order — or, for a view holding its layout, the works
    // its frozen order puts in each slot, some of them only holding the place.
    // Whatever this render lays out is then what the *next* one holds to, so a
    // collapsed work keeps its slot for as long as the reader stays put.
    const layout = frozenOrder === null ? null : layoutStablePages(frozenOrder, sortedWorks, visible, { gone, pageStart: pageIndex * perPage })
    const ordered = layout ? layout.ordered : sortedWorks.filter(w => visible.has(w))
    if (stablePages)
      frozenOrder = ordered.map(work => work.workId)
    const total = ordered.length
    const pageCount = Math.max(1, Math.ceil(total / perPage))
    pageIndex = Math.min(Math.max(pageIndex, 0), pageCount - 1)
    const start = pageIndex * perPage
    const page = ordered.slice(start, start + perPage)
    const onPage = new Set(page)

    // Only the current page is shown, and only blurbs that have been on a page
    // are in the list at all; the rest of what's mounted is display:none, so the
    // browser lays out / paints at most `perPage` heavy blurbs no matter how
    // many match. This is what keeps filtering responsive on large lists.
    const unchanged = page.length === shown.length && page.every((work, i) => work === shown[i])
    let added = false
    if (!unchanged) {
      for (const work of shown) {
        if (!onPage.has(work) && mounted.has(work))
          work.el.classList.add(HIDDEN_CLASS)
      }
      for (const work of page) {
        if (!mounted.has(work)) {
          mounted.add(work)
          added = true
        }
        work.el.classList.remove(HIDDEN_CLASS)
        // Appended in page order: the page reads in sort order at the end of the
        // list, whatever order the hidden blurbs before it were mounted in.
        resultsOl.append(work.el)
      }
      shown = page
    }

    // New blurbs in the list: wire the context-menu toolbars over it again. They
    // keep one registry for the whole list and start it afresh each run, and
    // they take up the indicators an earlier run left rather than adding more.
    if (added)
      config.decorateContainer?.(resultsOl)

    // Decorate the page's blurbs the first time they're shown (kudos ratio, etc.)
    // and attach the optional per-blurb action.
    for (const work of page) {
      if (decorated.has(work.el))
        continue
      decorated.add(work.el)
      const drop = layout?.dropped.get(work)
      // Left to itself, the hiding decoration would take a work the rules now
      // cover off the page altogether, and the slot kept for it would be blank.
      // The stamp that says a search filter has taken the reason over is also
      // what asks it to collapse the work instead, to a line naming the rule or
      // mark responsible — better than anything this view could word.
      if (drop === 'hidden')
        work.el.dataset.ao3eFiltered = ''
      config.decorateBlurb?.(work.el)
      if (drop) {
        collapsedInPlace.add(work)
        // A no-op when the hiding decoration has already drawn its own line, so
        // this covers the reasons it has nothing to say about: a filter that
        // stopped admitting the work, and a rule while hiding is switched off.
        config.collapseWork?.(work.el, drop === 'gone' ? config.goneReason ?? DROP_REASONS.gone : DROP_REASONS[drop])
      }
    }
    syncSnippets(page)

    const noun = total === 1 ? 'work' : 'works'
    if (total === 0) {
      countEl.textContent = `No ${pool.length === 1 ? 'work' : 'works'} match`
    }
    else {
      const range = `${start + 1}–${start + onPage.size}`
      const countStr = pool.length > total ? `${total} (${pool.length})` : String(total)
      countEl.textContent = `Showing ${range} of ${countStr} ${noun}`
    }
    renderPager(pageCount)
    syncFacets(facetCounts, resultCounts)
    config.onRendered?.()
  }

  /**
   * Empty the results list for a new set of works. Nothing is mounted here:
   * {@link render} mounts each blurb when its work first lands on a page, and
   * wires the context-menu toolbars over whatever it mounted.
   */
  function mountResults(): void {
    resultsOl.replaceChildren()
    mounted = new Set()
    shown = []
    // A fresh set's blurbs are drawn from scratch, excerpts and all.
    for (const el of snippetEls.values())
      el.remove()
    snippetEls.clear()
    sortSig = '' // new works; force a re-sort.
  }

  function update(nextWorks: Work[], nextAutoExcludes?: FacetValueRef[], opts: { force?: boolean } = {}): void {
    // A frozen layout and a fresh list are the same question asked twice: the
    // swap goes to page 1 over works the reader has not been through, which is
    // exactly the place they were keeping. So it is offered rather than taken —
    // but only to a host that can do the offering, and only when the swap isn't
    // the reader's own answer coming back.
    if (stablePages && !opts.force && config.onUpdateDeferred) {
      config.onUpdateDeferred({
        works: nextWorks,
        apply: () => update(nextWorks, nextAutoExcludes, { force: true }),
      })
      return
    }
    works = nextWorks
    gone = new Set()
    pool = resultsOf(works)
    // The same work can be a proper result in the new set, and it brings the
    // blurb this view collapsed along with it. Take it back to the markup the
    // store keeps, so the decoration below runs over it again from scratch.
    for (const work of collapsedInPlace) {
      if (hasNode(work)) {
        pristineBlurb(work.el, { inPlace: true })
        decorated.delete(work.el)
      }
    }
    collapsedInPlace.clear()
    if (nextAutoExcludes)
      setAutoExcludes(nextAutoExcludes)
    // Drop selections for values that no longer exist so the UI stays honest.
    const present = buildFacets(pool)
    for (const key of FACET_KEYS) {
      const valid = new Set(present[key].map(v => v.value))
      for (const dir of ['include', 'exclude', 'require'] as const) {
        for (const value of [...state.facets[key][dir]]) {
          if (!valid.has(value))
            state.facets[key][dir].delete(value)
        }
      }
    }
    // After the prune, not before: these values are carried by works this set
    // still holds, so nothing here drops them, but the order says which wins.
    applyAutoExcludes()
    pageIndex = 0 // fresh data — start at the first page
    // …and a new layout, since the old one was about works that have gone.
    frozenOrder = null
    mountResults()
    renderFacets()
    render()
    // Selections may have been dropped just above; the re-mounted blurbs are
    // decorated fresh, but anything else watching the filter needs telling.
    notifyFacetChange()
    // The works the text was searched over have changed under it.
    const textQuery = textRun?.query ?? textApplied?.query
    if (textQuery)
      searchText(textQuery, { restore: true })
    else
      showTextCoverage()
  }

  function merge(added: Work[], goneIds: ReadonlySet<string>, nextAutoExcludes?: FacetValueRef[]): void {
    const held = new Map(works.map(work => [work.workId, work]))
    const addedIds = new Set(added.map(work => work.workId))
    const fresh: Work[] = []
    const changed: Work[] = []
    /** Works newly among the results: the text search has yet to look at them. */
    const unsearched: Work[] = []
    for (const work of added) {
      const had = held.get(work.workId)
      if (!had) {
        held.set(work.workId, work)
        gone.delete(work.workId)
        fresh.push(work)
        unsearched.push(work)
      }
      else if (gone.delete(work.workId)) {
        changed.push(had)
        unsearched.push(had)
      }
    }
    for (const id of goneIds) {
      const work = held.get(id)
      if (work && !addedIds.has(id) && !gone.has(id)) {
        gone.add(id)
        changed.push(work)
      }
    }
    if (!fresh.length && !changed.length)
      return
    works = [...works, ...fresh]
    pool = resultsOf(works)
    if (nextAutoExcludes) {
      setAutoExcludes(nextAutoExcludes)
      applyAutoExcludes()
    }
    // A work whose slot changes what it says is drawn again from the markup the
    // store keeps, so the decoration runs over it afresh.
    for (const work of changed) {
      if (hasNode(work) && decorated.has(work.el)) {
        pristineBlurb(work.el, { inPlace: true })
        decorated.delete(work.el)
        collapsedInPlace.delete(work)
      }
    }
    sortSig = ''
    renderFacets()
    render()
    searchAdded(unsearched)
  }

  /**
   * Run the applied work-text search over works just added, and add what it
   * finds to its hits: the works it has already searched answer as before. A
   * search still under way starts again over everything, the added works
   * included.
   */
  function searchAdded(added: Work[]): void {
    if (textRun) {
      searchText(textRun.query, { restore: true })
      return
    }
    const applied = textApplied
    if (!textSearch || !applied || !added.length) {
      showTextCoverage()
      return
    }
    void textSearch.search(added.map(work => work.workId), applied.query).then(({ hits }) => {
      if (textApplied !== applied || textRun || !hits.size)
        return
      for (const work of added) {
        if (!hits.has(work.workId))
          continue
        applied.hits.add(work.workId)
        // Drawn collapsed while the search hadn't looked at it yet.
        if (collapsedInPlace.delete(work) && hasNode(work)) {
          pristineBlurb(work.el, { inPlace: true })
          decorated.delete(work.el)
        }
      }
      render()
    }, (error: unknown) => {
      console.error('[searchView] could not search the works added', error)
    })
  }

  function setUpdating(updating: boolean, opts: { text?: string | null, onStop?: () => void } = {}): void {
    updatingText.textContent = opts.text || 'Updating…'
    onUpdatingStop = updating ? opts.onStop : undefined
    updatingStop.hidden = !onUpdatingStop
    updatingEl.classList.toggle(cx('updating-on'), updating)
    refreshBtn?.classList.toggle(cx('refresh-spinning'), updating)
  }

  function setRefreshedAt(at: number): void {
    refreshedAt = at
  }

  function getState(): ViewState {
    const facetQueries: Partial<Record<FacetKey, string>> = {}
    const collapsedFacets: FacetKey[] = []
    for (const group of facetGroups) {
      if (group.query)
        facetQueries[group.key] = group.query
      if (!(group.details as HTMLDetailsElement).open)
        collapsedFacets.push(group.key)
    }
    return {
      filter: cloneFilterState(state),
      pageIndex,
      facetQueries,
      collapsedFacets,
      releasedAutoExcludes: [...released],
      openSelections: Object.fromEntries(openSelections),
      // Only a view that holds its layout has one to hand on; for anything else
      // recording it would be an invitation to honour it later.
      ...(frozenOrder ? { order: [...frozenOrder] } : {}),
      ...(gone.size ? { gone: [...gone] } : {}),
      ...(textInput?.value
        ? { workText: { query: textInput.value, ...(textApplied ? { hits: [...textApplied.hits] } : {}) } }
        : {}),
    }
  }

  // --- Assemble -------------------------------------------------------------

  // The exclusions the reader's hide rules imply, before the first render, so
  // the works they cover never reach a page.
  applyAutoExcludes()

  // Let shared blurb decorators (e.g. the required-tags menu) drive this view's
  // in-memory facets when they act on a blurb inside it, instead of the page's
  // native filter sidebar. Registered before the first decorateContainer run.
  registerFacetBridge(resultsOl, {
    isSelected: (key, dir, value) => state.facets[key][dir].has(value),
    toggle: (key, dir, value) => toggleSelection(key, dir, value),
    has: (key, value) => pool.some(work => facetValues(work, key).includes(value)),
    getWordCount: () => state.wordsMin === null && state.wordsMax === null
      ? null
      : { from: state.wordsMin, to: state.wordsMax },
    setWordCount: (range) => {
      state.wordsMin = range?.from ?? null
      state.wordsMax = range?.to ?? null
      // The sidebar inputs are the same filter shown a second time — keep them
      // in step, since the range was picked from a blurb rather than typed here.
      minInput.value = state.wordsMin != null ? String(state.wordsMin) : ''
      maxInput.value = state.wordsMax != null ? String(state.wordsMax) : ''
      filterChanged()
    },
    getCompletion: () => completionOf(state.facets.completion),
    setCompletion: (completion) => {
      // AO3's filter is one choice of three, so the pick replaces whatever the
      // group held rather than adding to it — the facet rows then show it as
      // one included value.
      const sel = state.facets.completion
      for (const value of sel.exclude) {
        if (autoKeys.has(`completion:${value}`))
          released.add(`completion:${value}`)
      }
      for (const dir of FACET_DIRS)
        sel[dir].clear()
      if (completion)
        sel.include.add(completionValue(completion))
      filterChanged()
      notifyFacetChange()
    },
  })

  mountResults()
  renderFacets()
  render()
  if (restoredText && parseTextQuery(restoredText.query).length)
    searchText(restoredText.query, { restore: true })
  else
    showTextCoverage()

  const el = (
    <div class={`${ADDON_CLASS}  ${ROOT}`}>
      <div class={cx('toolbar')}>
        {backBtn}
        {countEl}
        {refreshBtn}
        {updatingEl}
      </div>
      <div class={cx('layout')}>
        <aside class={cx('sidebar')}>
          <div class={cx('field')}>
            <label class={cx('label')}>Search</label>
            {searchInput}
          </div>
          {textInput && (
            <div class={cx('field')}>
              <label class={cx('label')}>Search inside works</label>
              {textInput}
              {textStatus}
            </div>
          )}
          <div class={cx('field')}>
            <label class={cx('label')}>Sort by</label>
            <div class={cx('sort-row')}>
              {sortSelect}
              {dirBtn}
            </div>
          </div>
          <div class={cx('field')}>
            <label class={cx('label')}>Word count</label>
            <div class={cx('words')}>
              {minInput}
              <span class={cx('words-dash')}>–</span>
              {maxInput}
            </div>
          </div>
          {resetBtn}
          {facetsEl}
        </aside>
        {resizerEl}
        <div class={cx('main')}>
          {resultsOl}
          {pagerEl}
        </div>
      </div>
    </div>
  ) as HTMLElement

  layoutEl = el.querySelector<HTMLElement>(`.${cx('layout')}`)
  applySidebarWidth()

  return {
    el,
    update,
    setUpdating,
    setRefreshedAt,
    getState,
    getReaderFilter: () => readerFilter(state, autoKeys, released),
    getWorks: () => works,
    remove: removeWork,
    merge,
  }
}
