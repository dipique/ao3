import type { FandomCache } from '#common'

import { ADDON_CLASS, fandomCache, fetchAndParseDocument } from '#common'
import React from '#dom'

/**
 * Shared logic for reading and mutating AO3's "Sort and Filter" sidebar.
 *
 * Three on-page controls drive the same filter form and therefore share this
 * module: the per-tag toolbar (TagToolbar, text/name-based tags), the per-fandom
 * toolbar (FandomToolbar, id-based fandoms) and the inline "exclude" buttons on
 * hidden works (HideWorks). Keeping the DOM plumbing here means all three stay
 * consistent — a tag excluded from one place reflects everywhere via
 * {@link notifyFilterChange}.
 */

export type Direction = 'include' | 'exclude'

// ---------------------------------------------------------------------------
// Change notification. Any control that mutates the filter calls
// notifyFilterChange() so every other decorated control re-syncs its state
// (e.g. the same tag shown on multiple blurbs, or a hidden-work exclude button
// mirroring a toolbar button). Listeners are registered once at module load by
// each consumer; their refresh functions iterate per-page registries that are
// rebuilt each run, so a stale call is a harmless no-op.
// ---------------------------------------------------------------------------

const changeListeners = new Set<() => void>()

export function onFilterChange(fn: () => void): void {
  changeListeners.add(fn)
}

export function notifyFilterChange(): void {
  for (const fn of changeListeners)
    fn()
}

/** Strips a trailing work-count, e.g. "Fluff (37)" / "Naruto (1,234)" -> name. */
const TRAILING_COUNT = /\s*\(\d[\d,]*\)\s*$/

// ===========================================================================
// Text tags (name-based): relationships, characters, additional tags, warnings.
// Filtered by name through `*_tag_names` fields and `*_work_search` checkboxes.
// ===========================================================================

const TAG_DIRECTIONS: Record<Direction, { fieldId: string, checkboxPrefix: string }> = {
  include: { fieldId: 'work_search_other_tag_names', checkboxPrefix: 'include_work_search' },
  exclude: { fieldId: 'work_search_excluded_tag_names', checkboxPrefix: 'exclude_work_search' },
}

// --- Pre-built filter checkboxes (the sidebar's include/exclude lists). -----
// Preferred over free-text entry: if a tag already has a checkbox we just
// (un)check it, matching how a user would use the sidebar.

function checkboxTagName(input: HTMLInputElement): string {
  const label = input.closest('label')
  // The label holds: <input> <span.indicator> <span>NAME (count)</span>
  const nameSpan = label?.querySelector('span:not(.indicator)')
  const text = (nameSpan?.textContent ?? label?.textContent ?? '').trim()
  return text.replace(TRAILING_COUNT, '').trim()
}

/** name (lowercased) -> checkbox, per direction. Built once per page, cached. */
let tagCheckboxIndex: Record<Direction, Map<string, HTMLInputElement>> | null = null

function getTagCheckboxIndex(): Record<Direction, Map<string, HTMLInputElement>> {
  if (tagCheckboxIndex)
    return tagCheckboxIndex

  const index: Record<Direction, Map<string, HTMLInputElement>> = {
    include: new Map(),
    exclude: new Map(),
  }

  for (const direction of Object.keys(TAG_DIRECTIONS) as Direction[]) {
    const { checkboxPrefix } = TAG_DIRECTIONS[direction]
    const inputs = document.querySelectorAll(`input[type="checkbox"][name^="${checkboxPrefix}["]`)
    for (const input of inputs) {
      const key = checkboxTagName(input).toLowerCase()
      if (key && !index[direction].has(key))
        index[direction].set(key, input)
    }
  }

  tagCheckboxIndex = index
  return index
}

function findTagCheckbox(direction: Direction, name: string): HTMLInputElement | null {
  return getTagCheckboxIndex()[direction].get(name.trim().toLowerCase()) ?? null
}

// --- Free-text tag fields (fallback when a tag has no pre-built checkbox). ---

interface FilterField {
  /** The original input that actually submits the comma-joined tag names. */
  field: HTMLInputElement
  /**
   * AO3's autocomplete token UI (`ul.autocomplete`), if it has been built yet.
   * It's created lazily by AO3's own script, so we re-derive it on each access
   * rather than caching, and fall back to editing `field.value` directly.
   */
  list: HTMLUListElement | null
}

function getFilterField(fieldId: string): FilterField | null {
  const field = document.getElementById(fieldId)
  if (!(field instanceof HTMLInputElement))
    return null

  const container = field.closest('dd, p, fieldset, form')
  const list = (container?.querySelector('ul.autocomplete') ?? null) as HTMLUListElement | null
  return { field, list }
}

/** The visible name of an AO3 token `<li class="added tag">NAME <span.delete>…</li>`. */
function tokenName(li: Element): string {
  return (li.firstChild?.textContent ?? '').trim()
}

function listedNames({ field, list }: FilterField): string[] {
  if (list) {
    return Array.from(list.querySelectorAll('li.added.tag')).map(tokenName).filter(Boolean)
  }
  return field.value.split(',').map(name => name.trim()).filter(Boolean)
}

function isListed(filterField: FilterField, name: string): boolean {
  const lower = name.toLowerCase()
  return listedNames(filterField).some(listed => listed.toLowerCase() === lower)
}

/** Rebuild the submitted field value from the currently shown tokens. */
function syncFieldFromTokens({ field, list }: FilterField): void {
  if (!list)
    return
  field.value = Array.from(list.querySelectorAll('li.added.tag')).map(tokenName).filter(Boolean).join(',')
}

function buildToken(filterField: FilterField, name: string): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'added tag'
  li.append(document.createTextNode(`${name} `))

  const remove = document.createElement('a')
  remove.href = '#'
  remove.title = `remove ${name}`
  remove.textContent = '×' // ×
  remove.addEventListener('click', (e) => {
    e.preventDefault()
    li.remove()
    syncFieldFromTokens(filterField)
    notifyFilterChange()
  })

  const span = document.createElement('span')
  span.className = 'delete'
  span.append(remove)
  li.append(span)
  return li
}

function addTagToField(filterField: FilterField, name: string): void {
  if (isListed(filterField, name))
    return

  const { field, list } = filterField
  if (list) {
    // Mirror AO3's token UI, inserting before the typing input so it stays last.
    const inputLi = list.querySelector('li:last-child input')?.closest('li')
    list.insertBefore(buildToken(filterField, name), inputLi ?? null)
    syncFieldFromTokens(filterField)
  }
  else {
    field.value = [...listedNames(filterField), name].join(',')
  }
}

function removeTagFromField(filterField: FilterField, name: string): void {
  const { field, list } = filterField
  const lower = name.toLowerCase()
  if (list) {
    for (const li of Array.from(list.querySelectorAll('li.added.tag'))) {
      if (tokenName(li).toLowerCase() === lower)
        li.remove()
    }
    syncFieldFromTokens(filterField)
  }
  else {
    field.value = listedNames(filterField).filter(listed => listed.toLowerCase() !== lower).join(',')
  }
}

// --- Public text-tag API. ---------------------------------------------------

/** Whether this page has any text-tag include/exclude filter fields at all. */
export function hasTagFilterFields(): boolean {
  return !!getFilterField(TAG_DIRECTIONS.exclude.fieldId) || !!getFilterField(TAG_DIRECTIONS.include.fieldId)
}

/**
 * A tag is "selected" in a direction if its sidebar checkbox is checked, or
 * (failing a checkbox) it's listed in that direction's free-text field.
 */
export function isTagSelected(direction: Direction, name: string): boolean {
  const checkbox = findTagCheckbox(direction, name)
  if (checkbox)
    return checkbox.checked

  const filterField = getFilterField(TAG_DIRECTIONS[direction].fieldId)
  return filterField ? isListed(filterField, name) : false
}

/**
 * Toggle a tag's filter state, preferring the sidebar checkbox over free-text
 * entry. Returns false (and changes nothing) if there's no checkbox or field to
 * target. Notifies listeners on success.
 */
export function toggleTagFilter(direction: Direction, name: string): boolean {
  const checkbox = findTagCheckbox(direction, name)
  if (checkbox) {
    checkbox.checked = !checkbox.checked
  }
  else {
    const filterField = getFilterField(TAG_DIRECTIONS[direction].fieldId)
    if (!filterField)
      return false
    if (isListed(filterField, name))
      removeTagFromField(filterField, name)
    else
      addTagToField(filterField, name)
  }
  notifyFilterChange()
  return true
}

// ===========================================================================
// Fandoms (id-based): the filter form references fandoms by numeric id, so each
// displayed name must be resolved to an id before it can be filtered.
// ===========================================================================

const FANDOM_DIRECTIONS: Record<Direction, { checkboxName: string, ddId: string }> = {
  include: { checkboxName: 'include_work_search[fandom_ids][]', ddId: 'include_fandom_tags' },
  exclude: { checkboxName: 'exclude_work_search[fandom_ids][]', ddId: 'exclude_fandom_tags' },
}

// --- Id resolution: bundled index -> learned cache -> on-demand fetch. -------

/** Merged lowercased-name -> id lookup (bundled index + learned cache). */
let idLookup: Map<string, number> | null = null
let idLookupPromise: Promise<Map<string, number>> | null = null

export async function loadFandomIdLookup(): Promise<Map<string, number>> {
  if (idLookup)
    return idLookup
  if (!idLookupPromise) {
    idLookupPromise = (async () => {
      const map = new Map<string, number>()
      try {
        const url = browser.runtime.getURL('data/fandom-index.json')
        const obj = await (await fetch(url)).json() as Record<string, number>
        for (const [name, id] of Object.entries(obj))
          map.set(name, id)
      }
      catch (err) {
        console.error('[filterSidebar] Failed to load bundled fandom index:', err)
      }
      // Learned/scraped ids override the (possibly stale) bundled ones.
      const learned = await fandomCache.get('fandoms')
      for (const { name, id } of Object.values(learned))
        map.set(name.toLowerCase(), id)

      idLookup = map
      return map
    })()
  }
  return idLookupPromise
}

export function resolveFandomIdSync(name: string): number | null {
  return idLookup?.get(name.toLowerCase()) ?? null
}

/** Names we've already tried (and failed) to fetch this page load. */
const fetchFailures = new Set<string>()
/** In-flight fetches, deduped by lowercased name. */
const inflight = new Map<string, Promise<number | null>>()

function parseTagIdFromDoc(doc: Document): number | null {
  const input = doc.querySelector('input#favorite_tag_tag_id')
  if (input instanceof HTMLInputElement && /^\d+$/.test(input.value))
    return Number(input.value)
  const feed = doc.querySelector('a[href*="/feed.atom"], link[href*="/feed.atom"]')
  const match = feed?.getAttribute('href')?.match(/\/tags\/(\d+)\/feed\.atom/)
  return match ? Number(match[1]) : null
}

/**
 * Resolve a fandom to an id, fetching its tag page if it isn't already known.
 * The blurb href points at `/tags/NAME/works`; synonyms 3xx-redirect to their
 * canonical tag page, so following redirects (fetch's default) lands on a page
 * exposing the canonical id.
 */
export async function resolveFandomIdWithFetch(name: string, href: string): Promise<number | null> {
  const key = name.toLowerCase()
  const known = resolveFandomIdSync(name)
  if (known)
    return known
  if (fetchFailures.has(key))
    return null
  if (inflight.has(key))
    return inflight.get(key)!

  const promise = (async () => {
    try {
      const doc = await fetchAndParseDocument(href)
      const id = parseTagIdFromDoc(doc)
      if (id) {
        idLookup?.set(key, id)
        await rememberTag('fandoms', name, id)
        return id
      }
    }
    catch (err) {
      console.debug('[filterSidebar] Fetch resolution failed for', name, err)
    }
    fetchFailures.add(key)
    return null
  })()

  inflight.set(key, promise)
  const result = await promise
  inflight.delete(key)
  return result
}

/** Persist a single learned tag id, merging into the existing cache. */
async function rememberTag(type: 'fandoms', name: string, id: number): Promise<void> {
  const existing = await fandomCache.get(type)
  const key = name.toLowerCase()
  if (existing[key]?.id === id)
    return
  await fandomCache.set({ [type]: { ...existing, [key]: { id, name } } } as Partial<FandomCache>)
}

/**
 * Passively harvest every fandom/character/relationship id from the filter
 * sidebar into the learned cache, growing the crossreference over time.
 */
export function scrapeSidebar(): void {
  const types: { type: 'fandoms' | 'characters' | 'relationships', key: string }[] = [
    { type: 'fandoms', key: 'fandom_ids' },
    { type: 'characters', key: 'character_ids' },
    { type: 'relationships', key: 'relationship_ids' },
  ]
  void (async () => {
    for (const { type, key } of types) {
      const found = new Map<string, { id: number, name: string }>()
      const selector = `input[type="checkbox"][name$="${key}][]"]`
      for (const input of document.querySelectorAll(selector)) {
        if (!(input instanceof HTMLInputElement))
          continue
        const id = Number(input.value)
        if (!id)
          continue
        const span = input.closest('label')?.querySelector('span:not(.indicator)')
        const name = (span?.textContent ?? '').replace(TRAILING_COUNT, '').trim()
        if (name)
          found.set(name.toLowerCase(), { id, name })
      }
      if (found.size === 0)
        continue

      const existing = await fandomCache.get(type)
      let changed = false
      const merged = { ...existing }
      for (const [k, value] of found) {
        // For fandoms, skip ids already known (bundled or learned) so the
        // cache/export only grows with genuinely new or corrected entries.
        // Characters/relationships have no bundled index, so dedupe on cache.
        const alreadyKnown = type === 'fandoms'
          ? idLookup?.get(k) === value.id
          : merged[k]?.id === value.id
        if (!alreadyKnown) {
          merged[k] = value
          changed = true
          if (type === 'fandoms')
            idLookup?.set(k, value.id)
        }
      }
      if (changed)
        await fandomCache.set({ [type]: merged } as Partial<FandomCache>)
    }
  })()
}

// --- Filter-form checkboxes (id-keyed; reuse the sidebar's, else inject one). -

/** id -> checkbox, per direction. Built once per page, cached. Includes injected. */
let fandomCheckboxIndex: Record<Direction, Map<number, HTMLInputElement>> | null = null

function getFandomCheckboxIndex(): Record<Direction, Map<number, HTMLInputElement>> {
  if (fandomCheckboxIndex)
    return fandomCheckboxIndex

  const index: Record<Direction, Map<number, HTMLInputElement>> = {
    include: new Map(),
    exclude: new Map(),
  }
  for (const direction of Object.keys(FANDOM_DIRECTIONS) as Direction[]) {
    const selector = `input[type="checkbox"][name="${FANDOM_DIRECTIONS[direction].checkboxName}"]`
    for (const input of document.querySelectorAll(selector)) {
      if (input instanceof HTMLInputElement) {
        const id = Number(input.value)
        if (id && !index[direction].has(id))
          index[direction].set(id, input)
      }
    }
  }
  fandomCheckboxIndex = index
  return index
}

/** The `<form>` the filter checkboxes live in, used as an injection fallback. */
function getFilterForm(): HTMLFormElement | null {
  const anyCheckbox = document.querySelector('input[name^="work_search["], input[name^="include_work_search["], input[name^="exclude_work_search["]')
  return anyCheckbox?.closest('form') ?? null
}

/**
 * Inject a pre-checked checkbox for a fandom that has no sidebar entry. Prefers
 * the matching `dd#…_fandom_tags` list (so it shows up natively in the sidebar),
 * falling back to a hidden input appended to the form so it still serializes.
 */
function injectCheckbox(direction: Direction, id: number, name: string): HTMLInputElement | null {
  const { checkboxName, ddId } = FANDOM_DIRECTIONS[direction]
  const inputId = `${direction}_work_search_fandom_ids_${id}`

  const list = document.getElementById(ddId)?.querySelector('ul')
  if (list) {
    const li = (
      <li class={ADDON_CLASS}>
        <label for={inputId}>
          <input type="checkbox" name={checkboxName} id={inputId} value={String(id)} checked />
          <span class="indicator" aria-hidden="true" />
          <span>{name}</span>
        </label>
      </li>
    )
    list.prepend(li)
    return li.querySelector('input')
  }

  const form = getFilterForm()
  if (form) {
    const input = (
      <input class={ADDON_CLASS} type="checkbox" name={checkboxName} id={inputId} value={String(id)} checked style={{ display: 'none' }} />
    ) as HTMLElement as HTMLInputElement
    form.append(input)
    return input
  }
  return null
}

// --- Public fandom API. -----------------------------------------------------

/** Whether this page has the fandom include/exclude filter checkboxes. */
export function hasFandomFilterFields(): boolean {
  return !!document.querySelector(
    'input[name="include_work_search[fandom_ids][]"], input[name="exclude_work_search[fandom_ids][]"]',
  )
}

export function isFandomSelected(direction: Direction, id: number): boolean {
  return getFandomCheckboxIndex()[direction].get(id)?.checked ?? false
}

/** Toggle a fandom's filter checkbox, creating one if the sidebar lacks it. Notifies. */
export function toggleFandomFilter(direction: Direction, id: number, name: string): void {
  const index = getFandomCheckboxIndex()[direction]
  const existing = index.get(id)
  if (existing) {
    existing.checked = !existing.checked
  }
  else {
    const injected = injectCheckbox(direction, id, name)
    if (injected)
      index.set(id, injected)
  }
  notifyFilterChange()
}

// ===========================================================================
// Fixed checkbox groups: ratings, archive warnings, categories. Unlike fandoms
// (and the other id-based facets), AO3 always renders the *complete* set of
// these as include/exclude checkboxes on every works-filter page, so no id
// resolution is needed — we just match the displayed name to its checkbox.
// ===========================================================================

export type CheckboxGroup = 'rating' | 'archive_warning' | 'category'

/** The `*_ids` segment of each group's checkbox `name=` attribute. */
const CHECKBOX_GROUP_KEYS: Record<CheckboxGroup, string> = {
  rating: 'rating_ids',
  archive_warning: 'archive_warning_ids',
  category: 'category_ids',
}

/** "direction:group" -> (lowercased name -> checkbox). Built once per page. */
let checkboxGroupIndex: Map<string, Map<string, HTMLInputElement>> | null = null

function getCheckboxGroupIndex(): Map<string, Map<string, HTMLInputElement>> {
  if (checkboxGroupIndex)
    return checkboxGroupIndex

  const index = new Map<string, Map<string, HTMLInputElement>>()
  for (const direction of Object.keys(TAG_DIRECTIONS) as Direction[]) {
    for (const group of Object.keys(CHECKBOX_GROUP_KEYS) as CheckboxGroup[]) {
      const name = `${direction}_work_search[${CHECKBOX_GROUP_KEYS[group]}][]`
      const map = new Map<string, HTMLInputElement>()
      for (const input of document.querySelectorAll(`input[type="checkbox"][name="${name}"]`)) {
        if (!(input instanceof HTMLInputElement))
          continue
        const key = checkboxTagName(input).toLowerCase()
        if (key && !map.has(key))
          map.set(key, input)
      }
      index.set(`${direction}:${group}`, map)
    }
  }
  checkboxGroupIndex = index
  return index
}

function findGroupCheckbox(direction: Direction, group: CheckboxGroup, name: string): HTMLInputElement | null {
  return getCheckboxGroupIndex().get(`${direction}:${group}`)?.get(name.trim().toLowerCase()) ?? null
}

/** Whether this page exposes exclude checkboxes for the given group. */
export function hasCheckboxGroupFields(group: CheckboxGroup): boolean {
  const map = getCheckboxGroupIndex().get(`exclude:${group}`)
  return !!map && map.size > 0
}

export function isCheckboxGroupSelected(direction: Direction, group: CheckboxGroup, name: string): boolean {
  return findGroupCheckbox(direction, group, name)?.checked ?? false
}

/**
 * Toggle a group checkbox by its displayed name. Returns false (changing
 * nothing) if no checkbox matches. Notifies listeners on success.
 */
export function toggleCheckboxGroupFilter(direction: Direction, group: CheckboxGroup, name: string): boolean {
  const checkbox = findGroupCheckbox(direction, group, name)
  if (!checkbox)
    return false
  checkbox.checked = !checkbox.checked
  notifyFilterChange()
  return true
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

/**
 * Reset per-page DOM caches. Called from each consuming unit's `clean()`, which
 * the content script runs (for every unit) before any unit's `ready()`, so the
 * indices are rebuilt lazily against the fresh page on first access.
 */
export function resetFilterSidebarCaches(): void {
  tagCheckboxIndex = null
  fandomCheckboxIndex = null
  checkboxGroupIndex = null
  fetchFailures.clear()
  inflight.clear()
  // idLookup is static data (bundled index + learned cache) — keep it cached.
}
