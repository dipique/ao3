import MdiArrowLeft from '~icons/mdi/arrow-left.jsx'
import MdiCheckCircle from '~icons/mdi/check-circle.jsx'
import MdiChevronDown from '~icons/mdi/chevron-down.jsx'
import MdiChevronUp from '~icons/mdi/chevron-up.jsx'
import MdiMinusCircle from '~icons/mdi/minus-circle.jsx'
import MdiPlusCircle from '~icons/mdi/plus-circle.jsx'
import MdiRefresh from '~icons/mdi/refresh.jsx'

import type { Work } from '#content_script/blurb.js'

import { ADDON_CLASS } from '#common'
import React from '#dom'

import type { FacetCounts, FacetDir, FacetKey, FacetValueCount, FilterState, SortKey } from './engine.ts'
import type { SearchViewPrefs } from './prefs.ts'

import {
  buildFacets,
  cloneFilterState,
  computeView,
  emptyFilterState,
  FACET_KEYS,
  FACET_LABELS,
  SORT_LABELS,
  sortWorks,
} from './engine.ts'
import { registerFacetBridge } from './facetBridge.ts'

const ROOT = `${ADDON_CLASS}--search-view`
const cx = (suffix: string): string => `${ROOT}--${suffix}`
const HIDDEN_CLASS = cx('hidden')
const ACTIVE_CLASS = cx('active')

export interface SearchViewHandlers {
  /** Restore the native page (remove the aggregated view). */
  onBack: () => void
  /** Re-scrape from the source and feed the result back via {@link SearchView.update}. */
  onRefresh: () => void
}

/** A snapshot of what the user has dialled in, so the view can be rebuilt as-is. */
export interface ViewState {
  filter: FilterState
  pageIndex: number
  /** Per-facet "contains" filter box text, keyed by facet (omitted when empty). */
  facetQueries: Partial<Record<FacetKey, string>>
  /** Facet groups the user had collapsed (the rest default open). */
  collapsedFacets: FacetKey[]
}

export interface SearchView {
  /** The view root — insert this into the page. */
  el: HTMLElement
  /** Swap in freshly scraped works (e.g. after a background refresh), keeping filters. */
  update: (works: Work[]) => void
  /** Toggle the subtle "updating in the background" indicator. */
  setUpdating: (updating: boolean) => void
  /** Current filter/sort/page, so a caller can rebuild the view where it left off. */
  getState: () => ViewState
}

/**
 * An optional per-blurb action button (e.g. "Mark as Read"). `run` performs the
 * side effect for one work; if it resolves, the view drops that work from the
 * list (and reports the new set via {@link SearchViewConfig.onWorksChanged}). A
 * rejection leaves the work in place — the action is assumed to have surfaced its
 * own error. The button is disabled while `run` is pending.
 */
export interface BlurbAction {
  label: string
  title?: string
  run: (work: Work) => Promise<void>
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
  /** A per-work action button added to every blurb (see {@link BlurbAction}). */
  blurbAction?: BlurbAction
  /** Called after a {@link BlurbAction} removes a work, so the host can persist. */
  onWorksChanged?: (works: Work[]) => void
  /** Restore a prior {@link SearchView.getState} snapshot (filters, sort, page). */
  initialState?: ViewState
  /**
   * Local (never-synced) layout prefs restored on open: collapsed facet groups,
   * custom facet order, and last sort. Seeded from {@link onPrefsChange}'s prior
   * output. `initialState` (an in-memory reopen) wins over these for the fields
   * they share, since it reflects exactly what the user last had on screen.
   */
  prefs?: Partial<SearchViewPrefs>
  /** Called whenever a persisted layout pref changes (collapse, sort, reorder). */
  onPrefsChange?: (prefs: SearchViewPrefs) => void
}

const DEFAULT_PER_PAGE = 50

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout>
  return (...args: A) => {
    clearTimeout(timer)
    timer = setTimeout(fn, ms, ...args)
  }
}

/** Parse a word-count bound; blank/invalid -> null (unbounded). */
function parseBound(value: string): number | null {
  const digits = value.replace(/\D/g, '')
  return value.trim() === '' || digits === '' ? null : Number(digits)
}

/**
 * The facet keys in the user's saved order, with any keys missing from it
 * appended in their default position — so a saved order stays valid even as facet
 * keys are added or removed across versions.
 */
function orderFacetKeys(saved: readonly string[] | undefined): FacetKey[] {
  if (!saved || saved.length === 0)
    return [...FACET_KEYS]
  const known = new Set<string>(FACET_KEYS)
  const seen = new Set<FacetKey>()
  const ordered: FacetKey[] = []
  for (const key of saved) {
    if (known.has(key) && !seen.has(key as FacetKey)) {
      ordered.push(key as FacetKey)
      seen.add(key as FacetKey)
    }
  }
  for (const key of FACET_KEYS) {
    if (!seen.has(key))
      ordered.push(key)
  }
  return ordered
}

/**
 * Build a self-contained, filterable/sortable view over a list of works. Pure
 * UI: it knows nothing about where the works came from, so it is reusable for
 * any aggregated AO3 listing. The caller mounts {@link SearchView.el} and, for a
 * background refresh, calls {@link SearchView.update} with the new works.
 */
export function createSearchView(initialWorks: Work[], handlers: SearchViewHandlers, config: SearchViewConfig = {}): SearchView {
  let works = initialWorks
  // Restore a prior snapshot (e.g. after a global re-run reopened the view), else
  // start blank. cloneFilterState so we never mutate the caller's snapshot.
  const state: FilterState = config.initialState ? cloneFilterState(config.initialState.filter) : emptyFilterState()
  // Seed the sort from saved prefs on a fresh open. An in-memory reopen
  // (initialState) already carries the user's live sort, so it wins.
  if (!config.initialState && config.prefs) {
    if (config.prefs.sort)
      state.sort = config.prefs.sort
    if (config.prefs.dir)
      state.dir = config.prefs.dir
  }
  // The user's custom facet-group order (persisted locally), applied on every
  // (re)build and mutated by the per-group reorder arrows.
  let facetOrder: FacetKey[] = orderFacetKeys(config.prefs?.order)
  const perPage = Math.max(1, config.perPage ?? DEFAULT_PER_PAGE)
  // Current page (0-based). Sorted full set is cached; filtering never reorders.
  let pageIndex = config.initialState?.pageIndex ?? 0
  let sortedWorks: Work[] = works
  // Blurbs already run through config.decorateBlurb, so each is decorated at most
  // once (and only when first shown). A WeakSet so replaced works are forgotten.
  const decorated = new WeakSet<HTMLElement>()
  // Restore the per-group facet UI (filter text, collapsed groups) once, on the
  // first build; later rebuilds (a refresh) start the facet UI fresh.
  let facetUiRestored = false

  // Registry of facet rows, rebuilt whenever the facet list changes, so render()
  // can sync toggle state and live drill-down counts against the current filter
  // without re-creating the DOM (which would reset the open/closed groups).
  interface FacetRowRef {
    value: string
    /** Lowercased value, precomputed for the per-group "contains" filter. */
    lower: string
    row: HTMLElement
    /** Drill-down count: results you'd get if you also *included* this value. */
    countEl: HTMLElement
    /** Result count: results remaining if you additionally *required* this value. */
    resultCountEl: HTMLElement
    /** Latest drill-down count, updated by syncFacets() and read for visibility. */
    count: number
    /** The require button, toggled disabled when requiring would empty results. */
    requireBtn: HTMLButtonElement
    buttons: { dir: FacetDir, btn: HTMLButtonElement }[]
  }
  interface FacetGroupRef {
    key: FacetKey
    details: HTMLElement
    countEl: HTMLElement
    rows: FacetRowRef[]
    /** This group's value-filter box, if it's large enough to have one. */
    filter: HTMLInputElement | null
    /** Current text in this group's value filter. */
    query: string
    /** The reorder arrows, disabled at the ends of the list. */
    upBtn: HTMLButtonElement
    downBtn: HTMLButtonElement
  }
  // Large groups (> this many values) get a "contains" filter box for their values.
  const FACET_FILTER_THRESHOLD = 10
  let facetGroups: FacetGroupRef[] = []

  /** Snapshot the persistable layout prefs (collapse/order/sort) to the host. */
  function persist(): void {
    if (!config.onPrefsChange)
      return
    const collapsed = facetGroups
      .filter(g => !(g.details as HTMLDetailsElement).open)
      .map(g => g.key)
    config.onPrefsChange({ collapsed, order: [...facetOrder], sort: state.sort, dir: state.dir })
  }

  const countEl = (<span class={cx('count')} />) as HTMLElement
  const updatingEl = (<span class={cx('updating')}>Updating…</span>) as HTMLElement
  const resultsOl = (<ol class={`work index group ${cx('results')}`} />) as HTMLElement as HTMLOListElement
  const facetsEl = (<div class={cx('facets')} />) as HTMLElement
  const pagerEl = (<nav class={cx('pager')} aria-label="Results pages" />) as HTMLElement

  // --- Controls -------------------------------------------------------------

  const searchInput = (
    <input type="search" class={cx('input')} placeholder="Title, author, summary, tags…" aria-label="Search works" />
  ) as HTMLElement as HTMLInputElement
  searchInput.value = state.text
  searchInput.addEventListener('input', debounce(() => {
    state.text = searchInput.value
    filterChanged()
  }, 120))

  const sortSelect = (
    <select class={cx('select')} aria-label="Sort by">
      {(Object.keys(SORT_LABELS) as SortKey[]).map(key => <option value={key}>{SORT_LABELS[key]}</option>)}
    </select>
  ) as HTMLElement as HTMLSelectElement
  sortSelect.value = state.sort
  sortSelect.addEventListener('change', () => {
    state.sort = sortSelect.value as SortKey
    render()
    persist()
  })

  const dirBtn = (<button type="button" class={cx('dir')} />) as HTMLElement as HTMLButtonElement
  function syncDir(): void {
    dirBtn.textContent = state.dir === 'asc' ? '↑ Asc' : '↓ Desc'
    dirBtn.title = state.dir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'
  }
  dirBtn.addEventListener('click', () => {
    state.dir = state.dir === 'asc' ? 'desc' : 'asc'
    syncDir()
    render()
    persist()
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
    state.wordsMin = null
    state.wordsMax = null
    state.sort = fresh.sort
    state.dir = fresh.dir
    searchInput.value = ''
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
    // Sort reset to default is a visible change; keep the stored pref in step.
    persist()
  })

  const backBtn = (
    <button type="button" class={cx('back')}>
      <MdiArrowLeft />
      {' '}
      Back to list
    </button>
  ) as HTMLElement as HTMLButtonElement
  backBtn.addEventListener('click', handlers.onBack)
  const refreshBtn = (
    <button type="button" class={cx('refresh')}>
      <MdiRefresh />
      {' '}
      Refresh
    </button>
  ) as HTMLElement as HTMLButtonElement
  refreshBtn.addEventListener('click', handlers.onRefresh)

  // --- Facets ---------------------------------------------------------------

  const FACET_DIRS: FacetDir[] = ['require', 'include', 'exclude']

  function toggleSelection(key: FacetKey, dir: FacetDir, value: string): void {
    const sel = state.facets[key][dir]
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
    filterChanged()
  }

  function facetRow(key: FacetKey, { value, count }: FacetValueCount): FacetRowRef {
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
    const countEl = (<span class={cx('row-count')} title="Results if you include this value">{String(count)}</span>) as HTMLElement
    const resultCountEl = (<span class={cx('row-result-count')} title="Results remaining if you require this value">{`(${count})`}</span>) as HTMLElement
    const row = (
      <div class={cx('row')}>
        <span class={cx('row-toggles')}>
          {require}
          {include}
          {exclude}
        </span>
        <span class={cx('row-name')} title={value}>{value}</span>
        {countEl}
        {resultCountEl}
      </div>
    ) as HTMLElement

    return {
      value,
      lower: value.toLowerCase(),
      row,
      countEl,
      resultCountEl,
      count,
      requireBtn: require,
      buttons: [{ dir: 'require', btn: require }, { dir: 'include', btn: include }, { dir: 'exclude', btn: exclude }],
    }
  }

  function renderFacets(): void {
    facetGroups = []
    // Row identity/order is fixed from the full set; render() updates the live
    // drill-down counts and hides rows that no longer match the active filter.
    const facets = buildFacets(works)
    // Restore the saved facet UI only on the first build; consume it. An in-memory
    // reopen (initialState) wins; otherwise the persisted local prefs seed the
    // collapsed groups on a fresh open.
    const firstBuild = !facetUiRestored
    const restore = firstBuild ? config.initialState : null
    const prefCollapsed = firstBuild && !restore ? new Set(config.prefs?.collapsed ?? []) : null
    facetUiRestored = true
    for (const key of facetOrder) {
      const values = facets[key]
      if (!values.length)
        continue
      const rows = values.map(value => facetRow(key, value))
      const groupCountEl = (<span class={cx('group-count')}>{String(values.length)}</span>) as HTMLElement
      // Long value lists (tags, fandoms, characters…) get a "contains" filter.
      const label = FACET_LABELS[key].toLowerCase()
      const filterInput = values.length > FACET_FILTER_THRESHOLD
        ? (<input type="search" class={cx('group-filter')} placeholder={`Filter ${label}…`} aria-label={`Filter ${FACET_LABELS[key]}`} />) as HTMLElement as HTMLInputElement
        : null
      // Apply any restored filter text / collapsed state for this group.
      const savedQuery = filterInput ? (restore?.facetQueries[key] ?? '') : ''
      if (filterInput)
        filterInput.value = savedQuery
      const collapsed = restore
        ? restore.collapsedFacets.includes(key)
        : (prefCollapsed?.has(key) ?? false)
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
          <div class={cx('group-body')}>{rows.map(r => r.row)}</div>
        </details>
      ) as HTMLElement
      const groupRef: FacetGroupRef = { key, details: group, countEl: groupCountEl, rows, filter: filterInput, query: savedQuery, upBtn, downBtn }
      filterInput?.addEventListener('input', () => {
        groupRef.query = filterInput.value
        applyGroupVisibility(groupRef)
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
   * Show/hide a group's value rows from its current drill-down counts and value
   * filter: a row shows when it still has matching works (or is selected, so it
   * can be toggled off) *and* contains the filter text. The group count tracks
   * the visible rows; the whole group hides only when no value passes the
   * drill-down filter — never merely because the text filter excluded them all,
   * which would also hide the filter box and trap the user.
   */
  function applyGroupVisibility(group: FacetGroupRef): void {
    const sel = state.facets[group.key]
    const q = group.query.trim().toLowerCase()
    let relevant = 0
    let shown = 0
    for (const row of group.rows) {
      const selected = sel.include.has(row.value) || sel.exclude.has(row.value) || sel.require.has(row.value)
      const drillMatch = row.count > 0 || selected
      if (drillMatch)
        relevant++
      const show = drillMatch && (q === '' || row.lower.includes(q))
      row.row.classList.toggle(HIDDEN_CLASS, !show)
      if (show)
        shown++
    }
    group.countEl.textContent = String(shown)
    group.details.classList.toggle(HIDDEN_CLASS, relevant === 0)
  }

  /**
   * Refresh the facet sidebar from precomputed drill-down counts: each value's
   * count and toggle state is synced, then {@link applyGroupVisibility} decides
   * what stays visible. Count writes are guarded so an unchanged row touches no
   * DOM.
   */
  function syncFacets(facetCounts: FacetCounts, resultCounts: FacetCounts): void {
    for (const group of facetGroups) {
      const sel = state.facets[group.key]
      const groupCounts = facetCounts[group.key]
      const groupResultCounts = resultCounts[group.key]
      for (const row of group.rows) {
        row.count = groupCounts.get(row.value) ?? 0
        const text = String(row.count)
        if (row.countEl.textContent !== text)
          row.countEl.textContent = text
        const resultCount = groupResultCounts.get(row.value) ?? 0
        const resultText = `(${resultCount})`
        if (row.resultCountEl.textContent !== resultText)
          row.resultCountEl.textContent = resultText
        // Requiring a value narrows to the visible works that have it; if that's
        // zero (and it isn't already the required value), requiring it would wipe
        // the results — so disable the button to mark it a dead end.
        const wouldEmpty = resultCount === 0 && !sel.require.has(row.value)
        if (row.requireBtn.disabled !== wouldEmpty) {
          row.requireBtn.disabled = wouldEmpty
          row.requireBtn.classList.toggle(cx('toggle-empty'), wouldEmpty)
        }
        for (const { dir, btn } of row.buttons) {
          const active = sel[dir].has(row.value)
          if ((btn.getAttribute('aria-pressed') === 'true') !== active) {
            btn.classList.toggle(ACTIVE_CLASS, active)
            btn.setAttribute('aria-pressed', String(active))
          }
        }
      }
      applyGroupVisibility(group)
    }
  }

  // The DOM order currently applied to the results list (`sort|dir`); '' forces a
  // re-sort. Filtering never reorders, so we only touch node order when this
  // changes — moving 400 heavy blurbs on every keystroke was the filter lag.
  let domOrderSig = ''

  /**
   * Add the per-blurb action button to one blurb. On click it disables itself,
   * runs the action, and — only if that resolves — removes the work from the
   * view. A rejection re-enables the button (the action surfaced its own error).
   * The button goes into the blurb's native `ul.actions` list when present, so it
   * sits with AO3's own per-work controls; otherwise it's appended to the blurb.
   */
  function injectBlurbAction(work: Work, action: BlurbAction): void {
    const btn = (
      <button type="button" class={cx('blurb-action')} title={action.title ?? action.label}>{action.label}</button>
    ) as HTMLElement as HTMLButtonElement
    btn.addEventListener('click', () => {
      if (btn.disabled)
        return
      btn.disabled = true
      btn.classList.add(cx('blurb-action-busy'))
      void action.run(work)
        .then(() => removeWork(work))
        .catch(() => {
          btn.disabled = false
          btn.classList.remove(cx('blurb-action-busy'))
        })
    })
    const actions = work.el.querySelector('ul.actions')
    if (actions)
      actions.prepend((<li class={ADDON_CLASS}>{btn}</li>) as HTMLElement)
    else
      work.el.append((<div class={`${ADDON_CLASS}  ${cx('blurb-actions')}`}>{btn}</div>) as HTMLElement)
  }

  /**
   * Drop a work from the view (a blurbAction removed it), detach its node, and
   * re-render over the reduced set. Facet rows aren't rebuilt — a value that hit
   * zero just hides via the normal drill-down visibility — so the user's facet UI
   * state (filter boxes, collapsed groups) is preserved. Reports the new set so
   * the host can persist it.
   */
  function removeWork(work: Work): void {
    const next = works.filter(w => w !== work)
    if (next.length === works.length)
      return
    works = next
    work.el.remove()
    decorated.delete(work.el)
    domOrderSig = '' // force a re-sort/re-append over the reduced set
    render()
    config.onWorksChanged?.(works)
  }

  /** A filter (not sort/page) changed: jump back to the first page, then render. */
  function filterChanged(): void {
    pageIndex = 0
    render()
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
    const { visible, facetCounts, resultCounts } = computeView(works, state)

    // Re-sort the DOM (and cache the order) only when the sort changed or we
    // re-mounted — filtering never reorders, so this stays off the hot path.
    const orderSig = `${state.sort}|${state.dir}`
    if (orderSig !== domOrderSig) {
      sortedWorks = sortWorks(works, state.sort, state.dir)
      for (const work of sortedWorks)
        resultsOl.append(work.el)
      domOrderSig = orderSig
    }

    // Visible works in sort order, then the current page's slice.
    const ordered = sortedWorks.filter(w => visible.has(w))
    const total = ordered.length
    const pageCount = Math.max(1, Math.ceil(total / perPage))
    pageIndex = Math.min(Math.max(pageIndex, 0), pageCount - 1)
    const start = pageIndex * perPage
    const onPage = new Set(ordered.slice(start, start + perPage))

    // Only the current page is shown; everything else is display:none, so the
    // browser lays out / paints at most `perPage` heavy blurbs no matter how
    // many match. This is what keeps filtering responsive on large lists.
    for (const work of works)
      work.el.classList.toggle(HIDDEN_CLASS, !onPage.has(work))

    // Decorate the page's blurbs the first time they're shown (kudos ratio, etc.)
    // and attach the optional per-blurb action.
    for (const work of onPage) {
      if (decorated.has(work.el))
        continue
      decorated.add(work.el)
      config.decorateBlurb?.(work.el)
      if (config.blurbAction)
        injectBlurbAction(work, config.blurbAction)
    }

    const noun = total === 1 ? 'work' : 'works'
    countEl.textContent = total === 0
      ? `No ${works.length === 1 ? 'work' : 'works'} match`
      : `Showing ${start + 1}–${start + onPage.size} of ${total} ${noun}`
    renderPager(pageCount)
    syncFacets(facetCounts, resultCounts)
  }

  function mountResults(): void {
    resultsOl.replaceChildren(...works.map(work => work.el))
    domOrderSig = '' // re-mounted nodes are in array order; force a re-sort.
    // Wire the context-menu toolbars over the whole (re-)mounted list once.
    config.decorateContainer?.(resultsOl)
  }

  function update(nextWorks: Work[]): void {
    works = nextWorks
    // Drop selections for values that no longer exist so the UI stays honest.
    const present = buildFacets(works)
    for (const key of FACET_KEYS) {
      const valid = new Set(present[key].map(v => v.value))
      for (const dir of ['include', 'exclude', 'require'] as const) {
        for (const value of [...state.facets[key][dir]]) {
          if (!valid.has(value))
            state.facets[key][dir].delete(value)
        }
      }
    }
    pageIndex = 0 // fresh data — start at the first page
    mountResults()
    renderFacets()
    render()
  }

  function setUpdating(updating: boolean): void {
    updatingEl.classList.toggle(cx('updating-on'), updating)
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
    return { filter: cloneFilterState(state), pageIndex, facetQueries, collapsedFacets }
  }

  // --- Assemble -------------------------------------------------------------

  // Let shared blurb decorators (e.g. the required-tags menu) drive this view's
  // in-memory facets when they act on a blurb inside it, instead of the page's
  // native filter sidebar. Registered before the first decorateContainer run.
  registerFacetBridge(resultsOl, {
    isSelected: (key, dir, value) => state.facets[key][dir].has(value),
    toggle: (key, dir, value) => toggleSelection(key, dir, value),
  })

  mountResults()
  renderFacets()
  render()

  const el = (
    <div class={`${ADDON_CLASS}  ${ROOT}`}>
      <div class={cx('toolbar')}>
        {backBtn}
        {countEl}
        {updatingEl}
        {refreshBtn}
      </div>
      <div class={cx('layout')}>
        <aside class={cx('sidebar')}>
          <div class={cx('field')}>
            <label class={cx('label')}>Search</label>
            {searchInput}
          </div>
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
        <div class={cx('main')}>
          {resultsOl}
          {pagerEl}
        </div>
      </div>
    </div>
  ) as HTMLElement

  return { el, update, setUpdating, getState }
}
