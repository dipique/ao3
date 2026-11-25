import type { WorkPageShape } from '#content_script/siteExport/pageCapture.ts'

import { COMMENT_LOAD_RETRY_MS, listedIds, storedListRefs, trackedCopyKeys } from '#common'
import { parseWork } from '#content_script/blurb.js'
import { readParsed } from '#content_script/searchView/blurbStore.ts'
import { pristineBlurb, readStoredLists } from '#content_script/searchView/cache.ts'
import { blurbFromWorkPage } from '#content_script/searchView/workPageBlurb.tsx'
import { captureStep, pageFreshness } from '#content_script/siteExport/pageCapture.ts'
import { commentPageCount, sanitizeWorkPage } from '#content_script/siteExport/sanitize.ts'
import { freshnessFromWork, needsFetch } from '#content_script/siteExport/workText.ts'
import { readWorkTextIndex, writeWorkText } from '#content_script/siteExport/workTextCache.ts'
import { Unit } from '#content_script/Unit.js'
import { parseMarkedForLater } from '#content_script/units/FilterEntityToolbars.tsx'
import { workPageId } from '#content_script/workPage.ts'

/** This page's text is cached: the page says the same on every re-run. */
let kept = false

/** The next look at the page's comments, taken down by the next clean. */
let retry: ReturnType<typeof setTimeout> | null = null

/** Where AO3 puts a work's comments, on the page and when loaded after it. */
const COMMENTS = '#comments_placeholder'

/**
 * "Opportunistically cache work text": a visit to the page of a work in the
 * group the reader chose — their Marked for Later list, or any tracked list's
 * stored copy — caches the work's text from the page itself, as a caching run
 * would have fetched it, when the page holds all of it ({@link captureStep}).
 *
 * First of the units, so the copy is taken before any other has decorated the
 * page, and before text replacements have rewritten it.
 */
export class CacheWorkPage extends Unit {
  static override get name() { return 'CacheWorkPage' }
  override get enabled() { return this.options.opportunisticCache !== null }

  static override async clean(): Promise<void> {
    if (retry !== null)
      clearTimeout(retry)
    retry = null
  }

  override async ready(): Promise<void> {
    const id = workPageId()
    if (kept || !id)
      return
    // Before anything is awaited.
    const page = pristineWorkPage()
    if (!page)
      return
    const shape = shapeOf(page)
    if (captureStep(shape, { comments: false, attempt: 0 }) === 'skip')
      return
    const saved = parseMarkedForLater(document) === true
    if (!(this.options.opportunisticCache === 'markedForLater' ? saved : await this.inTrackedList(id)))
      return
    await this.attempt(id, page, shape, 0)
  }

  private async inTrackedList(id: string): Promise<boolean> {
    const lists = await readStoredLists()
    const keys = trackedCopyKeys({ tracked: this.options.trackedLists, saved: this.options.savedLists }, storedListRefs(lists))
    return listedIds(Object.fromEntries(keys.map(key => [key, lists[key]!]))).has(id)
  }

  /** Cache the page, or look at it again in a moment for comments still on their way. */
  private async attempt(id: string, page: Document, shape: WorkPageShape, attempt: number): Promise<void> {
    const comments = this.options.cacheComments
    const commentsShown = document.querySelectorAll(`${COMMENTS} > ol.thread > li`).length
    const step = captureStep({ ...shape, commentsShown }, { comments, attempt })
    if (step === 'wait') {
      retry = setTimeout(() => {
        retry = null
        this.attempt(id, page, shape, attempt + 1).catch(err => this.logger.error('Could not cache this work\'s text', err))
      }, COMMENT_LOAD_RETRY_MS)
      return
    }
    if (step === 'capture')
      await this.capture(id, page, comments).catch(err => this.logger.error('Could not cache this work\'s text', err))
  }

  private async capture(id: string, page: Document, comments: boolean): Promise<void> {
    const blurb = blurbFromWorkPage(page, id)
    if (!blurb)
      return
    const [stored] = await readParsed([id])
    const facts = pageFreshness(freshnessFromWork(parseWork(blurb, 0)), stored?.dateUpdated)
    const entry = (await readWorkTextIndex())[id]
    if (!needsFetch(entry, facts, Date.now(), { comments, retryFailures: 'now' })) {
      kept = true
      return
    }

    const live = document.querySelector(COMMENTS)
    if (comments && live)
      page.body.append(page.adoptNode(pristineBlurb(live)))
    const html = sanitizeWorkPage(page, id, comments ? [page] : undefined)
    if (html === null)
      return
    await writeWorkText(id, html, {
      updatedAt: facts.dateUpdated,
      chapters: facts.chapters,
      words: facts.words,
      // Only the first page of a work's comments is ever on its page.
      comments: comments && commentPageCount(page) <= 1,
    })
    kept = true
  }
}

/**
 * The work's meta block and text as AO3 served them, in a page of their own:
 * what {@link sanitizeWorkPage} and {@link blurbFromWorkPage} read. Null when
 * this isn't a work page.
 */
function pristineWorkPage(): Document | null {
  const meta = document.querySelector('dl.work.meta.group')
  const workskin = document.querySelector('#workskin')
  if (!meta || !workskin)
    return null
  const page = document.implementation.createHTMLDocument('')
  page.body.append(page.adoptNode(pristineBlurb(meta)), page.adoptNode(pristineBlurb(workskin)))
  return page
}

/** What the page holds, its comments as the page holds them now aside. */
function shapeOf(page: Document): WorkPageShape {
  const stat = (name: string): number => Number.parseInt(page.querySelector(`dl.stats dd.${name}`)?.textContent?.replace(/,/g, '') ?? '', 10) || 0
  const chapters = page.querySelector('#chapters')
  // A one-chapter work's text sits in the chapters block bare; a longer one's,
  // a block per chapter shown.
  const shown = chapters?.querySelectorAll(':scope > .chapter').length || (chapters?.querySelector(':scope > .userstuff') ? 1 : 0)
  return {
    written: stat('chapters'),
    shown,
    comments: stat('comments'),
    commentsShown: 0,
    commentsAsked: location.hash === '#comments' || new URLSearchParams(location.search).get('show_comments') === 'true',
  }
}
