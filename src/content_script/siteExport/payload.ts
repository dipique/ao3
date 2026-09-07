import type { CompressedEntry, CompressedWork } from './compress.ts'

/**
 * What goes *in* the file: the manifest, the data block, and the shell around
 * them.
 *
 * Pure — plain functions over plain data, no `#common`, no `browser`, no DOM —
 * so the shapes below can be checked headlessly. The app and the stylesheet
 * arrive as an argument ({@link file://./siteBundle.ts}) rather than being built
 * here, which is what keeps that true. {@link file://./exportSite.ts} is the
 * half that reads storage and assembles the result.
 *
 * An export is one HTML file, in this order:
 *
 * ```
 * <style>                                            the app's stylesheet
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

/**
 * The app and the stylesheet an export carries, as the shell takes them.
 *
 * An argument rather than something built here, which is what lets this module
 * stay plain data with a bundler nowhere near it; where the strings actually
 * come from is {@link file://./siteBundle.ts}'s problem.
 */
export interface SiteBundle {
  /** The whole app, one IIFE, inlined into the export's closing `<script>`. */
  js: string
  /** Its stylesheet, inlined into the export's `<head>`. */
  css: string
}

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
 * Everything above the data block: the CSS, the heading, and a shell that states
 * plainly that the file is inert.
 *
 * That last part is not decoration. Safari will not run scripts in a file opened
 * from disk, so a reader who taps this in the wrong browser gets a page that has
 * to explain itself — otherwise an export that is working perfectly well looks
 * like one that came out empty.
 */
export function siteShellHead(manifest: SiteManifest, bundle: SiteBundle): string {
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
${bundle.css}
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
export function siteShellTail(bundle: SiteBundle): string {
  return `</script>
<script>
${bundle.js}
</script>
</body>
</html>
`
}

/** The whole file, for a caller holding the data rather than streaming it. */
export function siteHtml(manifest: SiteManifest, dataJson: string, bundle: SiteBundle): string {
  return siteShellHead(manifest, bundle) + dataJson + siteShellTail(bundle)
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
