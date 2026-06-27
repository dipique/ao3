import { ADDON_CLASS, getArchiveLink, logger, parseUser, toast } from '#common'
import { readSnapshot, writeSnapshot } from '#content_script/searchView/cache.ts'
import { detectPageCount, scrapeListing } from '#content_script/searchView/scrape.ts'
import { createSearchView, type SearchView } from '#content_script/searchView/view.tsx'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const FEATURE = `${ADDON_CLASS}--search-marked-for-later`
const cx = (suffix: string): string => `${FEATURE}--${suffix}`
const BUTTON_CLASS = cx('button')
/** Added to the native list + pagination to hide them while the view is shown. */
const NATIVE_HIDDEN_CLASS = cx('native-hidden')

// Module state so the static clean()/teardown can reach the live view + scrape.
let activeView: SearchView | null = null
let activeController: AbortController | null = null
let busy = false

const log = logger.child('SearchMarkedForLater')

function pageUrl(userId: string, page: number): string {
  return getArchiveLink(`/users/${userId}/readings?show=to-read&page=${page}`)
}

function snapshotKey(userId: string): string {
  return `marked-for-later:${userId}`
}

/** Restore the native page: abort any scrape, remove our view, un-hide the list. */
function teardown(): void {
  activeController?.abort()
  activeController = null
  activeView = null
  busy = false
  for (const el of document.querySelectorAll(`.${FEATURE}`))
    el.remove()
  for (const el of document.querySelectorAll(`.${NATIVE_HIDDEN_CLASS}`))
    el.classList.remove(NATIVE_HIDDEN_CLASS)
}

/** Hide the native list + pagination and insert an empty view container after the subnav. */
function mountContainer(): HTMLElement {
  for (const el of document.querySelectorAll('#main ol.reading.work.index.group, #main ol.pagination'))
    el.classList.add(NATIVE_HIDDEN_CLASS)
  const container = (<div class={`${ADDON_CLASS}  ${FEATURE}`} />) as HTMLElement
  const anchor = document.querySelector('#main ul.navigation.actions')
    ?? document.querySelector('#main ol.reading.work.index.group')
  anchor?.after(container)
  return container
}

interface Progress {
  update: (done: number, total: number) => void
}

/** Determinate progress panel shown while a fresh scrape runs. */
function mountProgress(container: HTMLElement): Progress {
  const label = (<div class={cx('progress-label')}>Preparing…</div>) as HTMLElement
  const fill = (<div class={cx('progress-fill')} />) as HTMLElement
  const cancel = (<button type="button" class={cx('progress-cancel')}>Cancel</button>) as HTMLElement
  cancel.addEventListener('click', () => teardown())
  const panel = (
    <div class={cx('progress')}>
      {label}
      <div class={cx('progress-track')}>{fill}</div>
      {cancel}
    </div>
  )
  container.replaceChildren(panel)
  return {
    update(done, total) {
      label.textContent = `Loaded ${done} of ${total} pages…`
      fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`
    },
  }
}

/** Re-scrape in the background and feed the result into the live view + cache. */
async function refresh(userId: string, view: SearchView): Promise<void> {
  activeController?.abort()
  const controller = new AbortController()
  activeController = controller
  try {
    const result = await scrapeListing({
      pageCount: detectPageCount(document),
      pageUrl: page => pageUrl(userId, page),
      signal: controller.signal,
    })
    if (controller.signal.aborted)
      return
    await writeSnapshot(snapshotKey(userId), result.works)
    view.update(result.works)
    if (result.loadedPages < result.totalPages)
      toast(`Updated with ${result.loadedPages} of ${result.totalPages} pages.`, { type: 'error' })
  }
  catch (err) {
    if ((err as Error)?.name !== 'AbortError')
      log.error('Background refresh failed', err)
  }
  finally {
    if (activeController === controller)
      activeController = null
  }
}

function makeHandlers(userId: string): { onBack: () => void, onRefresh: () => void } {
  return {
    onBack: () => teardown(),
    onRefresh: () => {
      if (!activeView)
        return
      const view = activeView
      view.setUpdating(true)
      void refresh(userId, view).finally(() => view.setUpdating(false))
    },
  }
}

/**
 * Adds a "Search Marked for Later" button to your own to-read page that loads
 * every page of the list into one in-memory, instantly filterable/sortable view
 * (rendered in place; a "Back to list" button restores the native page). A
 * cached snapshot renders instantly on revisit while a fresh scrape runs in the
 * background. The view itself ({@link createSearchView}) is source-agnostic — the
 * only Marked-for-Later-specific code lives here.
 */
export class SearchMarkedForLater extends Unit {
  static override get name() { return 'SearchMarkedForLater' }
  override get enabled() { return this.options.searchMarkedForLater }

  static override async clean(): Promise<void> {
    teardown()
  }

  override async ready(): Promise<void> {
    // Only your own Marked for Later page, and only when logged in.
    const match = location.pathname.match(/^\/users\/([^/]+)\/readings\/?$/)
    if (!match)
      return
    if (new URLSearchParams(location.search).get('show') !== 'to-read')
      return
    if (!document.body.classList.contains('logged-in'))
      return
    const pageUser = match[1]!
    const currentUser = parseUser(document)?.userId
    if (!currentUser || currentUser.toLowerCase() !== pageUser.toLowerCase())
      return

    const current = Array.from(document.querySelectorAll('#main ul.navigation.actions span.current'))
      .find(span => span.textContent?.trim() === 'Marked for Later')
    const host = current?.closest('li')
    if (!host || host.parentElement?.querySelector(`.${BUTTON_CLASS}`))
      return

    const button = (
      <button type="button" class={`${ADDON_CLASS}  ${BUTTON_CLASS}`}>Search Marked for Later</button>
    ) as HTMLElement as HTMLButtonElement
    button.addEventListener('click', () => {
      void this.onClick(pageUser)
    })
    host.after(<li class={ADDON_CLASS}>{button}</li>)
    this.logger.debug('Search Marked for Later button added.')
  }

  async onClick(userId: string): Promise<void> {
    if (busy || document.querySelector(`.${FEATURE}`))
      return
    busy = true
    try {
      const key = snapshotKey(userId)
      const container = mountContainer()
      const handlers = makeHandlers(userId)

      const cached = await readSnapshot(key)
      if (cached && cached.works.length) {
        // Render instantly from cache, then refresh in the background.
        const view = createSearchView(cached.works, handlers)
        activeView = view
        container.replaceChildren(view.el)
        view.setUpdating(true)
        void refresh(userId, view).finally(() => view.setUpdating(false))
        return
      }

      // No cache: scrape with a progress bar before showing the view.
      const progress = mountProgress(container)
      const controller = new AbortController()
      activeController = controller
      try {
        const result = await scrapeListing({
          pageCount: detectPageCount(document),
          pageUrl: page => pageUrl(userId, page),
          onProgress: progress.update,
          signal: controller.signal,
        })
        await writeSnapshot(key, result.works)
        if (!result.works.length) {
          toast('No works found in your Marked for Later list.', { type: 'error' })
          teardown()
          return
        }
        const view = createSearchView(result.works, handlers)
        activeView = view
        container.replaceChildren(view.el)
        if (result.loadedPages < result.totalPages)
          toast(`Loaded ${result.loadedPages} of ${result.totalPages} pages — some couldn't be fetched.`, { type: 'error' })
      }
      catch (err) {
        if ((err as Error)?.name !== 'AbortError') {
          this.logger.error('Failed to load Marked for Later', err)
          toast('Could not load your Marked for Later list.', { type: 'error' })
        }
        teardown()
      }
      finally {
        if (activeController === controller)
          activeController = null
      }
    }
    finally {
      busy = false
    }
  }
}
