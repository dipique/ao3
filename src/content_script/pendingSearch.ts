import type { ToastHandle } from '#common'

import { toast } from '#common'

import { onFilterChange } from './filterSidebar.tsx'

/**
 * "The filter says one thing and the results below it say another."
 *
 * A lot of the extension writes into AO3's own Sort and Filter form without
 * submitting it: auto-excluded values, a default language or word count, a range
 * picked from a word count's menu, an include/exclude picked from a tag's. Not
 * submitting is deliberate — the reader may have more to change, and a search
 * that reloaded the page under every menu pick would be worse — but it leaves
 * the listing out of step with its own form, in a sidebar that is usually
 * collapsed. Every one of those writers reports here instead, and this module
 * owns the one answer: a toast saying the results are out of date, with a button
 * that runs the search, and a keyboard shortcut that does the same.
 *
 * Whether there *is* anything to say is decided by comparison, not by who
 * called: the form as the page arrived (the search the results came from) is
 * captured before any unit touches it — see {@link captureSearchBaseline} — and
 * the toast is up exactly while the form differs from that. So picking "exclude"
 * twice leaves nothing to report, and a default the URL already carried reports
 * nothing either.
 *
 * Only a listing's own filter form counts. The advanced search page fills the
 * same kind of fields, but has no results beside them to be out of step with.
 */

/** The filter forms that sit beside a listing's results. */
const FILTER_FORM_SELECTOR = 'form#work-filters, form#bookmark-filters'

/** What the prompt says when its caller doesn't say something more specific. */
const DEFAULT_MESSAGE = 'Your search filters have changed.'

const IS_MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '')

/** The shortcut, as the reader's own keyboard spells it. */
export const RESUBMIT_SHORTCUT_LABEL = IS_MAC ? '⌘+Enter' : 'Ctrl+Enter'

let baseline: { form: HTMLFormElement, state: string } | null = null
let prompt: ToastHandle | null = null

function filterForm(): HTMLFormElement | null {
  const form = document.querySelector<HTMLFormElement>(FILTER_FORM_SELECTOR)
  return form && form.method.toLowerCase() === 'get' ? form : null
}

/**
 * The search a form would run, as one comparable string: what it would submit,
 * less the submit button's label and the empty fields that mean nothing — the
 * same things AO3 ignores (see `compressFilterFormUrl`).
 */
function searchState(form: HTMLFormElement): string {
  const pairs: string[] = []
  for (const [key, value] of new FormData(form)) {
    if (key === 'commit' || typeof value !== 'string' || value === '')
      continue
    pairs.push(`${key}=${value}`)
  }
  return pairs.sort().join('&')
}

/**
 * Remember the search the page's results came from. Called by the content
 * script before any unit's `ready()`; only the first call on a page counts, since
 * every later run finds the form already filled in by the one before.
 */
export function captureSearchBaseline(): void {
  if (baseline)
    return
  const form = filterForm()
  if (form)
    baseline = { form, state: searchState(form) }
}

/** Whether the page's filter form no longer describes the results it sits beside. */
export function isSearchPending(): boolean {
  return !!baseline && baseline.form.isConnected && searchState(baseline.form) !== baseline.state
}

/**
 * Something wrote into the page's filter form. Shows the "update results" prompt
 * if the form now differs from the search the page came from, takes it down if
 * the change put it back. `reason` replaces the prompt's message — the latest
 * one wins; a call without one leaves whatever it says alone.
 */
export function searchFilterChanged(reason?: string): void {
  if (!isSearchPending()) {
    prompt?.hide()
    return
  }

  if (prompt) {
    if (reason)
      prompt.setMessage(reason)
    return
  }

  const handle: ToastHandle = toast(reason ?? DEFAULT_MESSAGE, {
    timeout: 0,
    action: {
      label: `Update results (${RESUBMIT_SHORTCUT_LABEL})`,
      onClick: () => void resubmitSearch(),
    },
    // Closed by hand, or by its own button: the next change raises a fresh one.
    onHide: () => {
      if (prompt === handle)
        prompt = null
    },
  })
  prompt = handle
}

/**
 * Run the page's search as its filter form now stands, exactly as the form's own
 * button would — `requestSubmit` fires the `submit` event, so URL compression
 * still gets its say. Returns false when there is no form to submit.
 */
export function resubmitSearch(): boolean {
  const form = baseline?.form.isConnected ? baseline.form : filterForm()
  if (!form)
    return false
  prompt?.hide()
  const button = form.querySelector<HTMLButtonElement | HTMLInputElement>('[type="submit"]')
  form.requestSubmit(button ?? undefined)
  return true
}

/**
 * Where Ctrl/⌘+Enter already means something else, and is left alone: a link
 * (open it in a new tab), a button, or somewhere to type that isn't part of the
 * filter form — a comment box, the header's own search.
 */
function claimedElsewhere(target: EventTarget | null, form: HTMLFormElement): boolean {
  if (!(target instanceof Element))
    return false
  if (target.closest('a[href], button, [role="button"], [role="link"]'))
    return !form.contains(target)
  const editable = target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
  return !!editable && !form.contains(editable)
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Enter' || e.altKey || e.shiftKey || e.isComposing || e.defaultPrevented)
    return
  if (!(IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey))
    return
  const form = baseline?.form.isConnected ? baseline.form : filterForm()
  if (!form || claimedElsewhere(e.target, form))
    return
  e.preventDefault()
  resubmitSearch()
}

let installed = false

/**
 * Wire the shortcut and the sidebar's change notifications. Once per page, from
 * the content script's module scope — not from a unit, whose listeners come and
 * go with every re-run.
 *
 * The shortcut runs the search whether or not the prompt is up, so it works just
 * as well after ticking boxes in the sidebar by hand.
 */
export function installPendingSearch(): void {
  if (installed)
    return
  installed = true

  document.addEventListener('keydown', onKeyDown)
  // Every include/exclude toggle — from a tag's menu, a hidden work's button,
  // auto-exclusion — lands in the sidebar through `filterSidebar`, which says so.
  onFilterChange(() => searchFilterChanged())
  // The reader editing the form by hand is a search they're about to run
  // themselves, so it raises nothing — but it may undo what the prompt is about.
  document.addEventListener('change', (e) => {
    if (prompt && e.target instanceof Element && baseline?.form.contains(e.target))
      searchFilterChanged()
  })
}
