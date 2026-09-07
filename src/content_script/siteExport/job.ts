import type { SnapshotDescriptor } from '#common'
import type { Work } from '#content_script/blurb.js'

import { createLogger, options } from '#common'
import { saveMarkedForLaterIndex } from '#content_script/markedForLaterIndex.js'
import { readSnapshot } from '#content_script/searchView/cache.js'
import { refreshSnapshot } from '#content_script/searchView/refresh.js'

import type { WorkFreshness } from './workText.ts'

import { cacheWorkText } from './fetchWorkText.ts'
import { freshnessFromWork, planWorkCache } from './workText.ts'
import { readWorkTextIndex } from './workTextCache.ts'

/**
 * The site export's job runner: one persisted state machine, driven from the
 * options page (the plan's §6, {@link file://../../../../plans/site-export.md}).
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

/**
 * Where the job lives. Outside the `cache.` prefix — a half-finished job is not
 * a cache, and has no business travelling in an export.
 */
const JOB_KEY = 'siteExportJob'

/** Failures kept for the UI's list. {@link ExportJob.errorCount} keeps the true total. */
const MAX_ERRORS = 50

/** Works fetched between writes of the job record — the resolution a crash resumes at. */
const PERSIST_EVERY = 5

/** Simultaneous work fetches. Matches `scrapeListing`'s pool; see the plan's §7 on politeness. */
const CONCURRENCY = 3

/**
 * A step the job can be in the middle of.
 *
 * The plan's §6 names a third, `exporting`; it arrives with the zip writer
 * (milestone 4) rather than sitting here as a case nothing can produce.
 */
export type ExportJobPhase = 'refreshing' | 'caching'

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
}

type Listener = (status: JobStatus) => void

const listeners = new Set<Listener>()

/** The live job object, mutated in place and shallow-copied out on publish. */
let current: ExportJob | null = null
let running = false
let message = ''
let error: string | null = null
let warnings: string[] = []
let controller: AbortController | null = null

let status: JobStatus = { job: null, running: false, message: '', error: null, warnings: [] }

function publish(): void {
  // A fresh outer object each time, so a `shallowRef` on the Vue side sees the
  // change; `queue` and `errors` stay shared, since a run mutates them per work
  // and copying a thousand-id queue that often would be the expensive part.
  status = { job: current ? { ...current } : null, running, message, error, warnings }
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

/** The stored job, if a previous run left one unfinished. */
export async function readJob(): Promise<ExportJob | null> {
  const stored = (await browser.storage.local.get(JOB_KEY))[JOB_KEY] as ExportJob | undefined
  return stored ?? null
}

async function persist(job: ExportJob): Promise<void> {
  job.updatedAt = Date.now()
  await browser.storage.local.set({ [JOB_KEY]: job })
}

async function forget(): Promise<void> {
  await browser.storage.local.remove(JOB_KEY)
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
 * to continue rather than to start again — the plan's "Stop caching clears the
 * running flag, leaves the queue".
 */
export function stopJob(): void {
  controller?.abort()
}

/** Throw the stored job away — the reader has decided they don't want it finished. */
export async function discardJob(): Promise<void> {
  stopJob()
  current = null
  message = ''
  error = null
  warnings = []
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
  publish()

  try {
    while (job.steps.length) {
      if (job.steps[0] === 'refreshing')
        await runRefresh(job, signal)
      else
        await runCaching(job, signal)

      // A stop or a 429 leaves the step in place, so resuming picks it up again.
      if (signal.aborted || job.blocked)
        break
      job.steps.shift()
      await persist(job)
    }
  }
  catch (err) {
    if (!signal.aborted)
      error = describe(err)
    log.error('Site export job stopped', err)
  }
  finally {
    controller = null
    running = false
    message = ''
    if (job.blocked === 'rate-limited' && !error)
      error = 'AO3 asked us to slow down, so the run stopped. Everything fetched so far is saved — try again in a little while.'
    if (!job.steps.length && !job.blocked)
      await forget()
    else
      await persist(job)
    publish()
  }
}

async function runRefresh(job: ExportJob, signal: AbortSignal): Promise<void> {
  message = 'Fetching the list…'
  publish()

  const limit = await options.get('searchMaxResults')
  const result = await refreshSnapshot({
    cacheKey: job.cacheKey,
    descriptor: job.descriptor,
    limit,
    signal,
    onPersist: sideTableWriter(job.descriptor),
    onProgress: (done, total) => {
      job.done = done
      job.total = total
      message = `Loading page ${done} of ${total}…`
      publish()
    },
  })

  // The list has been replaced, so any queue planned against the old one is void.
  job.queue = []
  job.total = 0
  job.done = 0

  if (result.truncated)
    warn(`Kept the first ${result.works.length} works — this list is longer than your "Maximum results" setting.`)
  if (result.loadedPages < result.fetchedPages)
    warn(`${result.fetchedPages - result.loadedPages} of ${result.fetchedPages} list pages could not be fetched, so the list may be incomplete.`)

  // Read off the listing itself rather than the AO3 homepage, which Cloudflare
  // serves from cache and can hand a logged-out copy to a signed-in reader (§7).
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

      job.done++
      if (result.failure)
        addError(job, { workId, title: entry.title, reason: result.message ?? result.failure })
      // Being asked to slow down is not a per-work problem: stop the whole run.
      if (result.rateLimited)
        job.blocked = 'rate-limited'

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
 * Rebuild what the queue needs from the stored snapshot: each work's title (for
 * the error list) and its staleness facts — which are stored beside the fetched
 * text, so they have to come from the blurb rather than from the work page.
 */
async function loadContext(cacheKey: string): Promise<Map<string, QueuedWork> | null> {
  const snapshot = await readSnapshot(cacheKey)
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
