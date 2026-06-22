import MdiMinusCircle from '~icons/mdi/minus-circle.jsx'
import MdiPlusCircle from '~icons/mdi/plus-circle.jsx'

import type { FandomCache } from '#common'

import { ADDON_CLASS, fandomCache, fetchAndParseDocument } from '#common'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const TOOLBAR_CLASS = `${ADDON_CLASS}--fandom-toolbar`
const BUTTON_CLASS = `${ADDON_CLASS}--fandom-toolbar--button`
const ACTIVE_CLASS = `${ADDON_CLASS}--fandom-toolbar--active`
const INCLUDE_CLASS = `${ADDON_CLASS}--fandom-toolbar--include`
const EXCLUDE_CLASS = `${ADDON_CLASS}--fandom-toolbar--exclude`
const VISIBLE_CLASS = `${ADDON_CLASS}--fandom-toolbar--visible`

/**
 * Grace period before hiding the toolbar after the pointer leaves the fandom
 * link, so the user can cross the small gap onto the toolbar to click it.
 */
const HIDE_DELAY_MS = 250

/**
 * Blurb fandom links. Unlike the text-based tags handled by TagToolbar, these
 * are id-based: the filter form references fandoms by numeric id, not name, so
 * we must resolve each displayed name to an id before we can filter on it.
 */
const FANDOM_LINK_SELECTOR = 'h5.fandoms a.tag'

type Direction = 'include' | 'exclude'

const DIRECTIONS: Record<Direction, { checkboxName: string, ddId: string }> = {
  include: { checkboxName: 'include_work_search[fandom_ids][]', ddId: 'include_fandom_tags' },
  exclude: { checkboxName: 'exclude_work_search[fandom_ids][]', ddId: 'exclude_fandom_tags' },
}

// ---------------------------------------------------------------------------
// Id resolution: bundled index -> learned cache -> on-demand fetch.
// ---------------------------------------------------------------------------

/** Merged lowercased-name -> id lookup (bundled index + learned cache). */
let idLookup: Map<string, number> | null = null
let idLookupPromise: Promise<Map<string, number>> | null = null

async function getIdLookup(): Promise<Map<string, number>> {
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
        console.error('[FandomToolbar] Failed to load bundled fandom index:', err)
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

function resolveSync(name: string): number | null {
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
async function resolveWithFetch(name: string, href: string): Promise<number | null> {
  const key = name.toLowerCase()
  const known = resolveSync(name)
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
      console.debug('[FandomToolbar] Fetch resolution failed for', name, err)
    }
    fetchFailures.add(key)
    return null
  })()

  inflight.set(key, promise)
  const result = await promise
  inflight.delete(key)
  return result
}

// ---------------------------------------------------------------------------
// Learned/scraped id persistence.
// ---------------------------------------------------------------------------

/** Persist a single learned tag id, merging into the existing cache. */
async function rememberTag(type: 'fandoms', name: string, id: number): Promise<void> {
  const existing = await fandomCache.get(type)
  const key = name.toLowerCase()
  if (existing[key]?.id === id)
    return
  await fandomCache.set({ [type]: { ...existing, [key]: { id, name } } } as Partial<FandomCache>)
}

// ---------------------------------------------------------------------------
// Filter-form checkboxes (id-keyed; reuse the sidebar's, else inject one).
// ---------------------------------------------------------------------------

const TRAILING_COUNT = /\s*\(\d[\d,]*\)\s*$/

/** id -> checkbox, per direction. Built once per page, cached. Includes injected. */
let checkboxIndex: Record<Direction, Map<number, HTMLInputElement>> | null = null

function getCheckboxIndex(): Record<Direction, Map<number, HTMLInputElement>> {
  if (checkboxIndex)
    return checkboxIndex

  const index: Record<Direction, Map<number, HTMLInputElement>> = {
    include: new Map(),
    exclude: new Map(),
  }
  for (const direction of Object.keys(DIRECTIONS) as Direction[]) {
    const selector = `input[type="checkbox"][name="${DIRECTIONS[direction].checkboxName}"]`
    for (const input of document.querySelectorAll(selector)) {
      if (input instanceof HTMLInputElement) {
        const id = Number(input.value)
        if (id && !index[direction].has(id))
          index[direction].set(id, input)
      }
    }
  }
  checkboxIndex = index
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
  const { checkboxName, ddId } = DIRECTIONS[direction]
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

function isSelected(direction: Direction, id: number): boolean {
  return getCheckboxIndex()[direction].get(id)?.checked ?? false
}

/** Toggle a fandom's filter checkbox, creating one if the sidebar lacks it. */
function toggleFilter(direction: Direction, id: number, name: string): void {
  const index = getCheckboxIndex()[direction]
  const existing = index.get(id)
  if (existing) {
    existing.checked = !existing.checked
    return
  }
  const injected = injectCheckbox(direction, id, name)
  if (injected)
    index.set(id, injected)
}

// ---------------------------------------------------------------------------
// Per-fandom state shared across every blurb showing the same fandom.
// ---------------------------------------------------------------------------

interface FandomEntry {
  name: string
  href: string
  id: number | null
  resolving: boolean
  buttons: { button: HTMLButtonElement, direction: Direction }[]
}

/** lowercased name -> entry. Rebuilt each ready(). */
const entries = new Map<string, FandomEntry>()

function setButtonState(button: HTMLButtonElement, direction: Direction, entry: FandomEntry): void {
  const known = entry.id != null
  button.disabled = !known
  const selected = known && isSelected(direction, entry.id!)
  button.classList.toggle(ACTIVE_CLASS, selected)
  button.setAttribute('aria-pressed', String(selected))

  let label: string
  if (!known) {
    label = entry.resolving ? 'Looking up fandom id…' : 'Fandom id unknown — cannot filter'
  }
  else {
    const verb = direction === 'include' ? 'included' : 'excluded'
    const action = direction === 'include' ? 'Include this fandom in' : 'Exclude this fandom from'
    label = selected ? `Remove fandom from ${verb} fandoms` : `${action} the filter`
  }
  button.title = label
  button.setAttribute('aria-label', label)
}

function refreshEntry(entry: FandomEntry): void {
  for (const { button, direction } of entry.buttons)
    setButtonState(button, direction, entry)
}

function refreshAll(): void {
  for (const entry of entries.values())
    refreshEntry(entry)
}

export class FandomToolbar extends Unit {
  static override get name() { return 'FandomToolbar' }
  override get enabled() { return this.options.fandomToolbar }

  static override async clean(): Promise<void> {
    entries.clear()
    checkboxIndex = null
    fetchFailures.clear()
    inflight.clear()
    // idLookup is static data — keep it cached across re-runs.
  }

  override async ready(): Promise<void> {
    entries.clear()
    checkboxIndex = null

    // Only operate on works-listing pages that have the fandom filter form.
    const hasFandomFilter = !!document.querySelector(
      'input[name="include_work_search[fandom_ids][]"], input[name="exclude_work_search[fandom_ids][]"]',
    )
    const fandomLinks = document.querySelectorAll(FANDOM_LINK_SELECTOR)
    if (!hasFandomFilter || fandomLinks.length === 0) {
      this.logger.debug('No fandom filter or fandom links on this page; skipping fandom toolbars.')
      return
    }

    await getIdLookup()
    this.scrapeSidebar()

    for (const link of fandomLinks) {
      if (!(link instanceof HTMLAnchorElement))
        continue
      const name = link.textContent?.trim()
      if (!name)
        continue
      if (link.nextElementSibling?.classList.contains(TOOLBAR_CLASS))
        continue

      const key = name.toLowerCase()
      let entry = entries.get(key)
      if (!entry) {
        entry = { name, href: link.href, id: resolveSync(name), resolving: false, buttons: [] }
        entries.set(key, entry)
      }
      link.after(this.buildToolbar(entry, link))
    }

    refreshAll()
    this.logger.debug(`Added include/exclude toolbars to ${entries.size} fandoms.`)
  }

  /**
   * Passively harvest every fandom/character/relationship id from the filter
   * sidebar into the learned cache, growing the crossreference over time.
   */
  scrapeSidebar(): void {
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

  buildToolbar(entry: FandomEntry, link: HTMLAnchorElement): HTMLElement {
    const toolbar = (
      <span class={`${ADDON_CLASS} ${TOOLBAR_CLASS}`}>
        {this.buildButton('exclude', entry)}
        {this.buildButton('include', entry)}
      </span>
    )

    // Show/hide is driven from JS (rather than a pure CSS :hover bridge) so a
    // small grace delay lets the pointer cross the gap from the link onto the
    // toolbar without it vanishing. Hovering either element keeps it open.
    let hideTimer: ReturnType<typeof setTimeout> | undefined
    const show = (): void => {
      clearTimeout(hideTimer)
      toolbar.classList.add(VISIBLE_CLASS)
      // Lazily resolve unknown fandoms on first hover so the click is instant.
      if (entry.id == null)
        void this.resolveEntry(entry, link.href)
    }
    const scheduleHide = (): void => {
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => toolbar.classList.remove(VISIBLE_CLASS), HIDE_DELAY_MS)
    }
    for (const el of [link, toolbar]) {
      el.addEventListener('pointerenter', show)
      el.addEventListener('pointerleave', scheduleHide)
    }
    return toolbar
  }

  buildButton(direction: Direction, entry: FandomEntry): HTMLButtonElement {
    const Icon = direction === 'include' ? MdiPlusCircle : MdiMinusCircle
    const directionClass = direction === 'include' ? INCLUDE_CLASS : EXCLUDE_CLASS

    const button = (
      <button type="button" class={`${BUTTON_CLASS} ${directionClass}`} aria-pressed="false">
        <Icon />
      </button>
    ) as HTMLElement as HTMLButtonElement

    button.addEventListener('click', (e) => {
      e.preventDefault()
      void this.onButtonClick(direction, entry)
    })

    entry.buttons.push({ button, direction })
    return button
  }

  async resolveEntry(entry: FandomEntry, href: string): Promise<void> {
    if (entry.id != null || entry.resolving)
      return
    entry.resolving = true
    refreshEntry(entry)
    const id = await resolveWithFetch(entry.name, href)
    entry.resolving = false
    if (id != null)
      entry.id = id
    refreshEntry(entry)
  }

  async onButtonClick(direction: Direction, entry: FandomEntry): Promise<void> {
    if (entry.id == null) {
      // Last-ditch: resolve on click for users who clicked before hover resolved.
      await this.resolveEntry(entry, entry.href)
      if (entry.id == null) {
        this.logger.warn(`Could not resolve an id for "${entry.name}"; cannot filter.`)
        return
      }
    }
    toggleFilter(direction, entry.id, entry.name)
    refreshAll()
  }
}
