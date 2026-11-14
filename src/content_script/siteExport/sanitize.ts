/**
 * Turn a fetched AO3 work page into the HTML the export ships: the work-meta
 * `<dl>` and `#workskin`, and nothing else.
 *
 * Sanitizing happens **before storing**, not at export time — the cache is
 * shared between exports and read on devices with no extension, so whatever it
 * holds has to be inert on its own. {@link file://./workText.ts}'s
 * `WORK_TEXT_VERSION` records which sanitizer wrote an entry; bump it whenever
 * anything here changes what comes out, or the cache will keep serving text
 * built to a shape nothing renders any more.
 *
 * What survives: the whole reading experience — the meta block, title, byline,
 * summary and notes, every chapter of a `view_full_work=true` fetch, and the
 * afterword — and, when they were fetched, the comments, after it all. What
 * doesn't: AO3's scripts and styles, every form and control (kudos, comment
 * and reply boxes, bookmarks, subscribe, "Mark for Later"), and the site chrome
 * around all of it.
 */

import { COMMENTS_CLASS } from './workText.ts'

/**
 * Base for resolving AO3's relative links.
 *
 * Hardcoded rather than taken from `getArchiveLink`, which answers with
 * `document.baseURI` inside a content script: this text is written once and read
 * somewhere else entirely, so it must not depend on which context happened to
 * fetch it.
 */
const ARCHIVE_BASE = 'https://archiveofourown.org'

/** The two halves of a work page worth keeping, in the order they're kept. */
const KEEP_SELECTORS = ['dl.work.meta.group', '#workskin']

/**
 * Removed wholesale, along with everything inside them.
 *
 * All of it is by tag, and deliberately so: the two subtrees we keep hold no
 * site chrome to begin with, so a class-based rule like `.actions` would only
 * ever fire on a *work's own* markup — author HTML is free to use any class it
 * likes, and AO3's own series links in the afterword are an `.actions` list
 * worth keeping.
 */
const DROP_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'template',
  'link',
  'meta',
].join(', ')

/**
 * The parts of each comment that only do something on AO3: its actions (reply,
 * thread, edit), the box a reply opens into, the commenter's icon, and the
 * screen-reader caption over the actions. Pinned to the comment's own children
 * inside the comments section, so neither the work's markup nor a comment's
 * text can match.
 */
const COMMENT_CHROME = ['ul.actions', 'div.icon', 'h5.landmark', '[id^="add_comment_reply_placeholder"]']
  .map(selector => `.${COMMENTS_CLASS} li.comment > ${selector}`)
  .join(', ')

/** The top-level list of comments on a page fetched with `show_comments=true`. */
const COMMENT_THREAD = '#comments_placeholder > ol.thread'

/** Attributes carrying a URL, and whether a `data:` URL is acceptable in them. */
const URL_ATTRIBUTES: [attribute: string, allowData: boolean][] = [
  ['href', false],
  ['src', true],
  ['poster', true],
  ['cite', false],
  ['longdesc', false],
]

/**
 * Sanitize a fetched work page. Returns null when the document holds no work
 * text at all — a login redirect, an adult-content interstitial, a deleted work
 * — which is the caller's cue to classify the failure
 * ({@link file://./fetchWorkText.ts}).
 *
 * `commentPages` are the pages of the work's comments, fetched with
 * `show_comments=true`, in page order (the first is usually `doc` itself).
 * Their threads follow the work as one list, in a section of their own
 * ({@link COMMENTS_CLASS}). A work with no comments gets no section.
 */
export function sanitizeWorkPage(doc: Document, workId: string, commentPages?: readonly Document[]): string | null {
  const skin = doc.querySelector('#workskin')
  if (!skin)
    return null

  const container = doc.createElement('div')
  container.className = 'ao3e-work'
  container.setAttribute('data-ao3e-work-id', workId)

  for (const selector of KEEP_SELECTORS) {
    const found = doc.querySelector(selector)
    if (found)
      container.append(found.cloneNode(true))
  }

  const comments = commentPages && commentsSection(doc, commentPages)
  if (comments)
    container.append(comments)

  for (const el of Array.from(container.querySelectorAll(`${DROP_SELECTORS}, ${COMMENT_CHROME}`)))
    el.remove()

  scrubAttributes(container)

  return container.outerHTML
}

/**
 * How many pages of comments a page fetched with `show_comments=true` says the
 * work has: the highest page AO3's page list names, 1 when the comments fit on
 * one page, and 0 when the page lists none.
 */
export function commentPageCount(doc: Document): number {
  if (!doc.querySelector(`${COMMENT_THREAD} > li`))
    return 0
  let pages = 1
  for (const el of Array.from(doc.querySelectorAll('#comments_placeholder ol.pagination a[href], #comments_placeholder ol.pagination .current'))) {
    const href = el.getAttribute('href')
    const page = href === null ? Number(el.textContent) : Number(new URL(href, ARCHIVE_BASE).searchParams.get('page'))
    if (Number.isInteger(page) && page > pages)
      pages = page
  }
  return pages
}

/** Every page's comments as one list under a heading, or null when there are none. */
function commentsSection(doc: Document, pages: readonly Document[]): HTMLElement | null {
  const threads = pages.flatMap(page => Array.from(page.querySelectorAll(`${COMMENT_THREAD} > li`)))
  if (!threads.length)
    return null
  const section = doc.createElement('div')
  section.className = COMMENTS_CLASS
  const heading = doc.createElement('h3')
  heading.className = 'heading'
  heading.textContent = 'Comments'
  const list = doc.createElement('ol')
  list.className = 'thread'
  list.append(...threads.map(thread => doc.importNode(thread, true)))
  section.append(heading, list)
  return section
}

/**
 * Strip every event handler and resolve every link, in one walk.
 *
 * Links are made absolute rather than left relative because the exported site is
 * served from a folder, not from AO3: `/works/12345` there is a dead path. The
 * exporter rewrites the ones it has a local copy of at export time — it's the
 * only thing that knows which works are in a given export, and the same cached
 * entry has to serve every export it appears in.
 *
 * Fragment links (`#chapter-4`, `#work`) stay exactly as they are; they're the
 * work's own internal navigation and they still work in the exported page.
 */
function scrubAttributes(root: Element): void {
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('on'))
        el.removeAttribute(attr.name)
    }

    for (const [name, allowData] of URL_ATTRIBUTES) {
      const raw = el.getAttribute(name)
      if (raw === null)
        continue
      const resolved = resolveUrl(raw, allowData)
      if (resolved === null)
        el.removeAttribute(name)
      else if (resolved !== raw)
        el.setAttribute(name, resolved)
    }
  }
}

/**
 * The only schemes an exported link may end up with. An allowlist rather than a
 * list of the dangerous ones, because the dangerous ones cannot be enumerated
 * from a string — see {@link resolveUrl}.
 */
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:', 'mailto:'])

/**
 * Resolve one URL attribute against AO3, or null if it has no business being in
 * the export (a `javascript:` link, a `data:` payload somewhere that isn't an
 * image, anything unparseable or in a scheme we don't ship).
 *
 * **The scheme is read off the parsed URL, never off the raw string.** Testing
 * the string first and parsing afterwards is the classic way to let one through:
 * the URL parser strips every ASCII tab and newline out of its input before it
 * looks at anything, so `java&#10;script:alert(1)` — which the HTML parser has
 * already decoded to `java\nscript:…` by the time it reaches here — matches no
 * pattern for `javascript:` and then becomes exactly that on the way out. What
 * is written back is what `new URL` produced, so what is checked is what
 * `new URL` produced.
 *
 * This is the export's only barrier: an exported file assigns its blurb and work
 * HTML through `innerHTML`, and its origin holds the shared `ao3e-site`
 * IndexedDB — marks, journal and options for every export the reader opens.
 */
function resolveUrl(raw: string, allowData: boolean): string | null {
  const value = raw.trim()
  if (!value || value.startsWith('#'))
    return raw

  let url: URL
  try {
    url = new URL(value, ARCHIVE_BASE)
  }
  catch {
    return null
  }

  // Inline images, where the attribute is one that may carry them. Matched on
  // the parsed href for the same reason as everything else here: `dat&#9;a:…`
  // is not a `data:` URL to a regex and is one to the parser.
  if (url.protocol === 'data:')
    return allowData && /^data:image\//i.test(url.href) ? url.href : null

  return ALLOWED_PROTOCOLS.has(url.protocol) ? url.href : null
}
