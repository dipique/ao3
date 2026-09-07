/**
 * What goes *in* the zip: the manifest, the data script, and the pages the
 * export ships (the plan's §8 layout,
 * {@link file://../../../../plans/site-export.md}).
 *
 * Pure — plain functions over plain data, no `#common`, no `browser`, no DOM —
 * so the shapes below can be checked headlessly. {@link file://./exportSite.ts}
 * is the half that reads storage and hands the results to
 * {@link file://./zip.ts}.
 *
 * ```
 * manifest.json      # this file's SiteManifest, for a human or a script to read
 * blurbs.js          # the same manifest, the reader's options, and the blurbs
 * options.json       # the reader's settings, again readably
 * works/<id>.html    # one cached work, text replacements already baked in (§4)
 * assets/site.css
 * index.html
 * serve.py
 * ```
 *
 * **Why the data is duplicated between the `.json` files and `blurbs.js`.**
 * `fetch()` against `file://` is blocked in Chrome and restricted in Safari, so
 * the site must never fetch its own data — everything it needs at runtime has to
 * arrive as a `<script>`. That is what `blurbs.js` is. The two JSON files are
 * the same content in the form a person (or a future importer) would want to
 * open, and cost a few kilobytes next to the megabytes of work text.
 */

/**
 * Export schema version. One of the plan's three separate numbers (§11) —
 * distinct from `SNAPSHOT_VERSION` and `WORK_TEXT_VERSION`, and bumped when the
 * shape of what lands in the zip changes.
 */
export const SITE_SCHEMA_VERSION = 1

/** The global `blurbs.js` assigns to, and the site reads its whole world from. */
export const SITE_DATA_GLOBAL = '__AO3E'

/** Why a work in the list is, or is not, readable offline. */
export type SiteWorkStatus = 'cached' | 'restricted' | 'notfound' | 'error' | 'uncached'

export interface SiteManifestWork {
  id: string
  status: SiteWorkStatus
  /** Path inside the export. Only on a `cached` work. */
  file?: string
  /** Bytes of the page as written, before deflate. */
  size?: number
  /** Epoch ms the text was fetched from AO3. */
  fetchedAt?: number
}

export interface SiteManifest {
  v: number
  /** Epoch ms this export was built. */
  generatedAt: number
  source: {
    /** {@link SnapshotDescriptor.sourceId} — 'marked-for-later', a tag, a search. */
    id: string
    label: string
    /** Where the list came from, so a reader can go back to it. */
    listUrl: string
  }
  list: {
    /** Epoch ms the listing was last scraped. */
    scrapedAt: number
    /** Works in the list. */
    count: number
  }
  counts: { [status in SiteWorkStatus]: number } & { total: number }
  /**
   * The work pages already have the reader's find/replace rules applied
   * ({@link file://./bake.ts}). The corollary matters: whatever renders these
   * pages must **not** apply them a second time.
   */
  textReplacementsBaked: boolean
  works: SiteManifestWork[]
}

/** The reader's settings, travelling with their library. */
export interface SiteOptionsPayload {
  v: number
  /**
   * Storage-shaped (`option.rules`, `option.workMarks`, …) rather than a bespoke
   * object, so the site build's `browser.storage` shim can seed itself straight
   * from this without a translation layer neither side would enjoy maintaining.
   */
  items: { [key: string]: unknown }
}

/** Where a work's page lives inside the export. */
export function workFilePath(workId: string): string {
  return `works/${workId}.html`
}

/**
 * What the manifest should say about one work, from its cache entry and whether
 * text actually came back for it.
 *
 * A failed entry that still holds text reads as `cached`: the copy is real and
 * readable, and the failure only says the last *refresh* didn't land. Better an
 * older chapter count on the iPad than a work the site refuses to open.
 */
export function statusFor(
  entry: { failure?: string, size?: number } | undefined,
  hasText: boolean,
): SiteWorkStatus {
  if (hasText)
    return 'cached'
  if (!entry?.failure)
    return 'uncached'
  return entry.failure === 'restricted' || entry.failure === 'notfound' ? entry.failure : 'error'
}

export interface ManifestInput {
  generatedAt: number
  source: SiteManifest['source']
  scrapedAt: number
  /** Works in the stored list, which is not the same as `works.length` if any blurb failed to parse. */
  listCount: number
  works: SiteManifestWork[]
  textReplacementsBaked: boolean
}

export function buildManifest(input: ManifestInput): SiteManifest {
  const counts = { total: input.works.length, cached: 0, restricted: 0, notfound: 0, error: 0, uncached: 0 }
  for (const work of input.works)
    counts[work.status]++

  return {
    v: SITE_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    source: input.source,
    list: { scrapedAt: input.scrapedAt, count: input.listCount },
    counts,
    textReplacementsBaked: input.textReplacementsBaked,
    works: input.works,
  }
}

export interface SiteData {
  manifest: SiteManifest
  options: SiteOptionsPayload
  /** Each work's blurb `outerHTML`, in list order — what the view mounts (§8). */
  blurbsHtml: string[]
}

/**
 * `blurbs.js`: one global assignment carrying everything the site needs at run
 * time.
 *
 * Blurb HTML is shipped as HTML rather than as structured data because
 * `Work.el` is a live `<li>` the view mounts directly and `worksFromHtml()`
 * already rehydrates it — a structured payload would mean writing a blurb
 * renderer that does not exist (§11's `Work.el` coupling).
 */
export function siteDataScript(data: SiteData): string {
  return `/* AO3 Enhancements — site export v${SITE_SCHEMA_VERSION}. Generated data; do not edit. */\n`
    + `window.${SITE_DATA_GLOBAL} = ${scriptJson(data)};\n`
}

/**
 * JSON safe to sit inside a `<script>` element.
 *
 * Blurb and work HTML is full of `</…>`, and a literal `</script>` anywhere in a
 * classic script ends it — mid-string, mid-comment, it makes no difference.
 * Escaping every `<` as a unicode escape is the whole fix, and `JSON.parse`
 * reads it back as the character it was.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/**
 * The reader's own copy of a work: the sanitized text, wrapped in a page that
 * can be opened on its own.
 *
 * `body` arrives already rewritten — text replacements baked in
 * ({@link file://./bake.ts}) and links to other works in this same export
 * pointed at their local files ({@link rewriteWorkLinks}).
 */
export function workPageHtml(work: {
  workId: string
  title: string
  label: string
  body: string
  archiveUrl: string
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(work.title || `Work ${work.workId}`)}</title>
<link rel="stylesheet" href="../assets/site.css">
</head>
<body class="ao3e-site ao3e-site-workpage">
<nav class="ao3e-site-nav">
<a href="../index.html">&#8592; ${escapeHtml(work.label)}</a>
<a href="${escapeHtml(work.archiveUrl)}">Open on AO3</a>
</nav>
${work.body}
</body>
</html>
`
}

/** The inline renderer of {@link siteIndexHtml}. Plain ES2017; no build step touches it. */
const INDEX_SCRIPT = `(function () {
  var data = window.${SITE_DATA_GLOBAL} || {}
  var manifest = data.manifest || { works: [], counts: {} }
  var list = document.getElementById('ao3e-works')
  var filter = document.getElementById('ao3e-filter')

  var status = {}
  manifest.works.forEach(function (work) { status[work.id] = work })

  var counts = manifest.counts || {}
  document.getElementById('ao3e-count').textContent =
    (counts.total || 0).toLocaleString() + ' works, ' +
    (counts.cached || 0).toLocaleString() + ' readable offline'

  var template = document.createElement('template')
  var items = (data.blurbsHtml || []).map(function (html) {
    template.innerHTML = html
    var el = template.content.firstElementChild
    if (!el) return null
    var id = (el.id || '').replace('work_', '')
    var entry = status[id]

    // The blurb's own links are AO3-relative and go nowhere here. Point the
    // work at its local copy when we have one, and at AO3 when we do not.
    Array.prototype.forEach.call(el.querySelectorAll('a[href]'), function (a) {
      var href = a.getAttribute('href') || ''
      if (/^\\/works\\/\\d+(?:[?#]|$)/.test(href) && entry && entry.file) a.setAttribute('href', entry.file)
      else if (href.charAt(0) === '/') a.setAttribute('href', 'https://archiveofourown.org' + href)
    })

    if (entry && entry.status !== 'cached') {
      var note = document.createElement('p')
      note.className = 'ao3e-site-uncached'
      note.textContent = entry.status === 'restricted'
        ? 'Not saved \\u2014 restricted'
        : entry.status === 'notfound'
          ? 'Not saved \\u2014 no longer on AO3'
          : entry.status === 'error'
            ? 'Not saved \\u2014 the copy failed'
            : 'Not saved'
      el.appendChild(note)
    }

    var item = document.importNode(el, true)
    return { el: item, text: (item.textContent || '').toLowerCase() }
  }).filter(Boolean)

  function render() {
    var needle = (filter.value || '').trim().toLowerCase()
    list.textContent = ''
    var shown = 0
    items.forEach(function (item) {
      if (needle && item.text.indexOf(needle) === -1) return
      list.appendChild(item.el)
      shown++
    })
    if (!shown) {
      var empty = document.createElement('li')
      empty.className = 'ao3e-site-empty'
      empty.textContent = 'Nothing matches that.'
      list.appendChild(empty)
    }
  }

  filter.addEventListener('input', render)
  render()
})()`

/**
 * `index.html`.
 *
 * Deliberately small: this is the metadata-only site the plan promises at the
 * end of milestone 4, and milestone 5 replaces it wholesale with the real search
 * view behind a `browser` shim (§8). Until then it renders the stored blurbs
 * exactly as they came off AO3, points the cached ones at their local copies,
 * and offers a substring filter — because a thousand works with no filter is not
 * a thing anyone can use on an iPad.
 *
 * The rendering script is inline rather than an `assets/app.js`: that name
 * belongs to the real bundle, and inlining is one fewer file to keep in step.
 */
export function siteIndexHtml(manifest: SiteManifest): string {
  const { label } = manifest.source
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(label)}</title>
<link rel="stylesheet" href="assets/site.css">
</head>
<body class="ao3e-site ao3e-site-index">
<header class="ao3e-site-header">
<h1>${escapeHtml(label)}</h1>
<p class="ao3e-site-meta" id="ao3e-count"></p>
<p class="ao3e-site-note">Your own copy, for reading. It holds other people&#8217;s work &#8212; keep it to yourself.</p>
<input type="search" id="ao3e-filter" placeholder="Filter by title, author, fandom or tag" autocomplete="off" spellcheck="false">
</header>
<ol class="ao3e-site-list" id="ao3e-works"></ol>
<script src="blurbs.js"></script>
<script>
${INDEX_SCRIPT}
</script>
</body>
</html>
`
}

/**
 * `assets/site.css`.
 *
 * Not AO3's skin — that is §8's open question, and it belongs with the real
 * view. This is only enough for the fallback pages to be readable on a phone: a
 * measure, a legible size, and light/dark from the device.
 */
export const SITE_STYLESHEET = `/* AO3 Enhancements — site export. Replaced when the full view ships. */
:root {
  color-scheme: light dark;
  --ao3e-bg: #fff;
  --ao3e-fg: #1a1a1a;
  --ao3e-muted: #5a5a5a;
  --ao3e-line: #d8d8d8;
  --ao3e-link: #0b5aa2;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ao3e-bg: #16181c;
    --ao3e-fg: #e6e6e6;
    --ao3e-muted: #9aa0a6;
    --ao3e-line: #33373d;
    --ao3e-link: #7cb7f0;
  }
}
body.ao3e-site {
  margin: 0 auto;
  padding: 1rem 1rem 4rem;
  max-width: 46rem;
  background: var(--ao3e-bg);
  color: var(--ao3e-fg);
  font: 16px/1.6 Georgia, "Times New Roman", serif;
}
.ao3e-site a { color: var(--ao3e-link); }
.ao3e-site-header { border-bottom: 1px solid var(--ao3e-line); margin-bottom: 1rem; }
.ao3e-site-header h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
.ao3e-site-meta, .ao3e-site-note { color: var(--ao3e-muted); font-size: .85rem; margin: .25rem 0; }
#ao3e-filter {
  width: 100%;
  margin: .75rem 0 1rem;
  padding: .5rem .6rem;
  border: 1px solid var(--ao3e-line);
  border-radius: .4rem;
  background: var(--ao3e-bg);
  color: inherit;
  font: inherit;
  font-size: .95rem;
}
.ao3e-site-list { list-style: none; margin: 0; padding: 0; }
.ao3e-site-list > li { border-bottom: 1px solid var(--ao3e-line); padding: .9rem 0; }
.ao3e-site-list h4 { font-size: 1.05rem; margin: 0 0 .3rem; }
.ao3e-site-list .tags { list-style: none; display: inline; margin: 0; padding: 0; }
.ao3e-site-list .tags li { display: inline; }
.ao3e-site-list .tags li:not(:last-child)::after { content: ", "; }
.ao3e-site-list dl.stats { color: var(--ao3e-muted); font-size: .8rem; }
.ao3e-site-list dl.stats dt, .ao3e-site-list dl.stats dd { display: inline; margin: 0 .2rem 0 0; }
.ao3e-site-uncached { color: var(--ao3e-muted); font-size: .8rem; font-style: italic; margin: .4rem 0 0; }
.ao3e-site-empty { color: var(--ao3e-muted); padding: 2rem 0; text-align: center; }
.ao3e-site-nav {
  display: flex;
  gap: 1rem;
  border-bottom: 1px solid var(--ao3e-line);
  padding-bottom: .6rem;
  margin-bottom: 1.2rem;
  font-size: .85rem;
}
.ao3e-work dl.work.meta { border: 1px solid var(--ao3e-line); border-radius: .4rem; padding: .8rem; font-size: .85rem; }
.ao3e-work dl.work.meta dt { font-weight: 700; }
.ao3e-work dl.work.meta dd { margin: 0 0 .5rem; }
.ao3e-work dl.work.meta ul { list-style: none; display: inline; margin: 0; padding: 0; }
.ao3e-work dl.work.meta ul li { display: inline; }
.ao3e-work dl.work.meta ul li:not(:last-child)::after { content: ", "; }
.ao3e-work .userstuff { overflow-wrap: break-word; }
.ao3e-work .userstuff img { max-width: 100%; height: auto; }
.ao3e-work #chapters > div { border-top: 1px solid var(--ao3e-line); margin-top: 2rem; padding-top: 1rem; }
`

/**
 * A complete `href` naming a work (optionally one of its chapters), with an
 * optional query and fragment. Anchored to the whole attribute so `/works/123/
 * bookmarks` and friends — pages the export has no copy of — stay pointed at AO3.
 */
const WORK_HREF_RE = /href="https:\/\/archiveofourown\.org\/works\/(\d+)(?:\/chapters\/\d+)?(?:\?[^"#]*)?(#[^"]*)?"/g

/**
 * Point links at works that travelled in this same export at their local copies,
 * and leave every other AO3 link absolute.
 *
 * The sanitizer already made every link absolute, on purpose: an entry in the
 * cache has to serve every export it appears in, and only the exporter knows
 * which works are in a given one ({@link file://./sanitize.ts}). So this is a
 * rewrite of complete `href` attributes, which is why it can be a regex rather
 * than a second DOM pass over text we are about to hand to a zip anyway.
 *
 * `prefix` is how deep the reader is: `''` from inside `works/`, `'works/'` from
 * `index.html`. A chapter link collapses to the work's page, which holds every
 * chapter (`view_full_work=true`); its `?query` goes, since the local file takes
 * no parameters, and its `#fragment` stays, since the work's own anchors survive
 * the sanitizer.
 */
export function rewriteWorkLinks(html: string, local: ReadonlySet<string>, prefix: string): string {
  return html.replace(WORK_HREF_RE, (match, id: string, fragment: string | undefined) => {
    if (!local.has(id))
      return match
    return `href="${prefix}${id}.html${fragment ?? ''}"`
  })
}

/** For the little of these pages that is interpolated rather than generated. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
