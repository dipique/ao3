import { fetchToken, getArchiveLink } from '#common'

/**
 * The one request that changes a work's Marked for Later state on AO3.
 *
 * Its own module because it has two callers in different worlds: the work
 * toolbars, running on an AO3 page with a token in its head, and the options
 * page replaying what a reader marked inside a site export
 * ({@link file://./siteExport/importChanges.ts}), which has no AO3 page under it
 * at all. Marked for Later is the archive's own list rather than ours, so there
 * should be exactly one place that says what asking it to change looks like —
 * the same reasoning that keeps our own marks behind three writers and no more
 * ({@link file://./workMarks.ts}).
 *
 * Where the reader is looking at the work's own page, pressing AO3's own button
 * still beats this: the archive handles its own redirect, so the button flips
 * and its notice matches reality, where a background POST leaves both stale
 * until the page is reloaded. That choice belongs to the caller with the page in
 * front of it.
 */

/** The page's own CSRF token, present in the head of any AO3 page — but not ours. */
function pageToken(): string | null {
  return document.querySelector('meta[name="csrf-token"]')?.content ?? null
}

/**
 * Toggle a work's Marked for Later state with the same request AO3's own
 * "Mark for Later" / "Mark as Read" buttons make: a PATCH (tunnelled through
 * POST + `_method`) to `/works/:id/mark_for_later` or `/works/:id/mark_as_read`.
 *
 * From an extension page there is no token in the document, so one is fetched
 * from AO3's dispenser — measured to answer extension-origin requests, with the
 * session cookie, in both browsers.
 */
export async function submitMark(workId: string, save: boolean): Promise<void> {
  const action = save ? 'mark_for_later' : 'mark_as_read'
  const token = pageToken() ?? await fetchToken()
  const res = await fetch(getArchiveLink(`/works/${workId}/${action}`), {
    method: 'POST',
    credentials: 'same-origin',
    // The action finishes by redirecting back to the listing. Keep the redirect
    // opaque (we don't want that page) and read it as success.
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ _method: 'patch', authenticity_token: token }).toString(),
  })
  if (res.type !== 'opaqueredirect' && !res.ok)
    throw new Error(`Mark request failed (${res.status})`)
}
