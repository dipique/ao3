import MdiArrowLeft from '~icons/mdi/arrow-left.jsx'
import MdiMinusCircle from '~icons/mdi/minus-circle.jsx'
import MdiPlusCircle from '~icons/mdi/plus-circle.jsx'
import MdiRefresh from '~icons/mdi/refresh.jsx'

import type { Work } from '#content_script/blurb.js'

import { ADDON_CLASS } from '#common'
import React from '#dom'

import type { FacetKey, FacetValueCount, FilterState, SortKey } from './engine.ts'

import {
  applyFilters,
  buildFacets,
  emptyFilterState,
  FACET_KEYS,
  FACET_LABELS,
  SORT_LABELS,
} from './engine.ts'

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

export interface SearchView {
  /** The view root — insert this into the page. */
  el: HTMLElement
  /** Swap in freshly scraped works (e.g. after a background refresh), keeping filters. */
  update: (works: Work[]) => void
  /** Toggle the subtle "updating in the background" indicator. */
  setUpdating: (updating: boolean) => void
}

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
 * Build a self-contained, filterable/sortable view over a list of works. Pure
 * UI: it knows nothing about where the works came from, so it is reusable for
 * any aggregated AO3 listing. The caller mounts {@link SearchView.el} and, for a
 * background refresh, calls {@link SearchView.update} with the new works.
 */
export function createSearchView(initialWorks: Work[], handlers: SearchViewHandlers): SearchView {
  let works = initialWorks
  const state: FilterState = emptyFilterState()

  // Registry of facet toggle buttons, rebuilt whenever the facet list changes,
  // so render() can sync their active state against the current selection.
  let facetButtons: { key: FacetKey, value: string, dir: 'include' | 'exclude', btn: HTMLButtonElement }[] = []

  const countEl = (<span class={cx('count')} />) as HTMLElement
  const updatingEl = (<span class={cx('updating')}>Updating…</span>) as HTMLElement
  const resultsOl = (<ol class={`work index group ${cx('results')}`} />) as HTMLElement as HTMLOListElement
  const facetsEl = (<div class={cx('facets')} />) as HTMLElement

  // --- Controls -------------------------------------------------------------

  const searchInput = (
    <input type="search" class={cx('input')} placeholder="Title, author, summary, tags…" aria-label="Search works" />
  ) as HTMLElement as HTMLInputElement
  searchInput.addEventListener('input', debounce(() => {
    state.text = searchInput.value
    render()
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
  })
  syncDir()

  const minInput = (<input type="number" min="0" inputmode="numeric" class={cx('input')} placeholder="min" aria-label="Minimum words" />) as HTMLElement as HTMLInputElement
  const maxInput = (<input type="number" min="0" inputmode="numeric" class={cx('input')} placeholder="max" aria-label="Maximum words" />) as HTMLElement as HTMLInputElement
  const onWords = debounce(() => {
    state.wordsMin = parseBound(minInput.value)
    state.wordsMax = parseBound(maxInput.value)
    render()
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
    syncDir()
    render()
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

  function toggleSelection(key: FacetKey, dir: 'include' | 'exclude', value: string): void {
    const sel = state.facets[key][dir]
    if (sel.has(value)) {
      sel.delete(value)
    }
    else {
      sel.add(value)
      // Include and exclude are mutually exclusive for one value.
      state.facets[key][dir === 'include' ? 'exclude' : 'include'].delete(value)
    }
    render()
  }

  function facetRow(key: FacetKey, { value, count }: FacetValueCount): HTMLElement {
    const include = (
      <button type="button" class={`${cx('toggle')}  ${cx('toggle-include')}`} aria-pressed="false" title={`Only show works tagged "${value}"`}>
        <MdiPlusCircle />
      </button>
    ) as HTMLElement as HTMLButtonElement
    const exclude = (
      <button type="button" class={`${cx('toggle')}  ${cx('toggle-exclude')}`} aria-pressed="false" title={`Hide works tagged "${value}"`}>
        <MdiMinusCircle />
      </button>
    ) as HTMLElement as HTMLButtonElement
    include.addEventListener('click', () => toggleSelection(key, 'include', value))
    exclude.addEventListener('click', () => toggleSelection(key, 'exclude', value))
    facetButtons.push({ key, value, dir: 'include', btn: include }, { key, value, dir: 'exclude', btn: exclude })

    return (
      <div class={cx('row')}>
        <span class={cx('row-toggles')}>
          {include}
          {exclude}
        </span>
        <span class={cx('row-name')} title={value}>{value}</span>
        <span class={cx('row-count')}>{String(count)}</span>
      </div>
    ) as HTMLElement
  }

  function renderFacets(): void {
    facetButtons = []
    const facets = buildFacets(works)
    const groups: HTMLElement[] = []
    for (const key of FACET_KEYS) {
      const values = facets[key]
      if (!values.length)
        continue
      const group = (
        <details class={cx('group')} open>
          <summary class={cx('group-title')}>
            {FACET_LABELS[key]}
            {' '}
            <span class={cx('group-count')}>{String(values.length)}</span>
          </summary>
          <div class={cx('group-body')}>{values.map(value => facetRow(key, value))}</div>
        </details>
      ) as HTMLElement
      groups.push(group)
    }
    facetsEl.replaceChildren(...groups)
  }

  // --- Render ---------------------------------------------------------------

  function render(): void {
    const result = applyFilters(works, state)
    const visible = new Set(result)
    for (const work of works)
      work.el.classList.toggle(HIDDEN_CLASS, !visible.has(work))
    // append() moves existing nodes, so this reorders without re-creating them.
    for (const work of result)
      resultsOl.append(work.el)
    const noun = works.length === 1 ? 'work' : 'works'
    countEl.textContent = `Showing ${result.length} of ${works.length} ${noun}`
    for (const { key, value, dir, btn } of facetButtons) {
      const active = state.facets[key][dir].has(value)
      btn.classList.toggle(ACTIVE_CLASS, active)
      btn.setAttribute('aria-pressed', String(active))
    }
  }

  function mountResults(): void {
    resultsOl.replaceChildren(...works.map(work => work.el))
  }

  function update(nextWorks: Work[]): void {
    works = nextWorks
    // Drop selections for values that no longer exist so the UI stays honest.
    const present = buildFacets(works)
    for (const key of FACET_KEYS) {
      const valid = new Set(present[key].map(v => v.value))
      for (const dir of ['include', 'exclude'] as const) {
        for (const value of [...state.facets[key][dir]]) {
          if (!valid.has(value))
            state.facets[key][dir].delete(value)
        }
      }
    }
    mountResults()
    renderFacets()
    render()
  }

  function setUpdating(updating: boolean): void {
    updatingEl.classList.toggle(cx('updating-on'), updating)
  }

  // --- Assemble -------------------------------------------------------------

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
        {resultsOl}
      </div>
    </div>
  ) as HTMLElement

  return { el, update, setUpdating }
}
