import { debounce } from '@antfu/utils'

import type { Options } from '#common'
import type { Work } from '#content_script/blurb.js'
import type { FacetValueRef } from '#content_script/searchView/engine.js'
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

import type { Journal } from './journal.ts'
import type { SiteStorage } from './shim.ts'

import { start as startJournal } from './journal.ts'

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
 *
 * What the reader marks, though, has to reach the extension eventually — so
 * every mark made here is also written to a journal ({@link file://./journal.ts})
 * and handed back as a file the extension replays. That is why the panel above
 * the list leads with a count of what hasn't left this browser yet, offers to
 * write it out beside that count, and why a page that cannot keep a journal
 * doesn't offer marks at all.
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
  // Whether the reader's hiding applies to this list at all. The same split the
  // live sources make (`SearchSource.hidesNothing`), which an export can only
  // make by id: the two lists the reader assembled work by work show every work
  // on them, and an export of one that quietly held some back would be a
  // shorter list than the page it was taken from.
  const hidesNothing = sourceId === 'marked-for-later' || sourceId === 'read-works'

  const blurbsHtml = JSON.parse(await decompressEntry(data.blurbs)) as string[]
  const texts = new Map(data.works.map(work => [work.id, work]))
  const listed = new Map(data.manifest.works.map(work => [work.id, work]))

  const loaded = await options.get()
  const status = statusPanel(storage)

  /**
   * The record of what the reader does here, and the gate on whether they are
   * invited to do it at all ({@link file://./journal.ts}).
   *
   * Started before the view, because {@link settings} reads its absence as the
   * answer to "can this page keep a mark?" — and a view built while that was
   * still being decided would draw mark controls it then had to take away.
   *
   * It is handed the mark table as loaded, not a live view of it: all it reads
   * is the *configuration* — which marks alias `read`, which one tracks progress
   * — and an export has no way to change that, since the mark editor is a page
   * of the extension's options and no export carries one.
   */
  const journal = storage.writable
    ? await startJournal({
        sourceId,
        lastExportedAt: storage.meta.lastExportedAt,
        marks: loaded.workMarks,
        onError: status.fail,
      })
    : null
  status.watch(journal)

  let opts = settings(loaded)
  applyChrome(opts)

  const listEl = (<div class={cx('list')} />) as HTMLElement
  const readerEl = (<div class={cx('reader')} hidden />) as HTMLElement
  shell.className = ROOT
  shell.replaceChildren(status.el, listEl, readerEl)

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
      opts = settings(await options.get())
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

  /**
   * The reader's settings as this page may act on them — which is all of them,
   * unless nothing here can be kept.
   *
   * Where there is no journal — the origin failed its probe, or its own store
   * would not answer — per-work marks are switched **off** rather than drawn and
   * lost: a mark that silently fails to save is worse than one that was never
   * offered. The switch is thrown in exactly one place rather than sprinkled
   * through the view as a read-only flag every menu has to remember to check,
   * and the status line says so in words beside it.
   */
  function settings(current: Options): Options {
    if (journal)
      return current
    return { ...current, workMarks: { ...current.workMarks, enabled: false } }
  }

  async function build(current: Options, initialState?: ViewState): Promise<SearchView> {
    const works = worksFromHtml(blurbsHtml)
    const autoExcludes = prepare(works, current)
    const config: SearchViewConfig = {
      perPage: current.searchPerPage,
      autoExcludes,
      decorateBlurb: blurb => decorateBlurb(blurb, current, { hidesNothing }),
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
  function prepare(works: Work[], current: Options): FacetValueRef[] {
    if (sourceId === 'marked-for-later')
      seedMarkedForLater(works.map(work => work.workId))
    applyStatus(works, current)
    const autoExcludes = applyHidden(works, current, { hidesNothing })
    for (const work of works)
      noteIfAbsent(work, listed.get(work.workId))
    return autoExcludes
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

interface StatusPanel {
  el: HTMLElement
  /** Follow a journal's unexported count, or say there is no journal to follow. */
  watch: (journal: Journal | null) => void
  /** Report that the journal stopped taking what the reader does. */
  fail: (error: unknown) => void
}

/**
 * What this file can and cannot keep, said above the list — and the one thing
 * the reader can do about it.
 *
 * Four things, in the order they matter. **What is riding on this browser** —
 * the count of changes that exist nowhere else — because nothing can be asked
 * about when browser storage is cleared, and a `file:` origin will not promise
 * to keep it, so the honest mitigation is to say how much would go. **The way
 * out**, next to that count: one button that writes every change recorded here
 * to a file for the extension to replay, which is the only thing that turns the
 * count from a warning into an errand. **Whether anything is kept at all**,
 * measured rather than assumed ({@link file://./shim.ts}): storage on a local
 * file was found to work, but a page can always be opened somewhere it doesn't.
 * And **how long this has been left alone**, which is the only input to the one
 * rule of thumb anybody can state about eviction — say it as a rule of thumb,
 * not as a countdown the page has no way to honour.
 */
function statusPanel(storage: SiteStorage): StatusPanel {
  const pending = (<p class={cx('status-pending')} hidden />) as HTMLElement
  const keeping = (<p class={cx('status-keep')} />) as HTMLElement
  const actions = (<p class={cx('status-actions')} hidden />) as HTMLElement
  const el = (
    <div class={cx('status')} data-ao3e-writable={String(storage.writable)}>
      {pending}
      {keeping}
      {actions}
    </div>
  ) as HTMLElement

  keeping.textContent = storage.writable
    ? `Local updates enabled, BUT save/export often if you're on Android/iOS; browsers will discard your data without warning! ${lifespan(storage)}`
    : 'Browser preventing saving updates; updating is switched off.'

  const show = (journal: Journal | null): void => {
    const count = journal?.pending.count ?? 0
    el.dataset.ao3ePending = String(count)
    pending.hidden = count === 0
    if (count === 0)
      return
    const oldest = journal?.pending.oldestAt
    pending.replaceChildren(
      <strong>{count === 1 ? '1 change' : `${count.toLocaleString('en-US')} changes`}</strong>,
      ` not yet exported${oldest ? `, ${count === 1 ? 'made' : 'the oldest'} ${ago(oldest)}` : ''}.`,
    )
  }

  /**
   * The button, and whatever it has to say for itself afterwards.
   *
   * Offered whenever there is a journal, not only when something is waiting in
   * it: the file carries everything ever recorded here ({@link
   * file://./journal.ts}), so re-exporting is also how a reader recovers a
   * download they lost. What it says afterwards names the file, because on the
   * device this was built for the next step is finding it in Files and getting
   * it back to the computer the extension is on.
   */
  function offerExport(journal: Journal): void {
    const button = (<button type="button" class={cx('status-export')}>Export changes</button>) as HTMLElement as HTMLButtonElement
    const said = (<span class={cx('status-said')} />) as HTMLElement
    actions.replaceChildren(button, said)
    actions.hidden = false

    button.addEventListener('click', () => {
      button.disabled = true
      said.textContent = 'Saving…'
      journal.save().then(
        (written) => {
          said.textContent = written.ops
            ? `Saved ${written.ops.toLocaleString('en-US')} ${written.ops === 1 ? 'change' : 'changes'} as ${written.fileName} — open it from the extension's options, under Site export.`
            : 'Nothing has been changed here yet.'
        },
        (error: unknown) => {
          said.textContent = `Changes could not be written to a file — ${error instanceof Error ? error.message : String(error)}.`
        },
      ).finally(() => {
        button.disabled = false
      })
    })
  }

  return {
    el,
    watch: (journal) => {
      // Writable when the shim looked, and no journal by the time one was asked
      // for: the origin stopped keeping things between the two. The marks are
      // already off — say why rather than leaving the line above promising them.
      if (!journal && el.dataset.ao3eWritable === 'true') {
        el.dataset.ao3eWritable = 'false'
        keeping.textContent = 'This browser stopped keeping what you change here, so marks are switched off.'
      }
      show(journal)
      journal?.onChange(() => show(journal))
      if (journal)
        offerExport(journal)
    },
    fail: (error) => {
      el.dataset.ao3eWritable = 'false'
      keeping.textContent = `This browser stopped recording what you change here — ${error instanceof Error ? error.message : String(error)}. Anything marked from now on may not be kept.`
      console.error('[AO3E] the change journal failed', error)
    },
  }
}

/**
 * How long this origin has been kept, and what that is worth.
 *
 * `persisted` is only ever good news on a served copy: a `file:` origin answers
 * false to `persist()` however it is asked (measured), so the line says nothing
 * about persistence there rather than implying something it cannot back up.
 */
function lifespan(storage: SiteStorage): string {
  const opened = storage.previousOpen === null
    ? 'Archive currently open for the first time.'
    : `Archive opened ${storage.meta.opens.toLocaleString('en-US')}x as of ${ago(storage.previousOpen)}.`
  return storage.meta.persisted === true
    ? `${opened} This browser has marked them to survive.`
    : `${opened} Saved marks can be suddenly discarded so export changes frequently.`
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** Largest unit first would read "0 years ago"; smallest first stops at the right one. */
const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.345],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
]

/** "3 days ago", from an epoch. */
function ago(timestamp: number): string {
  let value = (timestamp - Date.now()) / 1000
  for (const [unit, span] of RELATIVE_STEPS) {
    if (Math.abs(value) < span)
      return RELATIVE.format(Math.round(value), unit)
    value /= span
  }
  return RELATIVE.format(Math.round(value), 'year')
}
