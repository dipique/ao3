import type { SnapshotDescriptor } from '#common'
import type { WaitReason } from '#content_script/archiveFetch.js'
import type { Work } from '#content_script/blurb.js'
import type { FollowState, ListRefresh, RefreshOutcome } from '#content_script/searchView/listRefresh.ts'
import type { RefreshOptions, RefreshResult } from '#content_script/searchView/refresh.js'
import type { Hold } from '#content_script/searchView/refreshClaim.ts'

import { createLogger, options, READING_ELSEWHERE, readWorkIds, REVIEW_SOURCE_ID, reviewStart, saveAs, SITE_EXPORT_JOB_KEY } from '#common'
import { onArchiveWait, PATIENCE, WAIT_BUDGET } from '#content_script/archiveFetch.js'
import { saveMarkedForLaterIndex } from '#content_script/markedForLaterIndex.js'
import { PAGE_RUN } from '#content_script/pageRun.ts'
import { recoverReadWorks } from '#content_script/readWorks.ts'
import { readSnapshotData } from '#content_script/searchView/cache.js'
import { followState, loadingLine, refreshStep, sharesRefresh } from '#content_script/searchView/listRefresh.ts'
import { refreshSnapshot } from '#content_script/searchView/refresh.js'
import { acquireRefresh, awaitRefresh, readRefresh, requestCancel } from '#content_script/searchView/refreshClaim.ts'
import { claimReads } from '#content_script/tracked/readClaim.ts'
import { readTrackedLists } from '#content_script/tracked/readLists.ts'

import type { WorkFreshness } from './workText.ts'

import { buildSiteExport } from './exportSite.ts'
import { cacheWorkText } from './fetchWorkText.ts'
import { REFRESH_REFUSED } from './refreshRefusals.ts'
import { freshnessFromWork, planWorkCache } from './workText.ts'
import { readWorkTextIndex } from './workTextCache.ts'

/**
 * The site export's job runner: one persisted state machine, driven from the
 * options page.
 *
 * **Why the options page and not the background.** Both halves of the job parse
 * HTML — the listing scrape and the work-text sanitizer — and a Chrome MV3
 * service worker has no `DOMParser`. Since the job is persisted every few works,
 * an options page that has to stay open is a mild cost for an administrative
 * action, and the seam is clean: nothing here knows who ticks it, so moving it
 * behind an offscreen document later is additive.
 *
 * **One job at a time, for the whole extension.** Politeness towards AO3 is a
 * property of the browser, not of a list: two runs would simply double the
 * request rate. So the runner is a singleton, and starting a job while one is
 * running is refused rather than queued.
 *
 * **What is persisted, and what is not.** The record below holds only what a
 * resume can't recompute — which list, which steps, which ids are left. Every
 * work's title and staleness facts are rebuilt from the snapshot on the way in
 * ({@link loadContext}), because the snapshot is already stored and is what the
 * queue was planned against in the first place. Nothing records that a job is
 * running*: running-ness belongs to the live page, and a flag persisted across
 * a crash could only ever lie.
 */

const log = createLogger('siteExport')

/** Failures kept for the UI's list. {@link ExportJob.errorCount} keeps the true total. */
const MAX_ERRORS = 50

/** Works fetched between writes of the job record — the resolution a crash resumes at. */
const PERSIST_EVERY = 5

/** Simultaneous work fetches. Matches `scrapeListing`'s pool — politeness towards AO3. */
const CONCURRENCY = 3

/**
 * A step the job can be in the middle of.
 *
 * Refresh list is `['refreshing']`, Cache works `['caching']`, and Download site
 * the three together — refresh the list, cache against it, then write the zip.
 */
export type ExportJobPhase = 'refreshing' | 'caching' | 'exporting'

export interface ExportJobError {
  workId: string
  title: string
  reason: string
}

/** The persisted job. Everything else about a run is rebuilt or recomputed. */
export interface ExportJob {
  /** The snapshot this job is about — the key the search view stores it under. */
  cacheKey: string
  descriptor: SnapshotDescriptor
  /**
   * Steps still to run, in order; the first is what the job is doing now, and
   * the job is finished when this empties. Spelled out rather than derived from
   * a "goal", so a resumed job needs no rules to work out where it got to.
   */
  steps: ExportJobPhase[]
  /** Work ids still to fetch, in list order. Shrinks as they complete. */
  queue: string[]
  done: number
  total: number
  startedAt: number
  /** Epoch ms of the last write — how a job found on disk says how old it is. */
  updatedAt: number
  /** Retry works whose last fetch failed without waiting out their backoff. */
  retryNow?: boolean
  /** Per-work failures for the UI, capped at {@link MAX_ERRORS}. */
  errors: ExportJobError[]
  /** Failures counted, including those past the cap. */
  errorCount: number
  /** Set when the job stopped waiting on something — today only a 429 backoff. */
  blocked?: 'rate-limited'
}

/** What the options page renders. Rebuilt on every change; the UI never mutates it. */
export interface JobStatus {
  /** The job, running or merely stored. Null when there is none. */
  job: ExportJob | null
  running: boolean
  /** What is happening right now, for the progress line. Empty when idle. */
  message: string
  /** Why the job stopped short of finishing. */
  error: string | null
  /** Things worth saying that didn't stop the run (a partial or signed-out scrape). */
  warnings: string[]
  /**
   * Epoch ms this run may next ask AO3 for something, while it is sitting out a
   * rate limit; null when nothing is waiting.
   *
   * A deadline rather than a formatted countdown, because a message composed
   * here would be a minute stale a minute later. The view holds the clock.
   */
  waitingUntil: number | null
  /** Which kind of pause {@link waitingUntil} is: the archive refusing us, or us pacing ourselves. */
  waitReason: WaitReason | null
}

type Listener = (status: JobStatus) => void

const listeners = new Set<Listener>()

/** The live job object, mutated in place and shallow-copied out on publish. */
let current: ExportJob | null = null
let running = false
let message = ''
let error: string | null = null
let warnings: string[] = []
let waitingUntil: number | null = null
let waitReason: WaitReason | null = null
let controller: AbortController | null = null
/** The running job is to be thrown away once it stops, not left to continue. */
let cancelling = false
/** A refresh another page runs that the job's refresh step is waiting on, for a Cancel to name. */
let following: { cacheKey: string, id: string } | null = null

let status: JobStatus = { job: null, running: false, message: '', error: null, warnings: [], waitingUntil: null, waitReason: null }

function publish(): void {
  // A fresh outer object each time, so a `shallowRef` on the Vue side sees the
  // change; `queue` and `errors` stay shared, since a run mutates them per work
  // and copying a thousand-id queue that often would be the expensive part.
  status = { job: current ? { ...current } : null, running, message, error, warnings, waitingUntil, waitReason }
  for (const listener of listeners)
    listener(status)
}

/** The current status, for a caller that isn't subscribing. */
export function jobStatus(): JobStatus {
  return status
}

/** Subscribe to job changes. Called immediately with the current status. */
export function subscribeJob(listener: Listener): () => void {
  listeners.add(listener)
  listener(status)
  return () => {
    listeners.delete(listener)
  }
}

// Another options page threw away the job this one holds as paused: so does this one.
browser.storage.onChanged.addListener((changes, area) => {
  const change = changes[SITE_EXPORT_JOB_KEY]
  if (area !== 'local' || !change || change.newValue !== undefined || running || !current?.steps.length)
    return
  current = null
  error = null
  warnings = []
  publish()
})

/** The stored job, if a previous run left one unfinished. */
export async function readJob(): Promise<ExportJob | null> {
  const stored = (await browser.storage.local.get(SITE_EXPORT_JOB_KEY))[SITE_EXPORT_JOB_KEY] as ExportJob | undefined
  return stored ?? null
}

async function persist(job: ExportJob): Promise<void> {
  job.updatedAt = Date.now()
  await browser.storage.local.set({ [SITE_EXPORT_JOB_KEY]: job })
}

async function forget(): Promise<void> {
  await browser.storage.local.remove(SITE_EXPORT_JOB_KEY)
}

/**
 * Adopt whatever job a previous session left behind — the whole of auto-resume.
 * A crash, a browser restart and a closed options tab all land here, and the
 * page then offers to continue it.
 */
export async function loadJob(): Promise<ExportJob | null> {
  if (running)
    return current
  current = await readJob()
  message = ''
  error = null
  warnings = []
  waitingUntil = null
  waitReason = null
  publish()
  return current
}

export interface StartJobOptions {
  cacheKey: string
  descriptor: SnapshotDescriptor
  steps: ExportJobPhase[]
  /** Retry works whose last attempt failed, without waiting out their backoff. */
  retryNow?: boolean
}

/**
 * Begin a job, replacing any unfinished one. Resolves when the run stops — by
 * finishing, by being stopped, or by failing; the reason lands in
 * {@link JobStatus} rather than being thrown, because every caller is a button
 * that has already told the reader what it is doing.
 */
export async function startJob(opts: StartJobOptions): Promise<void> {
  if (running)
    throw new Error('Another site export job is already running.')

  const now = Date.now()
  current = {
    cacheKey: opts.cacheKey,
    descriptor: opts.descriptor,
    steps: [...opts.steps],
    queue: [],
    done: 0,
    total: 0,
    startedAt: now,
    updatedAt: now,
    retryNow: opts.retryNow,
    errors: [],
    errorCount: 0,
  }
  await persist(current)
  await drive(current)
}

/** Continue the stored job from wherever it stopped. */
export async function resumeJob(): Promise<void> {
  if (running)
    return
  const job = current ?? await readJob()
  if (!job)
    throw new Error('There is no site export job to resume.')
  current = job
  // Whatever it was waiting for, the reader has decided the wait is over.
  delete job.blocked
  await drive(job)
}

/**
 * Stop the running job. The queue survives, so the button goes back to offering
 * to continue rather than to start again: stopping clears the running flag and
 * leaves the queue alone.
 */
export function stopJob(): void {
  controller?.abort()
}

/**
 * Stop the job and throw it away: the reader doesn't want it finished, now or
 * later. A refresh on another page that the job is waiting on is asked to stop
 * too, since this job's refresh is that one.
 */
export async function cancelJob(): Promise<void> {
  const elsewhere = following ?? (running && current?.steps[0] === 'refreshing' ? await refreshElsewhere(current.cacheKey) : null)
  if (elsewhere)
    void requestCancel(elsewhere.cacheKey, elsewhere.id).catch(err => log.error('Could not ask for the refresh to stop', err))
  if (!running)
    return discardJob()
  cancelling = true
  stopJob()
}

/** The refresh of `cacheKey` another page is running now, if there is one: the one a job about to follow it is waiting on. */
async function refreshElsewhere(cacheKey: string): Promise<{ cacheKey: string, id: string } | null> {
  const stored = await readRefresh(cacheKey).catch(() => null)
  return stored && refreshStep(stored, PAGE_RUN, Date.now()) === 'follow' ? { cacheKey, id: stored.id } : null
}

/** Throw the stored job away — the reader has decided they don't want it finished. */
export async function discardJob(): Promise<void> {
  stopJob()
  current = null
  message = ''
  error = null
  warnings = []
  waitingUntil = null
  waitReason = null
  await forget()
  publish()
}

async function drive(job: ExportJob): Promise<void> {
  controller = new AbortController()
  const { signal } = controller
  running = true
  message = ''
  error = null
  warnings = []
  waitingUntil = null
  waitReason = null
  publish()

  // A pause can run to minutes, and every worker is inside it, so without this
  // the run looks like it has hung. The deadline and its kind are reported as
  // facts, and the page words them: the line it shows has to count down.
  const unwatch = onArchiveWait((until, reason) => {
    waitingUntil = until || null
    waitReason = until ? reason : null
    publish()
  })

  try {
    while (job.steps.length) {
      if (job.steps[0] === 'refreshing')
        await runRefresh(job, signal)
      else if (job.steps[0] === 'caching')
        await runCaching(job, signal)
      else
        await runExport(job, signal)

      // A stop or a 429 leaves the step in place, so resuming picks it up again.
      if (signal.aborted || job.blocked)
        break
      job.steps.shift()
      await persist(job)
    }
  }
  catch (err) {
    // A Pause or a Cancel is the reader's doing, not a failure, so it is logged quietly.
    if (signal.aborted) {
      log.log('Site export job stopped', err)
    }
    else {
      error = describe(err)
      log.error('Site export job stopped', err)
    }
  }
  finally {
    unwatch()
    controller = null
    running = false
    message = ''
    waitingUntil = null
    waitReason = null
    if (cancelling) {
      cancelling = false
      current = null
      error = null
      warnings = []
    }
    else if (job.blocked === 'rate-limited' && !error) {
      error = 'AO3 kept asking us to wait, so the run stopped after waiting it out for as long as is sensible. '
        + 'Everything fetched so far is saved, and nothing is held against the works that were still queued — press Continue when you like.'
    }
    if (!current || (!job.steps.length && !job.blocked))
      await forget()
    else
      await persist(job)
    publish()
  }
}

/**
 * Refresh the job's list. A list that shares its refresh between pages
 * (`sharesRefresh`) is refreshed by one page at a time: while another page is
 * refreshing it, the step waits for that refresh, says how it is going, and
 * takes its end as its own; should that page drop it, the step refreshes it
 * here. A claim lost to a page that claimed it at the same moment is followed
 * in the same way.
 */
async function runRefresh(job: ExportJob, signal: AbortSignal): Promise<void> {
  if (job.descriptor.sourceId === REVIEW_SOURCE_ID) {
    await readReview(job, signal)
    return
  }
  if (!sharesRefresh(job.descriptor.sourceId)) {
    await refreshHere(job, signal, null)
    return
  }
  // Since the job was last written: a refresh that landed while it was paused
  // is still the one it was waiting for.
  const before = followState(await readRefresh(job.cacheKey), PAGE_RUN, job.updatedAt, Date.now())
  if (before.kind === 'landed')
    return endFollowed(job, before)
  for (;;) {
    const lost = new AbortController()
    const acquired = await acquireRefresh(job.cacheKey, { holder: 'options', onCancel: () => void cancelJob(), onLost: leaving => leaving ? stopJob() : lost.abort() })
    if (acquired.kind === 'hold' && await refreshHere(job, signal, acquired.hold, lost.signal))
      return
    signal.throwIfAborted()
    const ended = await followElsewhere(job, signal)
    if (ended.kind !== 'free')
      return endFollowed(job, ended)
    signal.throwIfAborted()
  }
}

/**
 * The review's refresh: its window is computed from the tracked lists' read
 * records, so refreshing it is reading those up to date — what the review does
 * in the background, here at bulk patience, for nobody watching. Like the
 * review, it reads under the read claim, and refuses to while another page
 * holds it. The window's own works change the next time the review is opened.
 */
async function readReview(job: ExportJob, signal: AbortSignal): Promise<void> {
  const claim = await claimReads(PAGE_RUN)
  if (!claim)
    throw new Error(READING_ELSEWHERE)
  const either = new AbortController()
  const stop = (): void => either.abort()
  signal.addEventListener('abort', stop)
  claim.lost.addEventListener('abort', stop)
  if (signal.aborted)
    stop()
  try {
    const option = await options.get('trackedLists')
    message = 'Reading your tracked lists…'
    publish()
    const outcome = await readTrackedLists({
      lists: option.lists,
      start: reviewStart(option),
      currentStart: async () => reviewStart(await options.get('trackedLists')),
      patience: PATIENCE.bulk,
      waitBudget: WAIT_BUDGET.bulk,
      signal: either.signal,
      onProgress: (status) => {
        job.done = status.listsDone
        job.total = status.lists
        message = `Read ${status.listsDone} of ${status.lists} tracked ${status.lists === 1 ? 'list' : 'lists'}`
        publish()
      },
    }).catch((err: unknown) => {
      // Another page took the claim over: that is the reason, not the abort.
      if (claim.lost.aborted && !signal.aborted)
        throw new Error(READING_ELSEWHERE)
      throw err
    })
    if (outcome.blocked)
      job.blocked = 'rate-limited'
    job.done = 0
    job.total = 0
  }
  finally {
    signal.removeEventListener('abort', stop)
    await claim.release()
  }
}

/** Wait for the refresh of the job's list another page is running, mirroring its progress. */
async function followElsewhere(job: ExportJob, signal: AbortSignal): Promise<Exclude<FollowState, { kind: 'following' }>> {
  const mirror = (claim: ListRefresh): void => {
    following = { cacheKey: job.cacheKey, id: claim.id }
    job.done = claim.done
    job.total = claim.total
    waitingUntil = claim.waitUntil || null
    waitReason = claim.waitReason
    message = loadingLine(claim.done, claim.total)
    publish()
  }
  try {
    return await awaitRefresh(job.cacheKey, job.updatedAt, mirror, signal)
  }
  finally {
    following = null
    waitingUntil = null
    waitReason = null
  }
}

/** Take the end of a refresh another page ran as the end of the job's own. */
function endFollowed(job: ExportJob, state: Exclude<FollowState, { kind: 'following' | 'free' }>): void {
  if (state.kind === 'landed') {
    job.queue = []
    job.total = 0
    job.done = 0
    return
  }
  if (state.outcome === 'blocked') {
    job.blocked = 'rate-limited'
    return
  }
  // The reader stopped it where it ran, and this job's refresh was that one.
  if (state.outcome === 'cancelled') {
    cancelling = true
    stopJob()
    return
  }
  throw new Error('The list’s refresh didn’t store it, so it was left as it was. Try again when you like.')
}

/**
 * Refresh the job's list from here, saying how it goes in `hold`'s claim when
 * it holds one. False when the claim was `lost` before the refresh was done.
 */
async function refreshHere(job: ExportJob, signal: AbortSignal, hold: Hold | null, lost?: AbortSignal): Promise<boolean> {
  let outcome: RefreshOutcome = 'dropped'
  const either = new AbortController()
  const stop = (): void => either.abort()
  signal.addEventListener('abort', stop)
  lost?.addEventListener('abort', stop)
  if (signal.aborted || lost?.aborted)
    stop()
  try {
    const result = await fetchList(job, either.signal, hold)
    outcome = result.written ? 'written' : result.notWritten === 'blocked' ? 'blocked' : 'refused'
    await settleRefresh(job, result)
    return true
  }
  catch (err) {
    if (lost?.aborted && !signal.aborted)
      return false
    if (outcome === 'dropped' && !signal.aborted)
      outcome = 'failed'
    throw err
  }
  finally {
    signal.removeEventListener('abort', stop)
    lost?.removeEventListener('abort', stop)
    await hold?.release(outcome === 'dropped' && (cancelling || hold.cancelled) ? 'cancelled' : outcome)
  }
}

async function fetchList(job: ExportJob, signal: AbortSignal, hold: Hold | null): Promise<RefreshResult> {
  message = loadingLine(0, 0)
  publish()

  const limit = await options.get('searchMaxResults')
  return refreshSnapshot({
    cacheKey: job.cacheKey,
    descriptor: job.descriptor,
    limit,
    signal,
    onPersist: sideTableWriter(job.descriptor),
    ...await selectionFor(job.descriptor, job.cacheKey),
    onProgress: (done, total) => {
      job.done = done
      job.total = total
      message = loadingLine(done, total)
      hold?.progress(done, total)
      publish()
    },
  })
}

/** What a refresh from here came to: the job stopped, or told what didn't stop it. */
async function settleRefresh(job: ExportJob, result: RefreshResult): Promise<void> {
  // Nothing was written, so the stored list and any queue planned against it are
  // still good; the step stays in place and Continue picks it up where it left
  // off, exactly as a rate-limited caching run does.
  if (result.notWritten === 'blocked') {
    job.blocked = 'rate-limited'
    await persist(job)
    publish()
    return
  }

  // The other two refusals are not going to resolve themselves by being retried
  // on a timer, so they stop the run and say what to do. The stored list is
  // untouched in both cases.
  if (result.notWritten === 'logged-out')
    throw new Error(REFRESH_REFUSED.loggedOut)
  if (result.notWritten === 'emptied')
    throw new Error(REFRESH_REFUSED.emptied)

  // The list has been replaced, so any queue planned against the old one is void.
  job.queue = []
  job.total = 0
  job.done = 0

  if (result.truncated)
    warn(`Kept the first ${result.works.length} works — this list is longer than your "Maximum results" setting.`)
  if (result.recoveryBlocked)
    warn('AO3 asked us to slow down before every read work outside your history could be fetched. The ones it didn’t reach kept their stored copies and will be tried again.')
  if (result.loadedPages < result.fetchedPages)
    warn(`${result.fetchedPages - result.loadedPages} of ${result.fetchedPages} list pages could not be fetched, so the list may be incomplete.`)

  // Read off the listing itself rather than the AO3 homepage, which Cloudflare
  // serves from cache and can hand a logged-out copy to a signed-in reader. A
  // private list never reaches here signed out — `requireLogin` turned that into
  // the refusal above — so this is a public listing missing its restricted works.
  if (!result.loggedIn) {
    if (job.steps.length > 1) {
      throw new Error(
        'AO3 served the signed-out view. Sign in to AO3 and try again — fetching now would cache sign-in and consent pages instead of works.',
      )
    }
    warn('AO3 served the signed-out view, so restricted works are missing from this list.')
  }
}

/** One queued work's title, and the blurb facts its cached copy is made current against. */
interface QueuedWork {
  freshness: WorkFreshness
  title: string
}

async function runCaching(job: ExportJob, signal: AbortSignal): Promise<void> {
  message = 'Reading the stored list…'
  publish()

  const context = await loadContext(job.cacheKey)
  if (!context)
    throw new Error(`There is no stored list for "${job.descriptor.label}" any more. Refresh the list and try again.`)

  // Planned once, when the step begins with nothing to do yet; a resumed job
  // arrives with a queue half consumed and must not have it rebuilt underneath.
  if (!job.total && !job.queue.length) {
    const index = await readWorkTextIndex()
    const plan = planWorkCache(
      [...context.values()].map(entry => entry.freshness),
      index,
      Date.now(),
      { retryFailures: job.retryNow ? 'now' : true },
    )
    job.queue = plan.queue
    job.total = plan.queue.length
    job.done = 0
    await persist(job)
  }

  let sincePersist = 0

  async function worker(): Promise<void> {
    for (;;) {
      if (signal.aborted || job.blocked)
        return
      const workId = job.queue.shift()
      if (workId === undefined)
        return

      const entry = context!.get(workId)
      if (!entry) {
        // The list moved on between this queue being planned and reaching this work.
        job.done++
        continue
      }

      message = `Fetching “${entry.title}”…`
      publish()

      let result
      try {
        result = await cacheWorkText(entry.freshness, signal)
      }
      catch (err) {
        // A stopped run learned nothing about this work, so it goes back to the
        // front of the queue rather than being counted or blamed.
        if (signal.aborted) {
          job.queue.unshift(workId)
          return
        }
        job.done++
        addError(job, { workId, title: entry.title, reason: describe(err) })
        continue
      }

      // Being asked to slow down says nothing about this work — the fetch layer
      // has already waited as long as is reasonable, so put it back untouched
      // and stop the run rather than marching the rest of the queue into the
      // same wall.
      if (result.rateLimited) {
        job.queue.unshift(workId)
        job.blocked = 'rate-limited'
        // The other workers are inside their own waits and would sit there for
        // minutes before noticing; aborting stops them now, and each puts its
        // work back exactly as this one did.
        controller?.abort()
        await persist(job)
        publish()
        return
      }

      job.done++
      if (result.failure)
        addError(job, { workId, title: entry.title, reason: result.message ?? result.failure })

      if (++sincePersist >= PERSIST_EVERY) {
        sincePersist = 0
        await persist(job)
      }
      publish()
    }
  }

  const workers = Math.min(CONCURRENCY, Math.max(1, job.queue.length))
  await Promise.all(Array.from({ length: workers }, worker))
  await persist(job)
}

/**
 * Write the zip and hand it to the browser — the site payload, from what is
 * already on disk.
 *
 * Nothing here talks to AO3, which is why this step can be run on its own
 * ("Download without refreshing") and why the composite job puts a refresh and a
 * caching pass in front of it by default: an accurate "has this work changed?"
 * needs a fresh list, and a work that was never fetched can only be linked back
 * to AO3.
 *
 * It keeps no queue of its own: `done`/`total` count works *written*, and a
 * caching pass's leftovers are cleared on the way in so the bar starts from
 * zero rather than resuming somebody else's count. A resumed export therefore
 * just writes the zip again, which is cheap and asks AO3 for nothing.
 */
async function runExport(job: ExportJob, signal: AbortSignal): Promise<void> {
  message = 'Building the site…'
  job.queue = []
  job.done = 0
  job.total = 0
  publish()

  const result = await buildSiteExport({
    cacheKey: job.cacheKey,
    descriptor: job.descriptor,
    signal,
    onProgress: (done, total) => {
      job.done = done
      job.total = total
      message = `Writing work ${done.toLocaleString()} of ${total.toLocaleString()}…`
      publish()
    },
  })

  // A reader who pressed Stop mid-build does not want the half a library that
  // got written handed to them as if it were the export they asked for.
  if (signal.aborted)
    return

  const { counts } = result.manifest
  const missing = counts.total - counts.cached
  if (missing > 0) {
    warn(
      `${missing.toLocaleString()} of ${counts.total.toLocaleString()} works have no saved text, so the site links those to AO3 instead of opening them. `
      + 'Run “Cache works” to fetch them.',
    )
  }

  saveAs(result.blob, result.fileName)
}

/**
 * Rebuild what the queue needs from the stored snapshot: each work's title (for
 * the error list) and its staleness facts — which are stored beside the fetched
 * text, so they have to come from the blurb rather than from the work page.
 */
async function loadContext(cacheKey: string): Promise<Map<string, QueuedWork> | null> {
  const snapshot = await readSnapshotData(cacheKey)
  if (!snapshot)
    return null
  const context = new Map<string, QueuedWork>()
  for (const work of snapshot.works) {
    if (!work.workId || context.has(work.workId))
      continue
    context.set(work.workId, { freshness: freshnessFromWork(work), title: work.title })
  }
  return context
}

/**
 * Whatever else a source keeps in step with its snapshot, mirroring
 * `SearchSource.onPersist` on the live path. Only Marked for Later owns one —
 * the saved-work id index, which lags into showing the clock on works already
 * triaged away if a refresh leaves it behind. Recognised from the descriptor's
 * own `listUrl`, since the source's module is content-script-only and importing
 * it here would drag every Unit in with it.
 */
function sideTableWriter(descriptor: SnapshotDescriptor): ((works: Work[]) => Promise<void>) | undefined {
  const userId = /\/users\/([^/?#]+)\/readings/.exec(descriptor.listUrl)?.[1]
  if (descriptor.sourceId !== 'marked-for-later' || !userId)
    return undefined
  return works => saveMarkedForLaterIndex(decodeURIComponent(userId), works.map(work => work.workId))
}

/**
 * Sources whose listing AO3 only shows to the reader's own account: their
 * history, and their Marked for Later shelf. Fetched without a session those
 * URLs are not a shorter list but a sign-in page, which scrapes as no works at
 * all — see {@link RefreshOptions.requireLogin}. Named by `sourceId` for the
 * same reason {@link selectionFor} names the read list that way.
 */
const PRIVATE_SOURCES = new Set(['read-works', 'marked-for-later'])

/**
 * The per-source half of a refresh: whether the listing is private
 * ({@link PRIVATE_SOURCES}), and — for the one list whose works are *chosen
 * from* a listing rather than being it — how to choose them, mirroring
 * `SearchSource.select` on the live path.
 *
 * Only the read list needs choosing: it reads the reader's AO3 history looking
 * for the works they have marked, so refreshing it without this would replace
 * the list with their whole browsing history — and the next export would be of
 * that. With Work marks off there are no marks to choose by, and the refresh
 * would store the list empty, so it is refused before anything is fetched,
 * however the job was started.
 * Recognised from the descriptor's `sourceId`, since the source's module is
 * content-script-only and importing it here would drag every Unit in with it;
 * the question it asks is of the mark table, which is shared
 * ({@link file://../../common/workMarks.ts}).
 */
async function selectionFor(
  descriptor: SnapshotDescriptor,
  cacheKey: string,
): Promise<Pick<RefreshOptions, 'select' | 'satisfied' | 'recover' | 'requireLogin'>> {
  if (descriptor.sourceId !== 'read-works')
    return { requireLogin: PRIVATE_SOURCES.has(descriptor.sourceId) }
  const workMarks = await options.get('workMarks')
  if (!workMarks.enabled)
    throw new Error(REFRESH_REFUSED.marksOff)
  const wanted = readWorkIds(workMarks)
  return {
    requireLogin: true,
    select: works => works.filter(work => wanted.has(work.workId)),
    satisfied: ids => [...wanted].every(id => ids.has(id)),
    // Works in no history come from their own pages, as on the live path. A
    // refresh from here was asked for, so it retries the ones that failed before,
    // and nobody is watching it, so it is as patient as the caching run.
    recover: (works, signal) => recoverReadWorks(cacheKey, wanted, works, { full: true, signal, patience: PATIENCE.bulk }),
  }
}

function addError(job: ExportJob, entry: ExportJobError): void {
  job.errorCount++
  if (job.errors.length < MAX_ERRORS)
    job.errors.push(entry)
}

function warn(text: string): void {
  warnings = [...warnings, text]
  publish()
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
