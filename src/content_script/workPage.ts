import { entityIdFromURL } from '#common'

/**
 * The individual work page's own title heading — a bare `<h2>`, not a link, so a
 * blurb-link selector misses it. Null on any other page.
 */
export function workPageTitle(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>('#workskin > .preface.group > h2.title.heading')
}

/**
 * The work id for the page we are on, or null when this isn't a work page.
 *
 * Usually the URL says it. But AO3 also serves a chapter at its own permalink —
 * `/chapters/:id`, carrying no work id and *not* redirecting to the `/works/`
 * form — and there the URL knows nothing, so the id has to come out of the
 * markup. Without this the work menu simply never appeared on those pages, while
 * the author menu (which reads its own link) went on working, so the page looked
 * half-decorated rather than broken.
 *
 * Every fallback below sits in a container that only exists on a work page, so a
 * listing can't match one by accident, and each points at *this* work rather
 * than one it merely links to (a series, or an "inspired by" work).
 */
export function workPageId(): string | null {
  const fromUrl = entityIdFromURL(location.href, 'works')
  if (fromUrl)
    return fromUrl

  const selectors = [
    // The chapter's own permalink, on its heading.
    '#chapters .chapter h3.title a[href*="/works/"]',
    // The chapter-index jump form.
    '#chapter_index form[action*="/works/"]',
    // The work navigation's Entire Work / Share / Comments rows.
    'ul.work.navigation a[href*="/works/"]',
  ]
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      const raw = el.getAttribute('href') ?? el.getAttribute('action')
      const id = raw && entityIdFromURL(raw, 'works', location.origin)
      if (id)
        return id
    }
  }
  return null
}
