/**
 * Getting around inside one work on the exported page.
 *
 * The page routes by its hash — `#work/<id>` is a work, anything else the list
 * — so a fragment link inside a work (a chapter's "see the end notes", a jump
 * to a chapter) can't be left to the browser: following it would change the
 * hash and land the reader back on the list. These say which hashes are routes
 * and which are places to scroll to.
 */

const WORK_ROUTE_RE = /^#work\/(\d+)$/

/** The work a hash routes to, or undefined for the list. */
export function workRoute(hash: string): string | undefined {
  return WORK_ROUTE_RE.exec(hash)?.[1]
}

/**
 * The element id an in-page link points at, or null for a link that is a route
 * (the list's `#`, a work's) or an address.
 */
export function fragmentTarget(href: string | null): string | null {
  if (!href?.startsWith('#') || href === '#' || href.startsWith('#work/'))
    return null
  const raw = href.slice(1)
  try {
    return decodeURIComponent(raw)
  }
  catch {
    return raw
  }
}

/** One chapter of an open work, and what it is listed as. */
export interface ChapterEntry {
  el: HTMLElement
  label: string
}

/**
 * The chapters of a work fetched whole, in order, each listed by its heading
 * ("Chapter 3: The Title"). A one-chapter work has no chapter divisions, and so
 * no entries.
 */
export function chaptersOf(root: ParentNode): ChapterEntry[] {
  return Array.from(root.querySelectorAll<HTMLElement>('#chapters > .chapter'), (el, i) => {
    const heading = el.querySelector('h3.title')?.textContent?.replace(/\s+/g, ' ').trim()
    return { el, label: heading || `Chapter ${i + 1}` }
  })
}
