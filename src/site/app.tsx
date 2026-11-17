import { debounce } from '@antfu/utils'

import MdiArrowCollapseUp from '~icons/mdi/arrow-collapse-up.jsx'
import MdiBookmarkCheckOutline from '~icons/mdi/bookmark-check-outline.jsx'
import MdiCommentMultipleOutline from '~icons/mdi/comment-multiple-outline.jsx'

import type { Options } from '#common'
import type { Work } from '#content_script/blurb.js'
import type { FloatingToolbar } from '#content_script/floatingToolbar.tsx'
import type { FacetValueRef } from '#content_script/searchView/engine.js'
import type { SearchViewPrefs } from '#content_script/searchView/prefs.js'
import type { SearchView, SearchViewConfig, ViewState } from '#content_script/searchView/view.js'
import type { SiteData, SiteManifestWork } from '#content_script/siteExport/payload.js'

import { ADDON_CLASS, getArchiveLink, options } from '#common'
import { openMenuOf, pruneDetachedTriggers, setMenusEnabled } from '#content_script/contextTrigger.js'
import { createFloatingToolbar, toolbarButton } from '#content_script/floatingToolbar.tsx'
import { attachReaderSizing } from '#content_script/readerSizing.ts'
import { worksFromHtml } from '#content_script/searchView/cache.js'
import { decorateBlurb, decorateContainer, decorateWorkTitle, makeFacetHider } from '#content_script/searchView/decorate.js'
import { CACHED, NOT_CACHED } from '#content_script/searchView/engine.js'
import { applyHidden } from '#content_script/searchView/hidden.js'
import { loadPrefs, savePrefs } from '#content_script/searchView/prefs.js'
import { applyStatus } from '#content_script/searchView/status.js'
import { createWorkTextSearcher } from '#content_script/searchView/textSearch.js'
import { createSearchView } from '#content_script/searchView/view.js'
import { decompressEntry } from '#content_script/siteExport/compress.js'
import { ALL_CACHED, workHash } from '#content_script/siteExport/payload.js'
import { COMMENTS_CLASS } from '#content_script/siteExport/workText.ts'
import { applySurfaceTheme } from '#content_script/theme.js'
import { seedMarkedForLater } from '#content_script/units/FilterEntityToolbars.js'
import { workPageTitle } from '#content_script/workPage.ts'
import React from '#dom'

import type { Journal } from './journal.ts'
import type { SiteStorage } from './shim.ts'
import type { ChapterEntry } from './workNav.ts'

import { restoreUnimported, start as startJournal } from './journal.ts'
import { chaptersOf, fragmentTarget, workRoute } from './workNav.ts'

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

/** A work id inside an href, however the link was written. */
const WORK_HREF_RE = /\/works\/(\d+)(?:[/?#]|$)/

const ROOT = `${ADDON_CLASS}--site`
const cx = (suffix: string): string => `${ROOT}--${suffix}`

/** The action both ways down to the comments carry: the count in the stats and the toolbar's pill. */
const JUMP_COMMENTS = 'jump-comments'

/** Why a work in the list can't be opened from the file, in the reader's words. */
const UNCACHED_REASON: Record<string, string> = {
  restricted: 'Not saved — this work is restricted',
  notfound: 'Not saved — no longer on the Archive',
  error: 'Not saved — the copy failed',
  uncached: 'Not saved — no copy was made',
}

/** The work on screen. */
interface OpenWork {
  id: string
  /** Its text, once unpacked. */
  body: HTMLElement | null
  /** Takes away what Reader mode gave the text, while it has something. */
  detachSizing: (() => void) | null
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
  // shorter list than the page it was taken from. So does the file of every
  // cached work, which is everything the reader chose to keep.
  const hidesNothing = sourceId === 'marked-for-later' || sourceId === 'read-works' || sourceId === ALL_CACHED

  /**
   * The blurbs, unpacked the first time the list is shown. A tab opened at a
   * work may never show it, and a file can be opened at a work in tab after tab.
   */
  let blurbsHtml: Promise<string[]> | null = null
  const texts = new Map(data.works.map(work => [work.id, work]))
  const listed = new Map(data.manifest.works.map(work => [work.id, work]))
  const listTitle = document.title
  // A work's menu asks whether the work is on the list, built or not.
  if (sourceId === 'marked-for-later')
    seedMarkedForLater(data.manifest.works.map(work => work.id))

  /**
   * The search inside the works, over the copies this file carries. Made once
   * rather than per view: the view is rebuilt on every mark, and the text the
   * searcher has already unpacked is what makes the next search cheap.
   */
  const textSearch = createWorkTextSearcher({
    has: id => texts.has(id),
    load: async (ids) => {
      const unpacked = await Promise.allSettled(ids.map(id => decompressEntry(texts.get(id)!)))
      const out: { [id: string]: string } = {}
      // A damaged copy is one fewer work searched; opening it says what is wrong.
      unpacked.forEach((result, i) => {
        if (result.status === 'fulfilled')
          out[ids[i]!] = result.value
      })
      return out
    },
  })

  const status = statusPanel(storage)
  if (storage.seeded)
    await restoreUnimported(data.applied).catch(status.fail)
  const loaded = await options.get()

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

  let reading: OpenWork | null = null
  /** The open work's floating controls, rebuilt with it and gone with it. */
  let toolbar: FloatingToolbar | null = null
  /** The list on the page, once it has been shown. */
  let view: SearchView | null = null
  /**
   * The latest build of the list, null until the list is first shown. Builds
   * run one after another, each from the settings as they stand and the state
   * the one before it left, and one that fails leaves the next to try again.
   */
  let listBuilt: Promise<void> | null = null
  readerEl.addEventListener('click', onReaderClick)
  document.addEventListener('pointerdown', closeChapterMenus, true)

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
      if (listBuilt)
        await renderList()
      route()
    })()
  })
  options.addListener(() => rerun())

  window.addEventListener('hashchange', route)
  route()
  // A list the file opens on is up before the app counts as started, so one
  // that cannot be built says so in place of the shell.
  if (listBuilt)
    await listBuilt

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

  function renderList(): Promise<void> {
    listBuilt = (listBuilt ?? Promise.resolve()).catch(() => {}).then(async () => {
      mount(await build(opts, view?.getState()))
    })
    return listBuilt
  }

  async function build(current: Options, initialState?: ViewState): Promise<SearchView> {
    blurbsHtml ??= decompressEntry(data.blurbs).then(text => JSON.parse(text) as string[])
    const works = worksFromHtml(await blurbsHtml)
    const autoExcludes = prepare(works, current)
    const config: SearchViewConfig = {
      perPage: current.searchPerPage,
      autoExcludes,
      decorateBlurb: blurb => decorateBlurb(blurb, current, { hidesNothing }),
      decorateContainer: root => decorateContainer(root, current),
      hideFacetValue: makeFacetHider(current),
      textSearch,
      initialState,
      prefs: await layout(),
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
   * The view's layout as this browser last kept it for the list, or else as the
   * reader had it on AO3 when the file was made: the file starts where they
   * left the list, and from their first change on, remembers its own.
   */
  async function layout(): Promise<Partial<SearchViewPrefs>> {
    const kept = await loadPrefs(sourceId)
    return Object.keys(kept).length ? kept : data.layout ?? {}
  }

  /**
   * Everything the works need before the view sees them — the two passes the
   * shared host runs on a live listing, plus the one thing only an export has
   * to say: which of these works it does not actually carry.
   */
  function prepare(works: Work[], current: Options): FacetValueRef[] {
    applyStatus(works, current)
    const autoExcludes = applyHidden(works, current, { hidesNothing })
    for (const work of works) {
      work.offline = texts.has(work.workId) ? CACHED : NOT_CACHED
      noteIfAbsent(work, listed.get(work.workId))
    }
    return autoExcludes
  }

  function noteIfAbsent(work: Work, entry: SiteManifestWork | undefined): void {
    if (texts.has(work.workId))
      return
    work.el.append(<p class={`${ADDON_CLASS}  ${cx('absent')}`}>{UNCACHED_REASON[entry?.status ?? 'uncached'] ?? UNCACHED_REASON.uncached!}</p>)
  }

  function mount(next: SearchView): void {
    listEl.replaceChildren(next.el)
    // The view this replaces is off the page for good. What it registered
    // outside itself — the bridge its blurbs' menus drive its facets through,
    // and those menus' triggers — would otherwise keep every work it held.
    view?.dispose()
    pruneDetachedTriggers()
    view = next
    // A blurb's title still points at AO3 — the work toolbars find their target
    // by that href. A click on a work this file carries opens the file's copy
    // instead, however it was clicked.
    next.el.addEventListener('click', onBlurbClick)
    next.el.addEventListener('auxclick', onBlurbClick)
  }

  function onBlurbClick(event: MouseEvent): void {
    if (event.defaultPrevented || event.button > 1 || event.altKey)
      return
    const link = (event.target as Element | null)?.closest('a[href]')
    const href = link?.getAttribute('href') ?? ''
    const id = WORK_HREF_RE.exec(href)?.[1]
    if (!link || !id || !texts.has(id))
      return
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault()
      location.hash = workHash(id)
      return
    }
    // A new tab or window: the browser opens it as it opens any link, so it
    // lands in the background or in front as the reader's browser decides — at
    // the work's place in this file. The link is pointed there only until the
    // browser has followed it, which happens after every listener has run.
    link.setAttribute('href', workHash(id))
    setTimeout(() => link.setAttribute('href', href))
  }

  function route(): void {
    const id = workRoute(location.hash)
    // What this browser keeps, and the way to export it, is about the list as a
    // whole; over a work it is only in the way of the text.
    status.el.hidden = id !== undefined
    listEl.hidden = id !== undefined
    readerEl.hidden = id === undefined
    if (id === undefined) {
      document.title = listTitle
      closeWork()
      if (!listBuilt)
        void renderList()
      return
    }
    // The view was rebuilt under a work that is still open — a mark made from
    // its title does that. The reader keeps their place in it.
    if (reading?.id === id) {
      dressWork()
      return
    }
    closeWork()
    // Until the work's copy is unpacked and names it.
    document.title = listTitle
    window.scrollTo(0, 0)
    void showWork(id)
  }

  async function showWork(id: string): Promise<void> {
    const body = (<div class={cx('work')}>Unpacking…</div>) as HTMLElement
    const nav = (
      <nav class={cx('nav')}>
        <a href="#">← Back to the list</a>
        <a href={getArchiveLink(`/works/${id}`)} rel="noreferrer">Open on AO3</a>
      </nav>
    ) as HTMLElement
    readerEl.replaceChildren(nav, body)
    const shown: OpenWork = { id, body: null, detachSizing: null }
    reading = shown

    const entry = texts.get(id)
    if (!entry) {
      body.textContent = 'That work is not saved in this file.'
      return
    }
    try {
      const html = await decompressEntry(entry)
      // A reader who moved on while this was unpacking gets what they asked for
      // second, not what they asked for first.
      if (reading !== shown)
        return
      body.innerHTML = html
      shown.body = body
      document.title = workPageTitle(body)?.textContent?.replace(/\s+/g, ' ').trim() || listTitle
      const chapters = chaptersOf(body)
      if (chapters.length > 1)
        nav.append(chapterMenu(chapters))
      dressWork()
    }
    catch (error) {
      body.textContent = `The copy of this work in the file is damaged — it ${error instanceof Error ? error.message : 'could not be read'}.`
    }
  }

  /**
   * What a work page gets on AO3, given to the open work under the settings as
   * they now stand: Reader mode's zoom and width handles, and the title's work
   * menu — and what only a page this long needs: a comment count that leads to
   * the comments saved under the work, and the floating controls.
   */
  function dressWork(): void {
    const body = reading?.body
    if (!reading || !body)
      return
    reading.detachSizing?.()
    // Sizing starts from the column's own width, and is then given the whole
    // window to widen the text into.
    delete body.dataset.ao3eSized
    const workskin = body.querySelector<HTMLElement>('#workskin')
    reading.detachSizing = opts.readerMode && workskin ? attachReaderSizing(workskin).detach : null
    if (reading.detachSizing)
      body.dataset.ao3eSized = ''
    decorateWorkTitle(body, opts)
    const comments = body.querySelector<HTMLElement>(`.${COMMENTS_CLASS}`)
    if (comments)
      linkCommentCount(body)
    mountToolbar(body, comments)
  }

  /**
   * The open work's floating controls, in the corner AO3's pages keep theirs:
   * back to the top, down to the comments when the copy has any, and the menu of
   * marks the title opens, for a reader who never thought to right-click it.
   */
  function mountToolbar(body: HTMLElement, comments: HTMLElement | null): void {
    removeToolbar()
    const next = createFloatingToolbar()
    const pill = (button: HTMLButtonElement, run: () => void): void => {
      button.addEventListener('click', () => {
        run()
        next.setOpen(false)
      })
      next.panel.append(button)
    }
    pill(toolbarButton(<MdiArrowCollapseUp />, 'Jump to top', 'Go back to the top of the work', 'jump-top'), () => window.scrollTo(0, 0))
    if (comments)
      pill(toolbarButton(<MdiCommentMultipleOutline />, 'Jump to Comments', 'Go to the comments saved under the work', JUMP_COMMENTS), () => jumpTo(comments))
    if (opts.workMarks.enabled) {
      const marks = toolbarButton(<MdiBookmarkCheckOutline />, 'Update marks', 'Open the work\'s menu of marks, as right-clicking its title does', 'update-marks')
      pill(marks, () => {
        const title = workPageTitle(body)
        const at = marks.getBoundingClientRect()
        if (title)
          openMenuOf(title, at.left, at.top)
      })
    }
    document.body.append(next.el)
    toolbar = next
  }

  function removeToolbar(): void {
    toolbar?.detach()
    toolbar?.el.remove()
    toolbar = null
  }

  /**
   * Where the work's own links lead, and its comment count: to a place in the
   * work, scrolled to rather than followed, since the hash is the page's route.
   */
  function onReaderClick(event: MouseEvent): void {
    const body = reading?.body
    if (!body || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return
    const target = event.target as Element | null
    if (target?.closest(`[data-ao3e-action="${JUMP_COMMENTS}"]`)) {
      const comments = body.querySelector<HTMLElement>(`.${COMMENTS_CLASS}`)
      if (comments)
        jumpTo(comments)
      return
    }
    const id = fragmentTarget(target?.closest('a[href]')?.getAttribute('href') ?? null)
    const place = id === null ? null : body.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"], a[name="${CSS.escape(id)}"]`)
    if (!place)
      return
    event.preventDefault()
    jumpTo(place)
  }

  function closeWork(): void {
    reading?.detachSizing?.()
    reading = null
    removeToolbar()
  }
}

function jumpTo(el: HTMLElement): void {
  el.scrollIntoView({ block: 'start' })
}

/**
 * The comment count in the work's stats, made a way down to the comments.
 * Whatever link AO3 put on it pointed at its own comment pages, so the count
 * becomes a button showing the same number.
 */
function linkCommentCount(body: HTMLElement): void {
  const count = body.querySelector<HTMLElement>('dl.work.meta.group dd.comments')
  if (!count || count.querySelector(`[data-ao3e-action="${JUMP_COMMENTS}"]`))
    return
  const text = count.textContent?.trim() ?? ''
  count.replaceChildren(
    <button type="button" class={cx('comments-link')} data-ao3e-action={JUMP_COMMENTS} title="Go to the comments">{text}</button>,
  )
}

/**
 * "Jump to chapter", beside the way back to the list: a list of every chapter
 * by its heading, which closes once one is picked, on Escape, or on a click
 * anywhere else ({@link closeChapterMenus}).
 */
function chapterMenu(chapters: readonly ChapterEntry[]): HTMLElement {
  const menu = (
    <details class={cx('chapters')}>
      <summary data-ao3e-action="jump-chapter">Jump to chapter</summary>
      <ol class={cx('chapter-list')}>
        {chapters.map((chapter, i) => (
          <li><button type="button" data-ao3e-chapter={String(i)}>{chapter.label}</button></li>
        ))}
      </ol>
    </details>
  ) as HTMLElement as HTMLDetailsElement
  menu.addEventListener('click', (event) => {
    const picked = (event.target as Element | null)?.closest<HTMLElement>('[data-ao3e-chapter]')
    const chapter = picked && chapters[Number(picked.dataset.ao3eChapter)]
    if (!chapter)
      return
    menu.open = false
    jumpTo(chapter.el)
  })
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menu.open)
      return
    menu.open = false
    menu.querySelector('summary')?.focus()
  })
  menu.addEventListener('toggle', () => {
    if (menu.open)
      keepOnScreen(menu.querySelector<HTMLElement>(`.${cx('chapter-list')}`)!)
  })
  return menu
}

/** The window's edge a dropped-down list keeps clear of, as the page's own gutter does. */
const SCREEN_MARGIN_PX = 16

/** Shift a list that opened under its toggle left, by as much as it would run past the window. */
function keepOnScreen(list: HTMLElement): void {
  list.style.removeProperty('left')
  const over = list.getBoundingClientRect().right - (document.documentElement.clientWidth - SCREEN_MARGIN_PX)
  if (over > 0)
    list.style.left = `${-over}px`
}

function closeChapterMenus(event: Event): void {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>(`details.${cx('chapters')}[open]`)) {
    if (!menu.contains(event.target as Node))
      menu.open = false
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
            ? `Saved ${written.ops.toLocaleString('en-US')} ${written.ops === 1 ? 'change' : 'changes'} as ${written.fileName} — open it from the extension's options, under Lists → Offline reading.`
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
