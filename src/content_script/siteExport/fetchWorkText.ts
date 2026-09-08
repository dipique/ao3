import { fetchWithRetry, PATIENCE } from '#content_script/archiveFetch.js'

import type { WorkFreshness, WorkTextFailure, WorkTextMeta } from './workText.ts'

import { sanitizeWorkPage } from './sanitize.ts'
import { recordWorkTextFailure, writeWorkText } from './workTextCache.ts'

/**
 * Fetch one work's text, sanitize it, and store it — the unit of work the
 * caching job ({@link file://./job.ts}) is made of.
 *
 * One request per work: `/works/:id?view_full_work=true&view_adult=true` returns
 * every chapter and the meta block in a single response. The tidier
 * `/downloads/:id/<slug>.html` needs the slug, which is only knowable from the
 * work page — a second request to save a sanitizer pass we need anyway.
 *
 * Nothing here throws for a work that can't be had. A restricted, deleted or
 * broken work records *why* against its entry and lets the run continue; that
 * record is what the export manifest turns into *"not cached — restricted"*
 * instead of a link that 404s.
 *
 * **Two answers are not about the work, and neither is recorded against it.** A
 * reader who pressed Stop hasn't discovered anything about it; neither has an
 * archive that asked us to slow down, since any work requested at that moment
 * would have got the same 429. Both leave the entry exactly as it was — no
 * failure, no backoff earned, nothing for the run to list as unfetchable — and
 * the work simply has not been tried yet.
 */

/** Everything and every chapter, in one response, adult gate pre-cleared. */
const WORK_PAGE_QUERY = 'view_full_work=true&view_adult=true'

const ARCHIVE_BASE = 'https://archiveofourown.org'

/** Longest failure detail kept on an entry — these end up in a list in the UI. */
const MAX_MESSAGE_LENGTH = 200

export interface CacheWorkTextResult {
  workId: string
  /**
   * The entry as stored, whether it holds fresh text or a recorded failure.
   * Absent when nothing was written — see {@link rateLimited}.
   */
  meta?: WorkTextMeta
  /** null when the text was fetched and stored. */
  failure: WorkTextFailure | null
  /** Human-readable detail for the job's error list. */
  message?: string
  /**
   * AO3 was still asking us to wait after {@link file://../archiveFetch.ts} had
   * waited as long as is reasonable. Nothing was recorded against the work,
   * which has simply not been tried yet — the caller should put it back and stop
   * the run rather than grind.
   */
  rateLimited?: boolean
}

export function workPageUrl(workId: string): string {
  return `${ARCHIVE_BASE}/works/${workId}?${WORK_PAGE_QUERY}`
}

/**
 * Fetch, sanitize and cache one work's text.
 *
 * `work` carries the blurb facts the copy is being made current against — they
 * are stored beside the text and are what the next run's staleness check
 * compares a future blurb to ({@link file://./workText.ts}), so they must come
 * from the blurb, not from the work page.
 */
export async function cacheWorkText(work: WorkFreshness, signal?: AbortSignal): Promise<CacheWorkTextResult> {
  const { workId } = work
  const facts = { updatedAt: work.dateUpdated, chapters: work.chapters, words: work.words }

  let res: Response
  try {
    // Nobody is watching a caching run, so it waits out a rate limit rather
    // than coming back to ask the reader for permission to carry on.
    res = await fetchWithRetry(workPageUrl(workId), signal, PATIENCE.bulk)
  }
  catch (err) {
    // An aborted run leaves the entry exactly as it was: the reader stopped us,
    // the work did nothing wrong, and counting it would push it into a backoff
    // it hasn't earned.
    if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError'))
      throw err
    return fail(workId, 'error', err instanceof Error ? err.message : String(err))
  }

  // Not a fact about this work: every work asked for at that moment got the
  // same answer. Recording it would blame the work, put it into a failure
  // backoff it hasn't earned, and list it as unfetchable in a run that simply
  // ran out of patience.
  if (res.status === 429)
    return { workId, failure: null, rateLimited: true }
  if (res.status === 404)
    return fail(workId, 'notfound', 'No such work (deleted, or never existed)')
  if (res.status === 403)
    return fail(workId, 'restricted', 'You do not have access to this work')
  if (res.status !== 200)
    return fail(workId, 'error', `AO3 answered ${res.status}`)

  // `redirect: 'follow'` is the default, so a restricted work arrives as the
  // login page with a 200 — the final URL is the only thing that gives it away.
  if (/\/users\/login/.test(res.url))
    return fail(workId, 'restricted', 'AO3 asked us to sign in — you are signed out, or the work is locked')

  const doc = new DOMParser().parseFromString(await res.text(), 'text/html')
  const html = sanitizeWorkPage(doc, workId)
  if (html === null) {
    // No `#workskin`. The adult-content gate should be impossible (we ask for
    // `view_adult=true`), but if AO3 shows it anyway, say so plainly rather than
    // storing an interstitial as if it were a story.
    const gated = !!doc.querySelector('a[href*="view_adult=true"], .caution')
    return fail(workId, gated ? 'restricted' : 'error', noticeText(doc) ?? 'The page held no work text')
  }

  const meta = await writeWorkText(workId, html, facts)
  return { workId, meta, failure: null }
}

async function fail(workId: string, failure: WorkTextFailure, message: string): Promise<CacheWorkTextResult> {
  const meta = await recordWorkTextFailure(workId, failure)
  return { workId, meta, failure, message: truncate(message) }
}

/** Whatever AO3 said about the page it served instead of the work. */
function noticeText(doc: Document): string | null {
  const el = doc.querySelector('#main .flash.error, #main .flash.notice, #main .notice, #main .caution, #main h2.heading')
  const text = el?.textContent?.replace(/\s+/g, ' ').trim()
  return text || null
}

function truncate(message: string): string {
  const text = message.replace(/\s+/g, ' ').trim()
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text
}
