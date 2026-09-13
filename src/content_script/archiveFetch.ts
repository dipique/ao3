/**
 * How this extension asks AO3 for a page when it's asking for a great many of
 * them: one request, retried on 429 with `Retry-After` honoured, and nothing
 * else. Every bulk path goes through here — the listing scrape
 * ({@link file://./searchView/scrape.ts}) and the work-text cache
 * ({@link file://./siteExport/fetchWorkText.ts}) — so there is exactly one place
 * that decides how patient we are with an archive running on donated hardware.
 *
 * Being asked to wait is not an error, and it is not about the page. A 429 is
 * the archive pacing us: the same request a minute later succeeds, and any other
 * request made at that moment would have been refused just the same. So this
 * waits the time it was told to wait and tries again, rather than handing the
 * caller a failure to record against whatever it happened to be fetching. Only
 * once the caller's {@link PATIENCE} is spent does the 429 come back as a
 * response.
 *
 * The wait is shared, not per-request: the pool that makes a bulk fetch
 * quick is also what walks it into a rate limit, and three workers each backing
 * off privately would take turns hitting the same wall — each one's retry
 * arriving while the archive is still refusing. One pause held in this module
 * stops all of them together, which is both politer and faster.
 *
 * The same pause is what paces us when nothing has gone wrong at all: every
 * {@link PACE_EVERY} requests the pool takes a {@link PACE_PAUSE_MS} breather
 * ({@link paceOne}). A rate limit is the archive telling us we were already
 * going too fast; a steady breather is the cheaper way to not find out.
 *
 * The response comes back whatever its status. Only the caller can say what a
 * 404 or a redirect to the login page *means*, and the work-text cache's whole
 * failure vocabulary depends on being able to tell those apart.
 *
 * Callers outside an AO3 tab (the options page, driving the site export) get the
 * reader's session anyway: both browsers treat a request to a host in
 * `host_permissions` as privileged rather than cross-site, so the `SameSite=Lax`
 * cookie rides along even from an extension origin (measured).
 */

/**
 * What we wait when AO3 refuses without saying for how long — and how much
 * longer each time we come back and are refused again.
 *
 * AO3 has a second kind of 429 that carries no `Retry-After` at all. There is
 * nothing to read, so the only safe reading is that we are unwelcome for a
 * while: start at five minutes rather than the second or two a normal backoff
 * would try, and add another five every time a retry meets the same wall.
 */
const BLIND_WAIT_STEP_MS = 5 * 60_000

/** Ceiling on any single wait, asked for or worked out. */
const MAX_WAIT_MS = 60 * 60_000

/**
 * Requests we will make back-to-back before pausing for {@link PACE_PAUSE_MS}.
 * Twenty is one AO3 listing page's worth of works, so a set is roughly what a
 * reader going through the same list by hand would have loaded.
 */
const PACE_EVERY = 20

/** The breather taken between sets. Short: it is courtesy, not a punishment. */
const PACE_PAUSE_MS = 5_000

/**
 * A gap long enough that whatever burst the counter was measuring is over, so
 * the next request starts a fresh set rather than inheriting a stale count. A
 * job already going slower than the pacing is not one the pacing need slow.
 */
const PACE_IDLE_RESET_MS = 60_000

/**
 * How long a request will spend waiting out 429s before handing the refusal
 * back, by who is waiting for it.
 *
 * The difference is whether anybody is watching. A reader who pressed a search
 * button is looking at a progress bar, and for them a five-minute silence is
 * worse than being told it didn't work; a caching run has nobody in front of it,
 * and stopping only means the reader has to come back and press Continue —
 * which is the babysitting the waiting exists to avoid.
 *
 * It is a ceiling on the wait, not a stopwatch that has to run out: a request
 * gives up rather than *start* a pause that would take it past this. Checking
 * afterwards instead would have let an interactive fetch sit through the whole
 * of a five-minute blind refusal before noticing it only had two minutes to
 * spend — which is precisely the silence the short budget is there to prevent,
 * and the caller cannot regroup until the refusal is back in its hands.
 */
export const PATIENCE = {
  interactive: 2 * 60_000,
  bulk: 4 * 60 * 60_000,
} as const

/**
 * How long a *job* made of many requests will spend waiting out refusals in
 * total before it stops and reports what it managed, by who is waiting for it.
 *
 * Where {@link PATIENCE} bounds one request, this bounds the run, and the two do
 * different work. A short patience is what lets a single page give up quickly so
 * the job can regroup — put the page back, sit out the archive's pause once for
 * everybody, then ask again for only what is still missing — while this is what
 * stops that regrouping going on all afternoon. A job a reader is watching must
 * still end.
 */
export const WAIT_BUDGET = {
  interactive: 20 * 60_000,
  bulk: 4 * 60 * 60_000,
} as const

/**
 * Epoch ms until which every caller holds off because the archive refused one of
 * them. Zero when no refusal is being sat out.
 */
let refusedUntil = 0

/**
 * Epoch ms until which every caller holds off for the routine breather between
 * sets ({@link paceOne}). Kept apart from {@link refusedUntil} because the two
 * mean opposite things — one is the archive complaining, the other is us making
 * sure it has no reason to — and a reader watching a job go quiet deserves to be
 * told which.
 */
let pacedUntil = 0

/** Requests made since the last breather, and when the last one went out. */
let sinceBreather = 0
let lastRequestAt = 0

/** The current rung of the blind ladder above, in ms. Zero before we climb it. */
let blindWait = 0

/** When we were last refused, so a fresh episode starts the ladder over. */
let lastRefusedAt = 0

/** Why everything has stopped: the archive refused us, or we are pacing ourselves. */
export type WaitReason = 'refused' | 'pacing'

type WaitListener = (until: number, reason: WaitReason) => void

const waitListeners = new Set<WaitListener>()

/**
 * Watch for fetching to pause — `until` is the epoch ms it runs to, or 0 when it
 * is over, and `reason` says which kind of pause it was.
 *
 * A long job that has gone quiet for two minutes should be able to say why,
 * rather than looking like it has hung.
 */
export function onArchiveWait(listener: WaitListener): () => void {
  waitListeners.add(listener)
  return () => {
    waitListeners.delete(listener)
  }
}

/** Epoch ms every caller is holding off until, whichever pause is the longer. */
function pausedUntil(): number {
  return Math.max(refusedUntil, pacedUntil)
}

/** How long the current pause has left, in ms; 0 when nothing is waiting. */
export function archiveWaitRemaining(): number {
  return Math.max(0, pausedUntil() - Date.now())
}

/**
 * What the current pause is. A refusal outranks a breather: when both are being
 * sat out, the one worth saying out loud is the archive's.
 */
function waitReason(): WaitReason {
  return refusedUntil > Date.now() ? 'refused' : 'pacing'
}

function announce(until: number, reason: WaitReason): void {
  for (const listener of waitListeners)
    listener(until, reason)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Sit out whatever pause is in force, re-reading it in case it is extended.
 *
 * Exported because a job that means to come back after a refusal has to know
 * when it may — asking again the moment a page gave up would walk the whole
 * queue into the same wall, which is the thing the shared pause exists to stop.
 */
export async function waitForArchive(signal?: AbortSignal): Promise<void> {
  if (archiveWaitRemaining() <= 0)
    return
  announce(pausedUntil(), waitReason())
  try {
    let remaining = archiveWaitRemaining()
    while (remaining > 0) {
      await sleep(remaining, signal)
      remaining = archiveWaitRemaining()
    }
  }
  finally {
    // Whoever leaves last says the wait is over; the others find it already 0.
    if (archiveWaitRemaining() <= 0)
      announce(0, waitReason())
  }
}

/**
 * Count one request against the pacing budget, opening a breather when a set is
 * done. Synchronous on purpose: the counter has to move before the caller can
 * `await` anything, or three workers would all read the nineteenth request and
 * none of them would be the twentieth.
 *
 * The request being counted still goes out — it is the last of its set, not the
 * first of the next — so the pause it opens is sat out by whoever asks next.
 */
function paceOne(): void {
  const now = Date.now()
  if (now - lastRequestAt > PACE_IDLE_RESET_MS)
    sinceBreather = 0
  lastRequestAt = now
  if (++sinceBreather < PACE_EVERY)
    return
  sinceBreather = 0
  pacedUntil = Math.max(pacedUntil, now + PACE_PAUSE_MS)
}

/**
 * Open a pause for a refusal, unless one is already running.
 *
 * The guard is what keeps the ladder honest. Three workers refused at once have
 * met *one* refusal, not three, and stepping the wait up per worker would take
 * a five-minute pause to a quarter of an hour for no reason. So a 429 that
 * arrives while a pause is in force joins it, and only a refusal that survives
 * one — we waited, came back, and were turned away again — climbs.
 */
function pauseFor(asked: number | null): void {
  // A *refusal* already in force, not any pause at all: a 429 that arrives
  // during a routine breather is still news, and swallowing it would leave the
  // archive's own answer unrecorded.
  if (refusedUntil > Date.now())
    return
  const now = Date.now()
  // Long enough since the last refusal that this is a new episode, not a
  // continuation of one — start the ladder from the bottom.
  if (now - lastRefusedAt > MAX_WAIT_MS)
    blindWait = 0
  lastRefusedAt = now
  if (asked === null)
    blindWait = Math.min(MAX_WAIT_MS, blindWait + BLIND_WAIT_STEP_MS)
  refusedUntil = now + Math.min(MAX_WAIT_MS, asked ?? blindWait)
}

/** `Retry-After` in ms — it may be a count of seconds or an HTTP date. */
function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('Retry-After')
  if (!header)
    return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds > 0)
    return seconds * 1000
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

/**
 * Fetch a URL, waiting out 429s rather than failing on them.
 *
 * The final 429 — the one that arrives once `patience` is spent — is returned
 * like any other response rather than thrown, so a caller can tell "AO3 is still
 * asking us to stop" from "that work is gone" and act accordingly.
 */
export async function fetchWithRetry(
  url: string,
  signal?: AbortSignal,
  patience: number = PATIENCE.interactive,
): Promise<Response> {
  const startedAt = Date.now()
  for (;;) {
    await waitForArchive(signal)
    paceOne()
    const res = await fetch(url, { credentials: 'same-origin', signal })
    if (res.status !== 429) {
      // Something got through, so whatever we were being paced for is over.
      blindWait = 0
      return res
    }
    // Recorded before we decide whether to carry on, because the refusal is the
    // archive's and not this URL's. Giving up without writing it down is how a
    // queue of pages used to fail one at a time, each rediscovering the same
    // wall from scratch; with it written down, everything else holds off, and a
    // job that means to come back knows exactly how long to wait.
    pauseFor(retryAfterMs(res))
    // Would sitting this one out spend the budget? Measured from the start
    // rather than accumulated, so a wait this request merely joined still
    // counts against it.
    if (Date.now() + archiveWaitRemaining() - startedAt >= patience)
      return res
  }
}
