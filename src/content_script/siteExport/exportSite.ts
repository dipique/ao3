import type { Options, SnapshotDescriptor, ThemeOption } from '#common'

import { LOCAL_ONLY, options, textReplacementActive } from '#common'
import { readSnapshot } from '#content_script/searchView/cache.js'

import type { SiteManifest, SiteManifestWork, SiteOptionsPayload } from './payload.ts'
import type { ZipEntry } from './zip.ts'

// Bundled as a string: the exporter runs in the options page and has no
// filesystem, so the one file the reader actually runs travels inside the
// build. Vite's `?raw`; nothing else in `src/` imports a `.py`.
import serveScript from '../../site/serve.py?raw'
import { bakeTextReplacements } from './bake.ts'
import {
  buildManifest,
  rewriteWorkLinks,
  SITE_SCHEMA_VERSION,
  SITE_STYLESHEET,
  siteDataScript,
  siteIndexHtml,
  statusFor,
  workFilePath,
  workPageHtml,
} from './payload.ts'
import { readWorkTextIndex, readWorkTexts } from './workTextCache.ts'
import { createZip } from './zip.ts'

/**
 * Turn a stored list and its cached work text into the zip the reader unpacks —
 * the site payload assembled ({@link file://./payload.ts} says what goes in it).
 *
 * The job runner's third step ({@link file://./job.ts}). It reads only what is
 * already on disk: no request goes to AO3 from here, which is why "Download
 * without refreshing" can be offered at all and why the composite job puts a
 * refresh and a cache pass in front of this one by default.
 *
 * **Text replacements are baked in here, on the way out** — never at fetch time.
 * The cache holds AO3's words; a rule change costs one re-export rather than a
 * re-fetch of the whole library ({@link file://./bake.ts}). Whatever renders
 * these pages must therefore not apply the rules a second time; the manifest
 * says as much in `textReplacementsBaked`.
 */

const ARCHIVE_BASE = 'https://archiveofourown.org'

/**
 * Works whose text is read from storage at once. Big enough that a thousand-work
 * export isn't a thousand round trips, small enough that only a few megabytes of
 * HTML are in hand at any moment — which is the whole reason
 * {@link file://./zip.ts} takes an async iterable.
 */
const READ_BATCH = 20

export interface BuildSiteExportOptions {
  /** The snapshot to export — the key the search view stores it under. */
  cacheKey: string
  descriptor: SnapshotDescriptor
  signal?: AbortSignal
  /** Called as each work is written into the archive. */
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

  // Read out here rather than through `snapshot` below: the generator that needs
  // them is a closure, and narrowing doesn't cross into one.
  const { scrapedAt } = snapshot
  const listCount = snapshot.works.length

  // One entry per work, in list order. A work listed twice — a series that
  // appears under two fandoms, say — travels once.
  const works: { workId: string, title: string, blurbHtml: string }[] = []
  const seen = new Set<string>()
  for (const work of snapshot.works) {
    if (!work.workId || seen.has(work.workId))
      continue
    seen.add(work.workId)
    works.push({ workId: work.workId, title: work.title, blurbHtml: work.el.outerHTML })
  }

  const [index, textSettings, optionsPayload] = await Promise.all([
    readWorkTextIndex(),
    options.get('textReplacements'),
    siteOptionsPayload(),
  ])

  /**
   * Which works this export carries a page for, decided from the index before a
   * single page is written — a link can only be pointed at a local file if we
   * already know the file will be there.
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

  // Assigned by the generator below, before `createZip` resolves.
  let manifest: SiteManifest | null = null

  async function* entries(): AsyncGenerator<ZipEntry> {
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
          file: workFilePath(work.workId),
          size: entry?.size,
          fetchedAt: entry?.fetchedAt,
        })

        // Relative to `works/`, which is where this page is about to live.
        const body = rewriteWorkLinks(bakeTextReplacements(html, textSettings), localIds, '')
        yield {
          path: workFilePath(work.workId),
          data: workPageHtml({
            workId: work.workId,
            title: work.title,
            label: opts.descriptor.label,
            body,
            archiveUrl: `${ARCHIVE_BASE}/works/${work.workId}`,
          }),
        }
      }

      opts.onProgress?.(done, works.length)
    }

    manifest = buildManifest({
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

    yield {
      path: 'blurbs.js',
      data: siteDataScript({
        manifest,
        options: optionsPayload,
        blurbsHtml: works.map(work => work.blurbHtml),
      }),
    }
    yield { path: 'manifest.json', data: JSON.stringify(manifest, null, 2) }
    yield { path: 'options.json', data: JSON.stringify(optionsPayload, null, 2) }
    yield { path: 'index.html', data: siteIndexHtml(manifest) }
    yield { path: 'assets/site.css', data: SITE_STYLESHEET }
    yield { path: 'serve.py', data: serveScript }
  }

  const blob = await createZip(entries(), { date: new Date(generatedAt) })
  return { blob, fileName: exportFileName(opts.descriptor.label, new Date(generatedAt)), manifest: manifest! }
}

/**
 * The reader's settings, travelling with their library.
 *
 * Storage-shaped so the site build's `browser` shim can seed itself from it
 * directly. The exclusions are the sync codec's: `user` is the AO3 account
 * this device happens to be signed in as and `verbose` is a local debug toggle,
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
 * `AO3-Enhancements-site_marked-for-later-dipique_2026-09-07_14-51-02.zip` —
 * the shape "Import & export your settings" already uses, plus the list's name,
 * since a reader with three lists ends up with three of these in one folder.
 */
export function exportFileName(label: string, when: Date): string {
  const iso = when.toISOString()
  const time = `${iso.slice(0, 10)}_${iso.slice(11, 19).replace(/:/g, '-')}`
  return `AO3-Enhancements-site_${slugify(label)}_${time}.zip`
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
