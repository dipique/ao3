/**
 * How this extension asks AO3 for a page when it's asking for a great many of
 * them: one request, retried on 429 with `Retry-After` honoured, and nothing
 * else. Every bulk path goes through here — the listing scrape
 * ({@link file://./searchView/scrape.ts}) and the work-text cache
 * ({@link file://./siteExport/fetchWorkText.ts}) — so there is exactly one place
 * that decides how patient we are with an archive running on donated hardware.
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

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Longest we'll wait between attempts when AO3 gives us no `Retry-After`. */
const MAX_BACKOFF_MS = 30_000

/**
 * Fetch a URL, retrying only on 429. `retries` is the number of *extra*
 * attempts; the final 429 is returned like any other response rather than
 * thrown, so a caller can tell "AO3 is asking us to stop" from "that work is
 * gone" and act accordingly.
 */
export async function fetchWithRetry(url: string, signal?: AbortSignal, retries = 3): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { credentials: 'same-origin', signal })
    if (res.status !== 429 || attempt >= retries)
      return res
    const retryAfter = Number(res.headers.get('Retry-After'))
    await sleep(
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt),
    )
  }
}
