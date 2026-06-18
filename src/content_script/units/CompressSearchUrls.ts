import { Unit } from '#content_script/Unit.js'

/**
 * The AO3 "Sort and Filter" sidebar form on works-listing pages. It's a plain
 * GET form, so the browser natively serializes every named control into the
 * query string on submit. Heavy exclusion lists (e.g. excluding hundreds of
 * fandoms) can push that URL past the server's ~10k character limit.
 *
 * We don't rely solely on the `#work-filters` id, since the same filter sidebar
 * is reused (with different ids) for bookmarks and other listings. Instead we
 * recognise the form by its characteristic AO3 search controls — any GET form
 * carrying these is safe to compress with the same transforms.
 */
const FILTER_FORM_ID_SELECTOR = 'form#work-filters, form#bookmark-filters'
const FILTER_FORM_FIELD_SELECTOR = [
  '[name="tag_id"]',
  '[name^="work_search"]',
  '[name^="include_work_search"]',
  '[name^="exclude_work_search"]',
  '[name^="bookmark_search"]',
].join(', ')

function isFilterForm(form: HTMLFormElement): boolean {
  // Only GET forms serialize into the URL; never touch a POST submit.
  if (form.method.toLowerCase() !== 'get')
    return false

  return form.matches(FILTER_FORM_ID_SELECTOR)
    || form.querySelector(FILTER_FORM_FIELD_SELECTOR) !== null
}

/**
 * AO3/Rack rejects requests whose URL exceeds roughly 10,100 characters. We
 * only use this to warn in the log — the compressed URL is always strictly
 * shorter than the browser's native one, so navigating to it is never worse
 * than letting the default submit proceed.
 */
const MAX_URL_LENGTH = 10_000

/**
 * Rebuilds the query string a GET form would natively produce, applying three
 * transforms that were verified to preserve results exactly (see
 * ao3/discovery/search-url-compression.md):
 *
 *  1. Drop `commit` — it's just the submit button's label, not a filter.
 *  2. Drop empty-valued params — a blank value is equivalent to absent.
 *  3. Use literal `[`/`]` in keys and `+` for spaces in values instead of the
 *     percent-encoded `%5B`/`%5D`/`%20`. Rack accepts these raw, saving several
 *     characters per array entry.
 *
 * Crucially, the repeated `name[]=value` form for each id is preserved — both
 * comma-joining and dropping the `[]` were verified to silently return wrong
 * results, so they are off-limits.
 */
export function compressFilterFormUrl(form: HTMLFormElement): string {
  const formData = new FormData(form)
  const parts: string[] = []

  for (const [key, rawValue] of formData.entries()) {
    if (key === 'commit')
      continue

    const value = typeof rawValue === 'string' ? rawValue : ''
    if (value === '')
      continue

    const encodedKey = encodeURIComponent(key).replace(/%5B/g, '[').replace(/%5D/g, ']')
    const encodedValue = encodeURIComponent(value).replace(/%20/g, '+')
    parts.push(`${encodedKey}=${encodedValue}`)
  }

  // form.action resolves to the absolute URL (e.g. https://archiveofourown.org/works).
  const action = form.action || `${location.origin}/works`
  return `${action}?${parts.join('&')}`
}

export class CompressSearchUrls extends Unit {
  static override get name() { return 'CompressSearchUrls' }
  override get enabled() { return this.options.compressSearchUrls }

  /**
   * The listener lives on `document` rather than the form, so it survives the
   * page re-rendering the form. We keep a static reference so it can be removed
   * on cleanup (units are re-instantiated whenever options change).
   */
  private static listener: ((e: SubmitEvent) => void) | null = null

  static override async clean(): Promise<void> {
    if (this.listener) {
      document.removeEventListener('submit', this.listener as EventListener, true)
      this.listener = null
    }
  }

  override async ready(): Promise<void> {
    const cls = this.constructor as typeof CompressSearchUrls

    // Guard against double-binding if ready() runs again before clean().
    if (cls.listener)
      document.removeEventListener('submit', cls.listener as EventListener, true)

    const listener = (e: SubmitEvent) => {
      const form = e.target
      if (!(form instanceof HTMLFormElement))
        return

      if (!isFilterForm(form)) {
        this.logger.debug(`Ignoring submit of non-filter form (id=${form.id || '<none>'}, method=${form.method}).`)
        return
      }

      let url: string
      try {
        url = compressFilterFormUrl(form)
      }
      catch (err) {
        // Fall through to AO3's native submit rather than breaking navigation.
        this.logger.error('Failed to compress search URL; using default submit.', err)
        return
      }

      this.logger.debug(`Compressed search URL to ${url.length} characters.`)
      if (url.length > MAX_URL_LENGTH)
        this.logger.warn(`Compressed URL still exceeds ${MAX_URL_LENGTH} characters; AO3 may reject it.`)

      e.preventDefault()
      window.location.href = url
    }

    // Capture phase so we run before the browser's default GET navigation.
    document.addEventListener('submit', listener as EventListener, true)
    cls.listener = listener

    this.logger.debug('Listening for search filter submissions to compress.')
  }
}
