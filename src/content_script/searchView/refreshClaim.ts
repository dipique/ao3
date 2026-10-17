import type { WaitReason } from '#content_script/archiveFetch.js'

import { archivePause, onArchiveWait } from '#content_script/archiveFetch.js'
import { PAGE_RUN } from '#content_script/pageRun.ts'

import type { FollowState, ListRefresh, RefreshCancel, RefreshHolder, RefreshOutcome } from './listRefresh.ts'

import { cancels, claimRefresh, followState, holds, lapseIn, outranks, REFRESH_CLAIM_RENEW_MS, refreshStep, released, renewed, withPause, withProgress } from './listRefresh.ts'

/**
 * The storage half of a shared refresh ({@link file://./listRefresh.ts}): taking
 * the claim, keeping it, following someone else's, and asking for one to stop.
 *
 * Each list's claim and its cancel request are keys of their own, so the holder
 * is the only writer of the one and never writes the other: no write here reads
 * a record another page writes and puts it back, so none can lose another's.
 *
 * **Import discipline.** Reached from the options page, through the site
 * export's job, so this imports nothing that would pull the search view's host
 * in with it.
 */

/** The storage key of a list's claim. */
export const refreshClaimKey = (cacheKey: string): string => `listRefresh.${cacheKey}`
const cancelKey = (cacheKey: string): string => `listRefreshCancel.${cacheKey}`

/** The claim stored for `cacheKey`, or null. */
export async function readRefresh(cacheKey: string): Promise<ListRefresh | null> {
  const key = refreshClaimKey(cacheKey)
  return ((await browser.storage.local.get(key))[key] as ListRefresh | undefined) ?? null
}

export interface HoldOptions {
  holder: RefreshHolder
  /** Another page asked for this refresh to stop. */
  onCancel: () => void
  /**
   * This page no longer holds the claim: another page claimed the list later
   * ({@link outranks}), or this page is `leaving`. The refresh should stop
   * without saying how it ended, since the claim isn't this page's to end; a
   * page that is leaving should start nothing more.
   */
  onLost: (leaving: boolean) => void
  /** The claim as this page last wrote it, after each write while it runs. */
  onChange?: (claim: ListRefresh) => void
}

/** A refresh this page run holds, until it is released. */
export interface Hold {
  /** The claim as last written. */
  readonly claim: ListRefresh
  /** Whether a stop was asked for, here ({@link cancel}) or from another page. */
  readonly cancelled: boolean
  /** Say how far the refresh has got: `done` of `total` listing pages. */
  progress: (done: number, total: number) => void
  /** Stop it from this page: as a cancel request from another would. */
  cancel: () => void
  /**
   * Say how it ended, and stop keeping the claim. A second release does
   * nothing, and nor does one after the claim was lost, or once another page
   * has claimed the list since.
   */
  release: (outcome: RefreshOutcome) => Promise<void>
}

export type Acquired = { kind: 'hold', hold: Hold } | { kind: 'follow' }

/**
 * The page is going away: from here it claims nothing, since a claim it wrote
 * now would outlive it, and a page coming back to the list would wait on a
 * refresh nobody is running. Back again from the back/forward cache, it may.
 */
let unloading = false
addEventListener('pagehide', () => {
  unloading = true
})
addEventListener('pageshow', () => {
  unloading = false
})

/**
 * Claim the refresh of `cacheKey` for this page run, or learn that another page
 * run has it. The claim is written and read back, so of two pages that claim at
 * once, one that reads the other's write follows it; two that each read their
 * own both hold, until the one that claimed first hears the other's write and
 * loses its claim ({@link outranks}, {@link HoldOptions.onLost}). A claim that
 * can't be written at all is no reason not to refresh: this page holds a claim
 * nobody else can see.
 */
export async function acquireRefresh(cacheKey: string, opts: HoldOptions): Promise<Acquired> {
  if (unloading)
    return { kind: 'follow' }
  try {
    if (refreshStep(await readRefresh(cacheKey), PAGE_RUN, Date.now()) === 'follow')
      return { kind: 'follow' }
    const claim = claimRefresh(PAGE_RUN, opts.holder, Date.now())
    await browser.storage.local.set({ [refreshClaimKey(cacheKey)]: claim })
    if (!holds(await readRefresh(cacheKey), claim))
      return { kind: 'follow' }
    return { kind: 'hold', hold: keep(cacheKey, claim, opts) }
  }
  catch (err) {
    console.error('[refresh] could not claim the refresh of', cacheKey, err)
    return { kind: 'hold', hold: keep(cacheKey, claimRefresh(PAGE_RUN, opts.holder, Date.now()), opts, false) }
  }
}

function keep(cacheKey: string, first: ListRefresh, opts: HoldOptions, stored = true): Hold {
  let claim = first
  let cancelled = false
  let over = false

  const store = (next: ListRefresh): Promise<void> => {
    claim = next
    if (!stored)
      return Promise.resolve()
    return browser.storage.local.set({ [refreshClaimKey(cacheKey)]: next })
      .catch(err => console.error('[refresh] could not write the refresh of', cacheKey, err))
  }
  const write = (next: ListRefresh): void => {
    if (over)
      return
    void store(next)
    opts.onChange?.(next)
  }

  const cancel = (): void => {
    if (over || cancelled)
      return
    cancelled = true
    opts.onCancel()
  }

  const renew = setInterval(() => write(renewed(claim, Date.now())), REFRESH_CLAIM_RENEW_MS)
  const paused = (until: number, reason: WaitReason): void => write(withPause(claim, until, reason, Date.now()))
  const unwatch = onArchiveWait(paused)
  const pause = archivePause()
  if (pause)
    paused(pause.until, pause.reason)

  const heard = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
    if (area !== 'local')
      return
    if (cancels((changes[cancelKey(cacheKey)]?.newValue as RefreshCancel | undefined) ?? null, claim))
      cancel()
    const other = changes[refreshClaimKey(cacheKey)]?.newValue as ListRefresh | undefined
    if (other && outranks(other, claim))
      lose()
  }
  browser.storage.onChanged.addListener(heard)

  // A page going away can't finish its refresh; saying so now lets a page
  // following it take it over rather than wait out the claim. Written at once,
  // with no read first, since the page may not get to run anything after.
  const leaving = (): void => {
    if (over)
      return
    void store(released(claim, cancelled ? 'cancelled' : 'dropped', Date.now()))
    lose(true)
  }
  addEventListener('pagehide', leaving)

  function stop(): void {
    over = true
    clearInterval(renew)
    unwatch()
    browser.storage.onChanged.removeListener(heard)
    removeEventListener('pagehide', leaving)
  }

  function lose(leaving = false): void {
    if (over)
      return
    stop()
    opts.onLost(leaving)
  }

  async function release(outcome: RefreshOutcome): Promise<void> {
    if (over)
      return
    stop()
    if (stored && (await readRefresh(cacheKey).catch(() => null))?.id !== claim.id)
      return
    await store(released(claim, outcome, Date.now()))
  }

  return {
    get claim() {
      return claim
    },
    get cancelled() {
      return cancelled
    },
    progress: (done, total) => write(withProgress(claim, done, total, Date.now())),
    cancel,
    release,
  }
}

/**
 * Watch the claim on `cacheKey`: `onClaim` hears it as it is stored now, on
 * every write to it, when a running one would lapse unrenewed, and every second
 * while one sits out a pause (so a countdown can be drawn), until `signal`
 * aborts. What it means to the caller is {@link followState}'s to say.
 */
export function watchRefresh(cacheKey: string, onClaim: (stored: ListRefresh | null) => void, signal: AbortSignal): void {
  if (signal.aborted)
    return
  let timer: ReturnType<typeof setTimeout> | undefined

  const look = (stored: ListRefresh | null): void => {
    clearTimeout(timer)
    if (signal.aborted)
      return
    onClaim(stored)
    if (!stored || signal.aborted)
      return
    const now = Date.now()
    const lapse = lapseIn(stored, now)
    if (!lapse)
      return
    const tick = stored.waitUntil > now ? Math.min(1000, stored.waitUntil - now) : Infinity
    // Past the lapse, so the claim reads as lapsed when it is looked at again.
    timer = setTimeout(look, Math.min(tick, lapse + 1), stored)
  }

  const heard = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
    const change = changes[refreshClaimKey(cacheKey)]
    if (area === 'local' && change)
      look((change.newValue as ListRefresh | undefined) ?? null)
  }

  browser.storage.onChanged.addListener(heard)
  signal.addEventListener('abort', () => {
    clearTimeout(timer)
    browser.storage.onChanged.removeListener(heard)
  }, { once: true })
  readRefresh(cacheKey)
    .then(look)
    .catch((err) => {
      console.error('[refresh] could not read the refresh of', cacheKey, err)
      look(null)
    })
}

/** Ask whoever holds claim `id` on `cacheKey` to stop. */
export async function requestCancel(cacheKey: string, id: string): Promise<void> {
  const cancel: RefreshCancel = { id, at: Date.now() }
  await browser.storage.local.set({ [cancelKey(cacheKey)]: cancel })
}

/**
 * Wait for the refresh of `cacheKey` another page run holds to end, for a page
 * run that began waiting on it at `since`, hearing its claim as it goes. Resolves
 * with how it ended: `free` when nobody holds it any more without having ended
 * it, so the caller should refresh it itself. Rejects when `signal` aborts.
 */
export function awaitRefresh(cacheKey: string, since: number, onClaim: (claim: ListRefresh) => void, signal: AbortSignal): Promise<Exclude<FollowState, { kind: 'following' }>> {
  return new Promise((resolve, reject) => {
    const watching = new AbortController()
    const aborted = (): void => {
      watching.abort()
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    if (signal.aborted) {
      aborted()
      return
    }
    signal.addEventListener('abort', aborted, { once: true })
    watchRefresh(cacheKey, (stored) => {
      const state = followState(stored, PAGE_RUN, since, Date.now())
      if (state.kind === 'following') {
        onClaim(state.claim)
        return
      }
      signal.removeEventListener('abort', aborted)
      watching.abort()
      resolve(state)
    }, watching.signal)
  })
}
