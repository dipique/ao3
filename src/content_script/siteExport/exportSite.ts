import type { Options, SnapshotDescriptor, ThemeOption } from '#common'

import { getArchiveLink, LOCAL_ONLY, options, textReplacementActive } from '#common'
import { readSnapshot } from '#content_script/searchView/cache.js'

import type { CompressedWork } from './compress.ts'
import type { SiteManifest, SiteManifestWork, SiteOptionsPayload } from './payload.ts'

import { bakeTextReplacements } from './bake.ts'
import { compressEntry } from './compress.ts'
import {
  buildManifest,
  rewriteWorkLinks,
  scriptJson,
  SITE_SCHEMA_VERSION,
  siteShellHead,
  siteShellTail,
  statusFor,
} from './payload.ts'
import { siteBundle } from './siteBundle.ts'
import { readWorkTextIndex, readWorkTexts } from './workTextCache.ts'

/**
 * Turn a stored list and its cached work text into the one HTML file a reader
 * carries away ({@link file://./payload.ts} says what goes in it).
 *
 * The job runner's third step ({@link file://./job.ts}). It reads only what is
 * already on disk: no request goes to AO3 from here, which is why "Download
 * without refreshing" can be offered at all, and why the composite job puts a
 * refresh and a caching pass in front of this one by default.
 *
 * **Text replacements are baked in here, on the way out** — never at fetch time.
 * The cache holds AO3's words; a rule change then costs one re-export rather
 * than a re-fetch of the whole library ({@link file://./bake.ts}). Whatever
 * renders these works must therefore not apply the rules a second time; the
 * manifest says as much in `textReplacementsBaked`.
 */

/**
 * Works whose text is read from storage at once. Big enough that a thousand-work
 * export isn't a thousand round trips, small enough that only a few megabytes of
 * uncompressed HTML are in hand at any moment — each batch is compressed and
 * released before the next is read.
 */
const READ_BATCH = 20

export interface BuildSiteExportOptions {
  /** The snapshot to export — the key the search view stores it under. */
  cacheKey: string
  descriptor: SnapshotDescriptor
  signal?: AbortSignal
  /** Called as each work is compressed into the file. */
  onProgress?: (done: number, total: number) => void
}

export interface SiteExportResult {
  blob: Blob
  /** What to save it as. */
  fileName: string
  /** The manifest that went into it, so the caller can report on the run. */
  manifest: SiteManifest
}

export async function buildSiteExport(opts: BuildSiteExportOptions): Promise<SiteExportResult> {
  const snapshot = await readSnapshot(opts.cacheKey)
  if (!snapshot)
    throw new Error(`There is no stored list for "${opts.descriptor.label}" any more. Refresh the list and try again.`)

  const { scrapedAt } = snapshot
  const listCount = snapshot.works.length

  // One entry per work, in list order. A work listed twice — a series that
  // appears under two fandoms, say — travels once.
  const works: { workId: string, blurbHtml: string }[] = []
  const seen = new Set<string>()
  for (const work of snapshot.works) {
    if (!work.workId || seen.has(work.workId))
      continue
    seen.add(work.workId)
    works.push({ workId: work.workId, blurbHtml: absoluteLinks(work.el) })
  }

  const [index, textSettings, optionsPayload] = await Promise.all([
    readWorkTextIndex(),
    options.get('textReplacements'),
    siteOptionsPayload(),
  ])

  /**
   * Which works this export carries text for, decided from the index before a
   * single one is compressed — a link can only be pointed at a local work if we
   * already know it will be there.
   *
   * The index is the same thing the options row totals, so it is as right as the
   * row is. A key lost to an interrupted write would leave one dangling link
   * from one work to another; the manifest, built from what was actually
   * written, still reports that work honestly.
   */
  const localIds = new Set(works.filter(work => (index[work.workId]?.size ?? 0) > 0).map(work => work.workId))

  const generatedAt = Date.now()
  const manifestWorks: SiteManifestWork[] = []
  const baked = textSettings.enabled && textSettings.rules.some(textReplacementActive)

  // The compressed works, as the JSON fragments they will be written out as.
  // Kept in pieces rather than one array of objects so the finished document is
  // assembled by `Blob` from many medium strings, never a single vast one.
  const workJson: string[] = []
  let done = 0
  opts.onProgress?.(0, works.length)

  for (let start = 0; start < works.length; start += READ_BATCH) {
    opts.signal?.throwIfAborted()
    const batch = works.slice(start, start + READ_BATCH)
    const texts = await readWorkTexts(batch.map(work => work.workId))

    for (const work of batch) {
      const entry = index[work.workId]
      const html = texts[work.workId]
      done++

      if (!html) {
        manifestWorks.push({ id: work.workId, status: statusFor(entry, false) })
        continue
      }

      manifestWorks.push({
        id: work.workId,
        status: 'cached',
        size: entry?.size,
        fetchedAt: entry?.fetchedAt,
      })

      const body = rewriteWorkLinks(bakeTextReplacements(html, textSettings), localIds)
      const compressed: CompressedWork = { id: work.workId, ...await compressEntry(body) }
      workJson.push(scriptJson(compressed))
    }

    opts.onProgress?.(done, works.length)
  }

  const manifest = buildManifest({
    generatedAt,
    source: {
      id: opts.descriptor.sourceId,
      label: opts.descriptor.label,
      listUrl: opts.descriptor.listUrl,
    },
    scrapedAt,
    listCount,
    works: manifestWorks,
    textReplacementsBaked: baked,
  })

  // Blurbs travel as one entry: every facet and the filter want all of them at
  // once, and being near-identical markup they compress far better together than
  // one at a time.
  const blurbs = await compressEntry(JSON.stringify(works.map(work => work.blurbHtml)))

  const blob = new Blob([
    siteShellHead(manifest, siteBundle),
    `{"v":${SITE_SCHEMA_VERSION},"manifest":`,
    scriptJson(manifest),
    ',"options":',
    scriptJson(optionsPayload),
    ',"blurbs":',
    scriptJson(blurbs),
    ',"works":[',
    workJson.join(','),
    ']}',
    siteShellTail(siteBundle),
  ], { type: 'text/html;charset=utf-8' })

  return { blob, fileName: exportFileName(opts.descriptor.label, new Date(generatedAt)), manifest }
}

/**
 * A blurb's HTML with every AO3 link made absolute.
 *
 * A snapshot holds what the archive served, where every href is root-relative —
 * which resolves against `archiveofourown.org` on the page it was scraped from
 * and against the reader's own filesystem in an export. Rewriting them here
 * rather than in the site means the file's links are right before a single
 * script has run, and it leaves them looking like the work links they are: the
 * view's own toolbars find a work by its `/works/:id` href, so a blurb pointed
 * straight at an in-page route would quietly lose its menu. Opening a carried
 * work in the page is the site's job, and it does it by intercepting the click.
 *
 * The nodes are the snapshot's own, already detached from any document, so this
 * mutates them rather than parsing the HTML a second time.
 */
function absoluteLinks(el: HTMLElement): string {
  for (const link of el.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href')
    if (href?.startsWith('/'))
      link.setAttribute('href', getArchiveLink(href))
  }
  return el.outerHTML
}

/**
 * The reader's settings, travelling with their library.
 *
 * Storage-shaped so the exported page's `browser` shim can seed itself from it
 * directly. The exclusions are the sync codec's: `user` is the AO3 account this
 * device happens to be signed in as and `verbose` is a local debug toggle,
 * neither of which means anything on the iPad — and `theme.current` is derived
 * from the device that *exported*, so only the reader's actual choice travels.
 */
async function siteOptionsPayload(): Promise<SiteOptionsPayload> {
  const all = await options.get()
  const items: { [key: string]: unknown } = {}
  for (const [key, value] of Object.entries(all)) {
    if (LOCAL_ONLY.has(key as keyof Options))
      continue
    items[`${options.prefix}${key}`] = key === 'theme' ? { chosen: (value as ThemeOption).chosen } : value
  }
  return { v: SITE_SCHEMA_VERSION, items }
}

/**
 * `AO3-Enhancements-site_marked-for-later-dipique_2026-09-07_14-51-02.html` —
 * the shape "Import & export your settings" already uses, plus the list's name,
 * since a reader with three lists ends up with three of these in one folder.
 *
 * The timestamp is safe to keep even though a later export lands under a new
 * name: every local file shares one storage origin, so a re-export finds
 * whatever the last one left rather than starting over.
 */
export function exportFileName(label: string, when: Date): string {
  const iso = when.toISOString()
  const time = `${iso.slice(0, 10)}_${iso.slice(11, 19).replace(/:/g, '-')}`
  return `AO3-Enhancements-site_${slugify(label)}_${time}.html`
}

function slugify(label: string): string {
  const slug = label
    .normalize('NFKD')
    .replace(/\W+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase()
  return slug || 'list'
}
