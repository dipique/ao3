import type { WordCountRange } from '#common'

import { normalizeBound, parseWordCountQuery, serializeWordCountQuery } from '#common'

/**
 * Reading and writing AO3's own word-count filter, wherever the page happens to
 * spell it. Two shapes exist and both are handled here so callers (the
 * word-count menu and the default-range unit) never have to care which page
 * they're on:
 *
 * - **Two fields** — the Sort & Filter sidebar's `*_search[words_from]` /
 *   `[words_to]` pair, on works listings, fandom/tag listings and a user's works
 *   page. Matched by the `[words_from]` / `[words_to]` name suffix, so the
 *   `work_search` and `bookmark_search` prefixes are both covered.
 * - **One field** — the advanced search page's `work_search[word_count]`, which
 *   takes a range as text (`1000-5000`, `>1000`, `<5000`).
 *
 * Mirrors {@link file://./filterSidebar.tsx}: we only set the controls, never
 * post anything ourselves. The one difference is {@link applyWordCountRange},
 * which submits the filter form afterwards — a range picked from a work's stats
 * is a long way from the sidebar's own submit button, so leaving it un-applied
 * would read as nothing having happened.
 */

const RANGE_FROM_SELECTOR = 'input[name$="[words_from]"]'
const RANGE_TO_SELECTOR = 'input[name$="[words_to]"]'
const QUERY_SELECTOR = 'input[name$="[word_count]"]'

/** The word-count control(s) on this page, in whichever shape it uses. */
type WordCountFields
  = | { kind: 'range', from: HTMLInputElement, to: HTMLInputElement }
    | { kind: 'query', input: HTMLInputElement }

function findFields(root: ParentNode = document): WordCountFields | null {
  const from = root.querySelector<HTMLInputElement>(RANGE_FROM_SELECTOR)
  const to = root.querySelector<HTMLInputElement>(RANGE_TO_SELECTOR)
  if (from && to)
    return { kind: 'range', from, to }

  const input = root.querySelector<HTMLInputElement>(QUERY_SELECTOR)
  return input ? { kind: 'query', input } : null
}

/** Whether this page can filter by word count at all. */
export function hasWordCountFields(root: ParentNode = document): boolean {
  return findFields(root) !== null
}

/**
 * The range currently dialled into the page's word-count control, or null when
 * it's empty (or holds something we can't map onto two bounds).
 */
export function getWordCountRange(root: ParentNode = document): WordCountRange | null {
  const fields = findFields(root)
  if (!fields)
    return null

  if (fields.kind === 'query')
    return parseWordCountQuery(fields.input.value)

  const from = normalizeBound(fields.from.value)
  const to = normalizeBound(fields.to.value)
  return from === null && to === null ? null : { from, to }
}

/**
 * Write `range` into the page's word-count control — or clear it, for null.
 * Returns false when the page has no such control, so callers can leave the row
 * out of the menu entirely. Does not submit; see {@link applyWordCountRange}.
 */
export function setWordCountRange(range: WordCountRange | null, root: ParentNode = document): boolean {
  const fields = findFields(root)
  if (!fields)
    return false

  if (fields.kind === 'query') {
    fields.input.value = range ? serializeWordCountQuery(range) : ''
    return true
  }

  fields.from.value = range?.from != null ? String(range.from) : ''
  fields.to.value = range?.to != null ? String(range.to) : ''
  return true
}

/** The filter/search form the word-count control submits with. */
function getWordCountForm(root: ParentNode = document): HTMLFormElement | null {
  const fields = findFields(root)
  if (!fields)
    return null
  return (fields.kind === 'query' ? fields.input : fields.from).form
}

/**
 * Set the range and re-run the search. Submitting through `requestSubmit()`
 * fires a real submit event, so `CompressSearchUrls` still gets its chance to
 * shorten the resulting URL. Falls back to leaving the fields filled in (for the
 * user to submit) if the control somehow isn't in a form.
 */
export function applyWordCountRange(range: WordCountRange | null, root: ParentNode = document): boolean {
  if (!setWordCountRange(range, root))
    return false
  getWordCountForm(root)?.requestSubmit()
  return true
}
