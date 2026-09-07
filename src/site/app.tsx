import { debounce } from '@antfu/utils'

import type { Options } from '#common'
import type { Work } from '#content_script/blurb.js'
import type { SearchView, SearchViewConfig, ViewState } from '#content_script/searchView/view.js'
import type { SiteData, SiteManifestWork } from '#content_script/siteExport/payload.js'

import { ADDON_CLASS, getArchiveLink, options } from '#common'
import { setMenusEnabled } from '#content_script/contextTrigger.js'
import { worksFromHtml } from '#content_script/searchView/cache.js'
import { decorateBlurb, decorateContainer, makeFacetHider } from '#content_script/searchView/decorate.js'
import { applyHidden } from '#content_script/searchView/hidden.js'
import { loadPrefs, savePrefs } from '#content_script/searchView/prefs.js'
import { applyStatus } from '#content_script/searchView/status.js'
import { createSearchView } from '#content_script/searchView/view.js'
import { decompressEntry } from '#content_script/siteExport/compress.js'
import { applySurfaceTheme } from '#content_script/theme.js'
import { seedMarkedForLater } from '#content_script/units/FilterEntityToolbars.js'
import React from '#dom'

import type { SiteStorage } from './shim.ts'

/**
 * The exported page's app: the extension's own search view, running with no
 * extension under it.
 *
 * Not an imitation of the view — the view itself. `view.tsx` builds real DOM
 * through `#dom`'s `h()`, with no virtual DOM and no framework runtime to port,
 * and `engine.ts` is pure, so the only thing between the two and a saved file
 * was the `browser` they read their world out of ({@link file://./shim.ts}).
 * What that buys is everything the reader already has on AO3 — facets, sort,
 * hide and highlight rules, the stats line, marks and the context toolbars —
 * rather than a second renderer to keep in step with the first.
 *
 * What is *not* here is anything that talks to AO3. A work opens from the copy
 * in this file, and the toolbars that reach for the archive (a tag's id, a
 * "Mark for Later") fail the way they fail on a page with no connection: they
 * lose their answers, not their menus.
 */

/** The reader's route: the list, or one work by id. */
const WORK_HASH_RE = /^#work\/(\d+)$/

/** A work id inside an href, however the link was written. */
const WORK_HREF_RE = /\/works\/(\d+)(?:[/?#]|$)/

const ROOT = `${ADDON_CLASS}--site`
const cx = (suffix: string): string => `${ROOT}--${suffix}`

/** Why a work in the list can't be opened from the file, in the reader's words. */
const UNCACHED_REASON: Record<string, string> = {
  restricted: 'Not saved — this work is restricted',
  notfound: 'Not saved — no longer on the Archive',
  error: 'Not saved — the copy failed',
  uncached: 'Not saved — no copy was made',
}

export interface SiteContext {
  /** The static shell the app replaces; it says the file is inert until it does. */
  shell: HTMLElement
  data: SiteData
  storage: SiteStorage
}

export async function startSite(ctx: SiteContext): Promise<void> {
  const { data, shell, storage } = ctx
  const sourceId = data.manifest.source.id

  const blurbsHtml = JSON.parse(await decompressEntry(data.blurbs)) as string[]
  const texts = new Map(data.works.map(work => [work.id, work]))
  const listed = new Map(data.manifest.works.map(work => [work.id, work]))

  let opts = await options.get()
  applyChrome(opts)

  const listEl = (<div class={cx('list')} />) as HTMLElement
  const readerEl = (<div class={cx('reader')} hidden />) as HTMLElement
  shell.className = ROOT
  shell.replaceChildren(statusLine(storage), listEl, readerEl)

  let view = mount(await build(opts))

  /**
   * A mark, a rule, a highlight — anything the reader changes from inside the
   * view lands in storage, and everything derived from it (the Status facet
   * above all) has to be worked out again from the blurbs.
   *
   * The same answer the content script gives on a live page: take the view
   * down, build it again, and hand the new one the state the old one was
   * showing. Rebuilding from the blurb HTML rather than re-using the mounted
   * nodes is the point — a blurb is decorated once per node, so a re-used node
   * would keep yesterday's verdict on it.
   */
  const rerun = debounce(500, () => {
    void (async () => {
      opts = await options.get()
      applyChrome(opts)
      view = mount(await build(opts, view.getState()))
      route()
    })()
  })
  options.addListener(() => rerun())

  window.addEventListener('hashchange', route)
  route()

  function applyChrome(current: Options): void {
    applySurfaceTheme(current.theme?.chosen)
    setMenusEnabled(current.contextMenusEnabled)
  }

  async function build(current: Options, initialState?: ViewState): Promise<SearchView> {
    const works = worksFromHtml(blurbsHtml)
    prepare(works, current)
    const config: SearchViewConfig = {
      perPage: current.searchPerPage,
      decorateBlurb: blurb => decorateBlurb(blurb, current),
      decorateContainer: root => decorateContainer(root, current),
      hideFacetValue: makeFacetHider(current),
      initialState,
      prefs: await loadPrefs(sourceId),
      onPrefsChange: (next) => {
        // A layout that failed to save is not worth interrupting a read for; the
        // status line above already says whether this browser keeps anything.
        void savePrefs(sourceId, next).catch(() => {})
      },
      // A to-read list is triage and opens on what is ready; anywhere else that
      // would quietly hide every work the reader had already started. The same
      // split the sources make on AO3, and the sort's name follows it.
      ...sourceId === 'marked-for-later' ? {} : { defaultStatus: [], sortLabels: { marked: 'Archive order' } },
    }
    // No handlers: there is no native listing behind this view to go back to,
    // and nothing to re-scrape from. Both buttons are left off.
    return createSearchView(works, {}, config)
  }

  /**
   * Everything the works need before the view sees them — the two passes the
   * shared host runs on a live listing, plus the one thing only an export has
   * to say: which of these works it does not actually carry.
   */
  function prepare(works: Work[], current: Options): void {
    if (sourceId === 'marked-for-later')
      seedMarkedForLater(works.map(work => work.workId))
    applyStatus(works, current)
    applyHidden(works, current)
    for (const work of works)
      noteIfAbsent(work, listed.get(work.workId))
  }

  function noteIfAbsent(work: Work, entry: SiteManifestWork | undefined): void {
    if (texts.has(work.workId))
      return
    work.el.append(<p class={`${ADDON_CLASS}  ${cx('absent')}`}>{UNCACHED_REASON[entry?.status ?? 'uncached'] ?? UNCACHED_REASON.uncached!}</p>)
  }

  function mount(next: SearchView): SearchView {
    listEl.replaceChildren(next.el)
    // A blurb's title still points at AO3 — the work toolbars find their target
    // by that href, and a reader holding a modifier still wants the archive. A
    // plain click on a work this file carries is the only one taken here.
    next.el.addEventListener('click', onBlurbClick)
    return next
  }

  function onBlurbClick(event: MouseEvent): void {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return
    const link = (event.target as Element | null)?.closest('a[href]')
    const id = link && WORK_HREF_RE.exec(link.getAttribute('href') ?? '')?.[1]
    if (!id || !texts.has(id))
      return
    event.preventDefault()
    location.hash = `#work/${id}`
  }

  function route(): void {
    const id = WORK_HASH_RE.exec(location.hash)?.[1]
    listEl.hidden = id !== undefined
    readerEl.hidden = id === undefined
    if (id === undefined)
      return
    window.scrollTo(0, 0)
    void showWork(id)
  }

  async function showWork(id: string): Promise<void> {
    const body = (<div class={cx('work')}>Unpacking…</div>) as HTMLElement
    readerEl.replaceChildren(
      <nav class={cx('nav')}>
        <a href="#">← Back to the list</a>
        <a href={getArchiveLink(`/works/${id}`)} rel="noreferrer">Open on AO3</a>
      </nav>,
      body,
    )

    const entry = texts.get(id)
    if (!entry) {
      body.textContent = 'That work is not saved in this file.'
      return
    }
    try {
      const html = await decompressEntry(entry)
      // A reader who moved on while this was unpacking gets what they asked for
      // second, not what they asked for first.
      if (WORK_HASH_RE.exec(location.hash)?.[1] === id)
        body.innerHTML = html
    }
    catch (error) {
      body.textContent = `The copy of this work in the file is damaged — it ${error instanceof Error ? error.message : 'could not be read'}.`
    }
  }
}

/**
 * One line saying whether what the reader does here is kept.
 *
 * Measured, not assumed ({@link file://./shim.ts}): storage on a local file was
 * found to work, but a page can always be opened somewhere it doesn't, and a
 * mark that silently fails to save is worse than one that was never offered.
 */
function statusLine(storage: SiteStorage): HTMLElement {
  return (
    <p class={cx('status')} data-ao3e-writable={String(storage.writable)}>
      {storage.writable
        ? 'Marks, filters and layout you change here are saved in this browser.'
        : 'This browser will not keep anything you change here — marks and layout are gone when the page closes.'}
    </p>
  ) as HTMLElement
}
