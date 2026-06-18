import MdiMinusCircle from '~icons/mdi/minus-circle.jsx'
import MdiPlusCircle from '~icons/mdi/plus-circle.jsx'

import { ADDON_CLASS } from '#common'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const TOOLBAR_CLASS = `${ADDON_CLASS}--tag-toolbar`
const BUTTON_CLASS = `${ADDON_CLASS}--tag-toolbar--button`
const ACTIVE_CLASS = `${ADDON_CLASS}--tag-toolbar--active`
const INCLUDE_CLASS = `${ADDON_CLASS}--tag-toolbar--include`
const EXCLUDE_CLASS = `${ADDON_CLASS}--tag-toolbar--exclude`

/**
 * Blurb tag links we decorate. These are the text-based tags (relationships,
 * characters, additional tags, warnings) shown under each work — NOT the
 * fandom tags in `h5.fandoms`, which are id-based and handled separately.
 */
const TAG_LINK_SELECTOR = '.blurb ul.tags a.tag'

type Direction = 'include' | 'exclude'

interface DirectionConfig {
  /** The free-text autocomplete input that submits comma-joined tag names. */
  fieldId: string
  /** The `name=` prefix of this direction's pre-built filter checkboxes. */
  checkboxPrefix: string
}

const DIRECTIONS: Record<Direction, DirectionConfig> = {
  include: { fieldId: 'work_search_other_tag_names', checkboxPrefix: 'include_work_search' },
  exclude: { fieldId: 'work_search_excluded_tag_names', checkboxPrefix: 'exclude_work_search' },
}

// ---------------------------------------------------------------------------
// Pre-built filter checkboxes (the include/exclude lists in the sidebar).
// These are preferred over free-text entry: if a tag already has a checkbox we
// just (un)check it, matching how a user would use the sidebar.
// ---------------------------------------------------------------------------

/** Strips the trailing work-count, e.g. "Fluff (37)" -> "Fluff". */
const TRAILING_COUNT = /\s*\(\d+\)\s*$/

function checkboxTagName(input: HTMLInputElement): string {
  const label = input.closest('label')
  // The label holds: <input> <span.indicator> <span>NAME (count)</span>
  const nameSpan = label?.querySelector('span:not(.indicator)')
  const text = (nameSpan?.textContent ?? label?.textContent ?? '').trim()
  return text.replace(TRAILING_COUNT, '').trim()
}

/** name (lowercased) -> checkbox, per direction. Built once per page, cached. */
let checkboxIndex: Record<Direction, Map<string, HTMLInputElement>> | null = null

function getCheckboxIndex(): Record<Direction, Map<string, HTMLInputElement>> {
  if (checkboxIndex)
    return checkboxIndex

  const index: Record<Direction, Map<string, HTMLInputElement>> = {
    include: new Map(),
    exclude: new Map(),
  }

  for (const direction of Object.keys(DIRECTIONS) as Direction[]) {
    const { checkboxPrefix } = DIRECTIONS[direction]
    const inputs = document.querySelectorAll(`input[type="checkbox"][name^="${checkboxPrefix}["]`)
    for (const input of inputs) {
      const key = checkboxTagName(input).toLowerCase()
      if (key && !index[direction].has(key))
        index[direction].set(key, input)
    }
  }

  checkboxIndex = index
  return index
}

function findCheckbox(direction: Direction, name: string): HTMLInputElement | null {
  return getCheckboxIndex()[direction].get(name.trim().toLowerCase()) ?? null
}

// ---------------------------------------------------------------------------
// Free-text tag fields (fallback when a tag has no pre-built checkbox).
// ---------------------------------------------------------------------------

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
    refreshAll()
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

// ---------------------------------------------------------------------------
// Combined state: a tag is "selected" in a direction if its checkbox is checked,
// or (failing a checkbox) it's present in that direction's free-text field.
// ---------------------------------------------------------------------------

function isSelected(direction: Direction, name: string): boolean {
  const checkbox = findCheckbox(direction, name)
  if (checkbox)
    return checkbox.checked

  const filterField = getFilterField(DIRECTIONS[direction].fieldId)
  return filterField ? isListed(filterField, name) : false
}

/**
 * Every toolbar button on the page, so a change to one tag's state is reflected
 * on every blurb showing that same tag. Rebuilt on each `ready()`.
 */
const buttons: { button: HTMLElement, name: string, direction: Direction }[] = []

function setButtonState(button: HTMLElement, direction: Direction, selected: boolean): void {
  button.classList.toggle(ACTIVE_CLASS, selected)
  button.setAttribute('aria-pressed', String(selected))
  const verb = direction === 'include' ? 'included' : 'excluded'
  const action = direction === 'include' ? 'Include this tag in' : 'Exclude this tag from'
  const label = selected ? `Remove tag from ${verb} tags` : `${action} the filter`
  button.title = label
  button.setAttribute('aria-label', label)
}

function refreshAll(): void {
  for (const { button, name, direction } of buttons)
    setButtonState(button, direction, isSelected(direction, name))
}

export class TagToolbar extends Unit {
  static override get name() { return 'TagToolbar' }
  override get enabled() { return this.options.tagToolbar }

  static override async clean(): Promise<void> {
    buttons.length = 0
    checkboxIndex = null
  }

  override async ready(): Promise<void> {
    buttons.length = 0
    checkboxIndex = null

    const hasFilter = !!getFilterField(DIRECTIONS.exclude.fieldId) || !!getFilterField(DIRECTIONS.include.fieldId)
    if (!hasFilter) {
      this.logger.debug('No filter sidebar on this page; skipping tag toolbars.')
      return
    }

    const tagLinks = document.querySelectorAll(TAG_LINK_SELECTOR)
    for (const tagLink of tagLinks) {
      const name = tagLink.textContent?.trim()
      if (!name)
        continue
      // clean() already removed previous toolbars, but guard against duplicates.
      if (tagLink.nextElementSibling?.classList.contains(TOOLBAR_CLASS))
        continue

      tagLink.after(this.buildToolbar(name))
    }

    refreshAll()
    this.logger.debug(`Added include/exclude toolbars to ${buttons.length / 2} tag links.`)
  }

  buildToolbar(name: string): HTMLElement {
    return (
      <span class={`${ADDON_CLASS} ${TOOLBAR_CLASS}`}>
        {this.buildButton('include', name)}
        {this.buildButton('exclude', name)}
      </span>
    )
  }

  buildButton(direction: Direction, name: string): HTMLElement {
    const Icon = direction === 'include' ? MdiPlusCircle : MdiMinusCircle
    const directionClass = direction === 'include' ? INCLUDE_CLASS : EXCLUDE_CLASS

    const button: HTMLElement = (
      <button type="button" class={`${BUTTON_CLASS} ${directionClass}`} aria-pressed="false">
        <Icon />
      </button>
    )

    button.addEventListener('click', (e) => {
      e.preventDefault()

      const checkbox = findCheckbox(direction, name)
      if (checkbox) {
        // Prefer the pre-built sidebar checkbox over free-text entry.
        checkbox.checked = !checkbox.checked
      }
      else {
        const filterField = getFilterField(DIRECTIONS[direction].fieldId)
        if (!filterField) {
          this.logger.warn(`No ${direction} checkbox or field for "${name}"; cannot update filter.`)
          return
        }
        if (isListed(filterField, name))
          removeTagFromField(filterField, name)
        else
          addTagToField(filterField, name)
      }

      refreshAll()
    })

    buttons.push({ button, name, direction })
    return button
  }
}
