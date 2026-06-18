import MdiMinusCircle from '~icons/mdi/minus-circle.jsx'

import { ADDON_CLASS } from '#common'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const TOOLBAR_CLASS = `${ADDON_CLASS}--tag-toolbar`
const BUTTON_CLASS = `${ADDON_CLASS}--tag-toolbar--button`
const ACTIVE_CLASS = `${ADDON_CLASS}--tag-toolbar--active`

/**
 * Blurb tag links we decorate. These are the text-based tags (relationships,
 * characters, additional tags, warnings) shown under each work — NOT the
 * fandom tags in `h5.fandoms`, which are id-based and handled separately.
 */
const TAG_LINK_SELECTOR = '.blurb ul.tags a.tag'

/**
 * The free-text "Other tags to exclude" control in the filter sidebar. Its
 * value is the comma-separated list of excluded tag names that gets submitted
 * (`work_search[excluded_tag_names]`). Since tags are matched by name, we can
 * add/remove purely from the displayed tag text — no id lookup needed.
 */
const EXCLUDE_FIELD_ID = 'work_search_excluded_tag_names'

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

function addExcludedTag(filterField: FilterField, name: string): void {
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

function removeExcludedTag(filterField: FilterField, name: string): void {
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

/**
 * Every toolbar button on the page, so a change to one tag's state is reflected
 * on every blurb showing that same tag. Rebuilt on each `ready()`.
 */
const buttons: { button: HTMLElement, name: string }[] = []

function setButtonState(button: HTMLElement, excluded: boolean): void {
  button.classList.toggle(ACTIVE_CLASS, excluded)
  button.setAttribute('aria-pressed', String(excluded))
  const label = excluded ? 'Remove tag from excluded tags' : 'Exclude this tag from the filter'
  button.title = label
  button.setAttribute('aria-label', label)
}

function refreshAll(): void {
  const filterField = getFilterField(EXCLUDE_FIELD_ID)
  if (!filterField)
    return
  for (const { button, name } of buttons)
    setButtonState(button, isListed(filterField, name))
}

export class TagToolbar extends Unit {
  static override get name() { return 'TagToolbar' }
  override get enabled() { return this.options.tagToolbar }

  static override async clean(): Promise<void> {
    buttons.length = 0
  }

  override async ready(): Promise<void> {
    buttons.length = 0

    if (!getFilterField(EXCLUDE_FIELD_ID)) {
      this.logger.debug('No exclude-tags field on this page; skipping tag toolbars.')
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
    this.logger.debug(`Added exclude toolbars to ${buttons.length} tag links.`)
  }

  buildToolbar(name: string): HTMLElement {
    const button: HTMLElement = (
      <button type="button" class={BUTTON_CLASS} aria-pressed="false">
        <MdiMinusCircle />
      </button>
    )

    button.addEventListener('click', (e) => {
      e.preventDefault()
      const filterField = getFilterField(EXCLUDE_FIELD_ID)
      if (!filterField) {
        this.logger.warn('Exclude-tags field disappeared; cannot update filter.')
        return
      }

      if (isListed(filterField, name))
        removeExcludedTag(filterField, name)
      else
        addExcludedTag(filterField, name)

      refreshAll()
    })

    buttons.push({ button, name })

    return (
      <span class={`${ADDON_CLASS} ${TOOLBAR_CLASS}`}>
        {button}
      </span>
    )
  }
}
