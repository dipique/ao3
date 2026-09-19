/**
 * Reading and writing AO3's own completion filter: the three radios of the Sort
 * & Filter sidebar's "Completion Status" (`work_search[complete]` — `""` for all
 * works, `T` for complete works only, `F` for works in progress only). The
 * advanced search page spells it the same way.
 *
 * Mirrors {@link file://./wordCountFilter.ts}: we only set the control, never
 * post anything ourselves. The reader submits the filter form when they're ready.
 */

/** One side of AO3's completion filter. "Either" is spelled `null` throughout. */
export type Completion = 'complete' | 'incomplete'

const RADIO_SELECTOR = 'input[type="radio"][name$="[complete]"]'

/** The radio value AO3 gives each choice. */
const RADIO_VALUES: Record<Completion, string> = { complete: 'T', incomplete: 'F' }

function findRadios(root: ParentNode = document): HTMLInputElement[] {
  return [...root.querySelectorAll<HTMLInputElement>(RADIO_SELECTOR)]
}

/** Whether this page can filter by completion at all. */
export function hasCompletionFields(root: ParentNode = document): boolean {
  return findRadios(root).length > 0
}

/** The choice currently ticked in the page's completion filter; null for "all works". */
export function getCompletion(root: ParentNode = document): Completion | null {
  const checked = findRadios(root).find(radio => radio.checked)?.value
  if (checked === RADIO_VALUES.complete)
    return 'complete'
  if (checked === RADIO_VALUES.incomplete)
    return 'incomplete'
  return null
}

/**
 * Tick `completion` in the page's completion filter — or "all works", for null.
 * Returns false when the page has no such control (or not that radio). Does not
 * submit.
 */
export function setCompletion(completion: Completion | null, root: ParentNode = document): boolean {
  const value = completion ? RADIO_VALUES[completion] : ''
  const radio = findRadios(root).find(radio => radio.value === value)
  if (!radio)
    return false
  radio.checked = true
  return true
}
