/**
 * Where a work's page should open instead, under the reader's "Show entire work
 * by default" and "Show comments by default": the same address with
 * `view_full_work=true` added, `show_comments=true` added, or both. Null when
 * the page is already as asked for, or isn't a whole work's own page.
 *
 * AO3 only puts a work's comments on its page when the query asks for them
 * (`show_comments=true`). `#comments` would only scroll to them, so the page
 * opens at the top as usual.
 *
 * Only `/works/:id` (in a collection or not) is redirected. A chapter's own page
 * is where AO3's "Chapter by Chapter" and "Next Chapter" lead, so sending it
 * anywhere else would make reading a chapter at a time impossible; and a page
 * that already names `view_full_work`, a place in the work other than its
 * comments (`#chapter-2`) or `show_comments=true` has made its own choice.
 *
 * The query is extended as written rather than rebuilt, so AO3's own spelling
 * of the rest of it (`+` for a space, unescaped brackets) comes back unchanged.
 *
 * Pure, so it loads under a plain `node --test`.
 */

const WORK_PATH = /^(?:\/collections\/[^/]+)?\/works\/\d+\/?$/

export interface WorkPageDefaults {
  /** Show entire work by default. */
  fullWork: boolean
  /** Show comments by default. */
  comments: boolean
}

export function workPageRedirect(href: string, { fullWork, comments }: WorkPageDefaults): string | null {
  const url = new URL(href)
  if (!WORK_PATH.test(url.pathname))
    return null

  let changed = false
  const addParam = (param: string) => {
    url.search = url.search ? `${url.search}&${param}` : `?${param}`
    changed = true
  }
  if (fullWork && !url.searchParams.has('view_full_work'))
    addParam('view_full_work=true')
  if (comments && (!url.hash || url.hash === '#comments') && url.searchParams.get('show_comments') !== 'true')
    addParam('show_comments=true')
  return changed ? url.href : null
}
