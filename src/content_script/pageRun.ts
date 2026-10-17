/**
 * This page run's own token: whose claim on shared work a claim is (the tracked
 * review's window, a stored list's refresh). Made once per page load, so it
 * outlives a global re-run and not the page. Not `randomUUID`, which a page
 * served over plain http doesn't have — and the content script runs on every
 * archive page.
 */
export const PAGE_RUN = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(36)).join('')
