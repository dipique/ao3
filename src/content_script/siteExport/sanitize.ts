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
 * afterword. What doesn't: AO3's scripts and styles, every form and control
 * (kudos, comments, bookmarks, subscribe, "Mark for Later"), and the site
 * chrome around all of it.
 */

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
 */
export function sanitizeWorkPage(doc: Document, workId: string): string | null {
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

  for (const el of Array.from(container.querySelectorAll(DROP_SELECTORS)))
    el.remove()

  scrubAttributes(container)

  return container.outerHTML
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
 * Resolve one URL attribute against AO3, or null if it has no business being in
 * the export (a `javascript:` link, a `data:` payload somewhere that isn't an
 * image, anything unparseable).
 */
function resolveUrl(raw: string, allowData: boolean): string | null {
  const value = raw.trim()
  if (!value || value.startsWith('#'))
    return raw

  if (/^data:/i.test(value))
    return allowData && /^data:image\//i.test(value) ? value : null

  if (/^(?:javascript|vbscript|blob|file):/i.test(value))
    return null

  try {
    return new URL(value, ARCHIVE_BASE).href
  }
  catch {
    return null
  }
}
