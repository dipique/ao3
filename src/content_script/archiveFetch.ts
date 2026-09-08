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
 * How long a request will spend waiting out 429s before handing the refusal
 * back, by who is waiting for it.
 *
 * The difference is whether anybody is watching. A reader who pressed a search
 * button is looking at a progress bar, and for them a five-minute silence is
 * worse than being told it didn't work; a caching run has nobody in front of it,
 * and stopping only means the reader has to come back and press Continue —
 * which is the babysitting the waiting exists to avoid.
 */
export const PATIENCE = {
  interactive: 2 * 60_000,
  bulk: 4 * 60 * 60_000,
} as const

/**
 * Epoch ms until which every caller holds off, set by whichever request last saw
 * a 429. Zero when nothing is waiting.
 */
let pausedUntil = 0

/** The current rung of the blind ladder above, in ms. Zero before we climb it. */
let blindWait = 0

/** When we were last refused, so a fresh episode starts the ladder over. */
let lastRefusedAt = 0

type WaitListener = (until: number) => void

const waitListeners = new Set<WaitListener>()

/**
 * Watch for AO3 asking us to wait — `until` is the epoch ms the pause runs to,
 * or 0 when it is over.
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

/** How long the current pause has left, in ms; 0 when nothing is waiting. */
export function archiveWaitRemaining(): number {
  return Math.max(0, pausedUntil - Date.now())
}

function announce(until: number): void {
  for (const listener of waitListeners)
    listener(until)
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

/** Sit out whatever pause is in force, re-reading it in case it is extended. */
async function holdOff(signal?: AbortSignal): Promise<void> {
  if (archiveWaitRemaining() <= 0)
    return
  announce(pausedUntil)
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
      announce(0)
  }
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
  if (archiveWaitRemaining() > 0)
    return
  const now = Date.now()
  // Long enough since the last refusal that this is a new episode, not a
  // continuation of one — start the ladder from the bottom.
  if (now - lastRefusedAt > MAX_WAIT_MS)
    blindWait = 0
  lastRefusedAt = now
  if (asked === null)
    blindWait = Math.min(MAX_WAIT_MS, blindWait + BLIND_WAIT_STEP_MS)
  pausedUntil = now + Math.min(MAX_WAIT_MS, asked ?? blindWait)
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
    await holdOff(signal)
    const res = await fetch(url, { credentials: 'same-origin', signal })
    if (res.status !== 429) {
      // Something got through, so whatever we were being paced for is over.
      blindWait = 0
      return res
    }
    // Measured rather than accumulated, so a wait this request merely joined
    // still counts against it.
    if (Date.now() - startedAt >= patience)
      return res
    pauseFor(retryAfterMs(res))
  }
}
