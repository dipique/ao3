import type { CompressedEntry, CompressedWork } from './compress.ts'

/**
 * What goes *in* the file: the manifest, the data block, the shell around them,
 * and the placeholder renderer.
 *
 * Pure — plain functions over plain data, no `#common`, no `browser`, no DOM —
 * so the shapes below can be checked headlessly. {@link file://./exportSite.ts}
 * is the half that reads storage and assembles the result.
 *
 * An export is one HTML file, in this order:
 *
 * ```
 * <style>                                            the view's CSS
 * <div id="ao3e-shell">                              inert until a script replaces it
 * <script type="application/json" id="ao3e-data">    manifest, options, entries
 * <script>                                           the app
 * ```
 *
 * **Nothing is fetched, because nothing can be.** `fetch()` against `file://` is
 * blocked in Chrome and restricted in Safari, and the file has to work with
 * nothing behind it at all. The data is a `<script type="application/json">`
 * block rather than a JS literal so the HTML tokenizer merely accumulates its
 * text, where the JS parser would have to tokenize a multi-megabyte string.
 */

/**
 * Export schema version. One of three separate numbers — distinct from
 * `SNAPSHOT_VERSION` and `WORK_TEXT_VERSION`, and bumped when the shape of what
 * lands in the file changes.
 *
 * **2**: one self-contained HTML file. v1 was a folder of pages in a zip.
 */
export const SITE_SCHEMA_VERSION = 2

/** The element the app reads its whole world out of. */
export const SITE_DATA_ID = 'ao3e-data'

/** The element that says the file is inert until the app replaces it. */
export const SITE_SHELL_ID = 'ao3e-shell'

/** Why a work in the list is, or is not, readable offline. */
export type SiteWorkStatus = 'cached' | 'restricted' | 'notfound' | 'error' | 'uncached'

export interface SiteManifestWork {
  id: string
  status: SiteWorkStatus
  /** Bytes of the cached text, before compression. Only on a `cached` work. */
  size?: number
  /** Epoch ms the text was fetched from AO3. */
  fetchedAt?: number
}

export interface SiteManifest {
  v: number
  /**
   * Epoch ms this export was built. Also the generation a later reader compares
   * against before seeding its settings: every local file shares one storage
   * origin, so an older export opened after a newer one must not write its stale
   * options over the fresh ones.
   */
  generatedAt: number
  source: {
    /** The snapshot descriptor's `sourceId` — 'marked-for-later', a tag, a search. */
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
   * The work text already has the reader's find/replace rules applied
   * ({@link file://./bake.ts}). The corollary matters: whatever renders these
   * works must **not** apply them a second time.
   */
  textReplacementsBaked: boolean
  works: SiteManifestWork[]
}

/** The reader's settings, travelling with their library. */
export interface SiteOptionsPayload {
  v: number
  /**
   * Storage-shaped (`option.rules`, `option.workMarks`, …) rather than a bespoke
   * object, so the exported page's `browser.storage` shim can seed itself
   * straight from this without a translation layer neither side would enjoy
   * maintaining.
   */
  items: { [key: string]: unknown }
}

/** Everything the file carries, as the app parses it back out. */
export interface SiteData {
  v: number
  manifest: SiteManifest
  options: SiteOptionsPayload
  /** Every blurb's HTML, as one JSON array, compressed together. */
  blurbs: CompressedEntry
  /** One entry per cached work, each compressed on its own. */
  works: CompressedWork[]
}

/** Where a work lives inside the page. There are no per-work files to navigate to. */
export function workHash(workId: string): string {
  return `#work/${workId}`
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

/**
 * JSON safe to sit inside a `<script>` element.
 *
 * Blurb and work HTML is full of `</…>`, and a literal `</script>` anywhere in a
 * script block ends it — inside a string, inside a comment, it makes no
 * difference. Escaping every `<` as a unicode escape is the whole fix, and
 * `JSON.parse` reads it back as the character it was. (Base64 holds no `<` at
 * all, so in practice this only ever fires on the manifest and the options.)
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/**
 * The export's stylesheet, inlined into the head.
 *
 * Not AO3's own skin — that question belongs with the real view. This is enough
 * for the blurbs and a work to be readable on a phone: a measure, a legible
 * size, and light/dark from the device.
 */
export const SITE_STYLESHEET = `:root {
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
.ao3e-site-inert { border: 1px solid var(--ao3e-line); border-radius: .5rem; padding: 1rem; }
.ao3e-site-inert p { margin: .4rem 0; font-size: .95rem; }
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
 * The placeholder view: the stored blurbs, a substring filter, and a reader that
 * inflates one work at a time.
 *
 * Deliberately small, and meant to be **replaced wholesale** by the real search
 * view once that can be built for this target — facets, sort, rules, marks.
 * Until then it is enough to be worth carrying to a tablet, because a thousand
 * works with no filter is not a thing anyone can use on one.
 *
 * It carries its own base64, inflate and CRC rather than importing
 * {@link file://./compress.ts}: this is an inline string in a generated file,
 * with no bundler between it and the page. The duplication goes when a real
 * bundle arrives and can import the module properly.
 *
 * Plain ES2017, and no template literals — this is itself a template literal.
 */
const SITE_APP_SCRIPT = `(function () {
  var data = JSON.parse(document.getElementById('${SITE_DATA_ID}').textContent)
  var shell = document.getElementById('${SITE_SHELL_ID}')

  var byId = {}
  for (var i = 0; i < data.works.length; i++) byId[data.works[i].id] = data.works[i]
  var status = {}
  for (var j = 0; j < data.manifest.works.length; j++) status[data.manifest.works[j].id] = data.manifest.works[j]

  function fail(message) {
    shell.className = 'ao3e-site-inert'
    shell.textContent = ''
    var p = document.createElement('p')
    p.appendChild(document.createTextNode(message))
    shell.appendChild(p)
  }

  if (typeof DecompressionStream !== 'function')
    return fail('This browser is too old to unpack the works in this file.')

  function fromBase64(text) {
    var binary = atob(text)
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  function crc32(bytes) {
    var crc = 0xFFFFFFFF
    for (var i = 0; i < bytes.length; i++) {
      crc ^= bytes[i]
      for (var bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xEDB88320 ^ (crc >>> 1) : crc >>> 1
    }
    return (crc ^ 0xFFFFFFFF) >>> 0
  }

  var decoder = new TextDecoder()

  function decompress(entry) {
    var stream = new Response(fromBase64(entry.b64)).body.pipeThrough(new DecompressionStream('deflate-raw'))
    return new Response(stream).arrayBuffer().then(function (buffer) {
      var bytes = new Uint8Array(buffer)
      if (bytes.length !== entry.size || crc32(bytes) !== entry.crc)
        throw new Error('The copy of this work in the file is damaged.')
      return decoder.decode(bytes)
    })
  }

  shell.className = ''
  shell.innerHTML = '<div id="ao3e-list">'
    + '<input type="search" id="ao3e-filter" placeholder="Filter by title, author, fandom or tag" autocomplete="off" spellcheck="false">'
    + '<p class="ao3e-site-meta" id="ao3e-shown"></p><ol class="ao3e-site-list" id="ao3e-works"></ol></div>'
    + '<div id="ao3e-reader" hidden><nav class="ao3e-site-nav"><a href="#">&#8592; Back to the list</a>'
    + '<a id="ao3e-ao3" href="https://archiveofourown.org/">Open on AO3</a></nav><div id="ao3e-body"></div></div>'

  var list = document.getElementById('ao3e-works')
  var filter = document.getElementById('ao3e-filter')
  var reader = document.getElementById('ao3e-reader')
  var listView = document.getElementById('ao3e-list')
  var shown = document.getElementById('ao3e-shown')
  var items = []

  decompress(data.blurbs).then(function (json) {
    var template = document.createElement('template')
    var blurbs = JSON.parse(json)
    for (var i = 0; i < blurbs.length; i++) {
      template.innerHTML = blurbs[i]
      if (!template.content.firstElementChild) continue
      var el = document.importNode(template.content.firstElementChild, true)
      var id = (el.id || '').replace('work_', '')

      // Blurb links are AO3-relative and go nowhere here: point a work this file
      // carries at its hash, and send everything else back to the archive.
      var links = el.querySelectorAll('a[href]')
      for (var k = 0; k < links.length; k++) {
        var href = links[k].getAttribute('href') || ''
        if (/^\\/works\\/\\d+(?:[?#]|$)/.test(href) && byId[id]) links[k].setAttribute('href', '#work/' + id)
        else if (href.charAt(0) === '/') links[k].setAttribute('href', 'https://archiveofourown.org' + href)
      }

      var entry = status[id]
      if (entry && entry.status !== 'cached') {
        var note = document.createElement('p')
        note.className = 'ao3e-site-uncached'
        note.appendChild(document.createTextNode(
          entry.status === 'restricted' ? 'Not saved \\u2014 restricted'
            : entry.status === 'notfound' ? 'Not saved \\u2014 no longer on AO3'
              : entry.status === 'error' ? 'Not saved \\u2014 the copy failed'
                : 'Not saved'))
        el.appendChild(note)
      }

      items.push({ el: el, text: (el.textContent || '').toLowerCase() })
    }
    render()
    route()
  })['catch'](function (err) {
    fail('The list in this file could not be read. ' + err.message)
  })

  function render() {
    var needle = filter.value.trim().toLowerCase()
    list.textContent = ''
    var count = 0
    for (var i = 0; i < items.length; i++) {
      if (needle && items[i].text.indexOf(needle) === -1) continue
      list.appendChild(items[i].el)
      count++
    }
    shown.textContent = count === items.length
      ? count.toLocaleString() + ' works'
      : count.toLocaleString() + ' of ' + items.length.toLocaleString() + ' works'
    if (!count) {
      var empty = document.createElement('li')
      empty.className = 'ao3e-site-empty'
      empty.appendChild(document.createTextNode('Nothing matches that.'))
      list.appendChild(empty)
    }
  }

  function route() {
    var match = /^#work\\/(\\d+)$/.exec(location.hash)
    if (!match) {
      reader.hidden = true
      listView.hidden = false
      return
    }
    var id = match[1]
    listView.hidden = true
    reader.hidden = false
    document.getElementById('ao3e-ao3').setAttribute('href', 'https://archiveofourown.org/works/' + id)
    var body = document.getElementById('ao3e-body')
    body.textContent = 'Unpacking\\u2026'
    window.scrollTo(0, 0)
    if (!byId[id]) {
      body.textContent = 'That work is not saved in this file.'
      return
    }
    decompress(byId[id]).then(function (html) {
      // A reader who moved on while this was unpacking gets what they asked for
      // second, not what they asked for first.
      if (location.hash === '#work/' + id) body.innerHTML = html
    })['catch'](function (err) {
      body.textContent = err.message
    })
  }

  filter.addEventListener('input', render)
  window.addEventListener('hashchange', route)
})()`

/**
 * Everything above the data block: the CSS, the heading, and a shell that states
 * plainly that the file is inert.
 *
 * That last part is not decoration. Safari will not run scripts in a file opened
 * from disk, so a reader who taps this in the wrong browser gets a page that has
 * to explain itself — otherwise an export that is working perfectly well looks
 * like one that came out empty.
 */
export function siteShellHead(manifest: SiteManifest): string {
  const { label } = manifest.source
  const total = manifest.counts.total.toLocaleString('en-US')
  const cached = manifest.counts.cached.toLocaleString('en-US')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(label)}</title>
<style>
${SITE_STYLESHEET}
</style>
</head>
<body class="ao3e-site">
<header class="ao3e-site-header">
<h1>${escapeHtml(label)}</h1>
<p class="ao3e-site-meta">${total} works &#183; ${cached} readable offline</p>
<p class="ao3e-site-note">Your own copy, for reading. It holds other people&#8217;s work &#8212; keep it to yourself.</p>
</header>
<div id="${SITE_SHELL_ID}" class="ao3e-site-inert">
<p><strong>This page needs JavaScript, and none is running.</strong></p>
<p>Safari will not run scripts in a file opened from disk. Open this in Microsoft Edge instead, or put it on a web server and open the address.</p>
</div>
<script type="application/json" id="${SITE_DATA_ID}">`
}

/** Everything below the data block: the app, and the end of the document. */
export function siteShellTail(): string {
  return `</script>
<script>
${SITE_APP_SCRIPT}
</script>
</body>
</html>
`
}

/** The whole file, for a caller holding the data rather than streaming it. */
export function siteHtml(manifest: SiteManifest, dataJson: string): string {
  return siteShellHead(manifest) + dataJson + siteShellTail()
}

/**
 * A complete `href` naming a work (optionally one of its chapters), with an
 * optional query and fragment. Anchored to the whole attribute so
 * `/works/123/bookmarks` and friends — pages the export has no copy of — stay
 * pointed at AO3.
 */
const WORK_HREF_RE = /href="https:\/\/archiveofourown\.org\/works\/(\d+)(?:\/chapters\/\d+)?(?:\?[^"#]*)?(?:#[^"]*)?"/g

/**
 * Point links at works that travelled in this same export at their hash, and
 * leave every other AO3 link absolute.
 *
 * The sanitizer already made every link absolute, on purpose: an entry in the
 * cache has to serve every export it appears in, and only the exporter knows
 * which works are in a given one ({@link file://./sanitize.ts}). So this is a
 * rewrite of complete `href` attributes, which is why it can be a regex rather
 * than a second DOM pass over text about to be compressed anyway.
 *
 * A chapter link collapses to the work, which the export carries whole
 * (`view_full_work=true`). Its `?query` goes, since a hash takes no parameters,
 * and its `#fragment` goes too: a route and a fragment are the same slot, and
 * the route has to win.
 */
export function rewriteWorkLinks(html: string, local: ReadonlySet<string>): string {
  return html.replace(WORK_HREF_RE, (match, id: string) => (local.has(id) ? `href="${workHash(id)}"` : match))
}

/** For the little of these pages that is interpolated rather than generated. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
