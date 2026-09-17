import { api, fetchToken, getArchiveLink } from '#common'

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
 *
 * And there is a third world, for when the second one stops working:
 * {@link submitMarkViaTab} asks a tab that is already on AO3 to make the request
 * on the options page's behalf, and {@link serveMarkRequests} is the other end
 * of that, in the first world. Both halves of the delegation are here rather
 * than at either end of it, because between them they are one protocol and it is
 * this module's protocol. Nothing calls it while the direct request is accepted
 * — see the note on it.
 */

/** The page's own CSRF token, present in the head of any AO3 page — but not ours. */
function pageToken(): string | null {
  return document.querySelector('meta[name="csrf-token"]')?.content ?? null
}

/**
 * Stands for "AO3 answered, but it answered the signed-out way".
 *
 * Not a status AO3 sends: a signed-out mark request is a 302 to the sign-in
 * page, which renders a 200. This is the one refusal that is about *us* rather
 * than about the request, so it is the one refusal a second origin cannot get
 * past — every AO3 tab in this browser shares the session that is missing.
 */
export const NOT_SIGNED_IN = 401

/**
 * A request the archive answered, and refused.
 *
 * The status is kept rather than only formatted into the message because one
 * caller has to act on it: an ingest deciding whether the refusal is the kind
 * another origin could get past ({@link file://./siteExport/importChanges.ts}).
 */
export class MarkRequestError extends Error {
  /** What AO3 answered with, or {@link NOT_SIGNED_IN}. */
  readonly status: number

  constructor(status: number) {
    super(status === NOT_SIGNED_IN
      ? 'AO3 answered as though you are signed out — sign in to AO3 and try again'
      : `Mark request failed (${status})`)
    this.name = 'MarkRequestError'
    this.status = status
  }
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
    // The action finishes by redirecting, and where it redirects *to* is the only
    // thing separating "saved" from "you are signed out": both are a 302, and
    // under `redirect: 'manual'` both arrive as an indistinguishable
    // `opaqueredirect` whose headers can't be read either. So the redirect is
    // followed and the URL it settles on is read — which is what the archive's
    // own button does, one request further on than we used to go.
    redirect: 'follow',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ _method: 'patch', authenticity_token: token }).toString(),
  })
  // `fetch` settles on the headers, so the page the redirect landed on has not
  // been downloaded yet and never needs to be. Dropping it keeps this to roughly
  // what it cost before: the answer is in the URL, not in the HTML.
  void res.body?.cancel().catch(() => {})
  if (!res.ok)
    throw new MarkRequestError(res.status)
  if (isLoginUrl(res.url))
    throw new MarkRequestError(NOT_SIGNED_IN)
}

/**
 * Whether a response settled on AO3's sign-in page.
 *
 * A signed-out request for one of these actions is answered with a 302 to
 * `/users/login`, which then renders a perfectly successful 200. Taken at face
 * value that reads as "saved": the toast says so, the saved-work index is
 * rewritten around a work that was never saved, and a change file imported out
 * of a site export ledgers the op as applied — so the work stays on Marked for
 * Later for good, because nothing will ever try it again.
 *
 * {@link file://./siteExport/fetchWorkText.ts} makes the same check on its GETs.
 */
function isLoginUrl(url: string): boolean {
  try {
    return new URL(url, getArchiveLink('/')).pathname.startsWith('/users/login')
  }
  catch {
    return false
  }
}

/** Where the content script runs, which is the same thing as where this can be delegated. */
const ARCHIVE_TABS = '*://*.archiveofourown.org/*'

/** Said when there is no AO3 page to borrow, and when none of them would answer. */
const NO_TAB = 'the request has to come from an AO3 page — open AO3 in a tab and import this file again'
const NO_ANSWER = 'your AO3 tabs did not answer — reload one and import this file again'

/**
 * Make the same request from a tab that is already on AO3.
 *
 * The fallback for the one thing an extension page cannot do for itself if the
 * archive ever stops letting it: a POST from here carries no `Origin` and no
 * `Referer`, and while that was measured to be accepted, it is accepted at AO3's
 * discretion rather than by any rule. A content script has neither problem: it
 * runs on the archive's own origin, with the archive's own token in the document
 * over it. So where the direct request is turned down, one of the reader's open
 * AO3 tabs can be asked instead.
 *
 * Tabs are tried in the order the browser lists them, and the first one that
 * answers settles it either way: a tab that reached AO3 and was refused there is
 * telling us something about the request rather than about the tab, and asking
 * the next tab would only spend another one on the same answer. A tab that says
 * nothing at all is a different matter — it has no content script under it (a
 * page loaded before the extension, or one orphaned by a reload) — so the next
 * one gets a turn.
 *
 * Discarded tabs are left out at the query: they have no script running, and
 * messaging one would wake a page the reader put down.
 */
export async function submitMarkViaTab(workId: string, save: boolean): Promise<void> {
  const tabs = await browser.tabs.query({ url: ARCHIVE_TABS, discarded: false })
  const ids: number[] = []
  for (const tab of tabs) {
    if (tab.id !== undefined)
      ids.push(tab.id)
  }
  if (!ids.length)
    throw new Error(NO_TAB)

  for (const id of ids) {
    let answer
    try {
      answer = await api.submitMark.sendToTab(id, workId, save)
    }
    catch {
      // Nothing on the other end of that tab. Try the next.
      continue
    }
    if (!answer)
      continue
    if (answer.ok)
      return
    throw new Error(answer.error)
  }

  throw new Error(NO_ANSWER)
}

/**
 * Answer delegated requests, from a page that is on AO3 and can make them.
 *
 * Installed by the content script on every archive page, and reached only from
 * {@link submitMarkViaTab}. The answer goes back as a value rather than as a
 * rejection because that is all that survives a trip between contexts, and the
 * far end has to tell a refusal apart from a tab that was never listening.
 */
export function serveMarkRequests(): void {
  api.submitMark.addListener(async (workId, save) => {
    try {
      await submitMark(workId, save)
      return { ok: true }
    }
    catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
