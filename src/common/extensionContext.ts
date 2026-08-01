/**
 * Detecting an orphaned content script.
 *
 * A content script keeps running in the page after its extension is reloaded,
 * updated, or disabled — but its link back to the extension is severed, and from
 * then on every `browser.*` call rejects with "Extension context invalidated".
 * The DOM listeners it installed are still attached, so the page goes on handing
 * it work it can no longer do: each menu open, each mark, each option read
 * becomes an uncaught rejection in the reader's console.
 *
 * This is routine, not exceptional. Reloading the extension during development
 * orphans the content script in every open tab, and in normal use every
 * auto-update does the same to every tab open at the time. So the storage and
 * messaging layers treat it as an expected end state — they stop working quietly
 * rather than throwing — and the content script tears its own UI out of the page
 * the next time it's touched.
 */

/**
 * Whether this script can still reach the extension APIs.
 *
 * `browser.runtime.id` is the cheap synchronous tell: it reads as `undefined`
 * once the context is gone. The property access itself can throw in some
 * browsers, hence the guard.
 */
export function isExtensionContextValid(): boolean {
  try {
    return browser.runtime?.id != null
  }
  catch {
    return false
  }
}

/**
 * Whether a rejection is the context-invalidated one rather than a real failure.
 *
 * Needed because the check above races: the context can die between testing it
 * and the call landing. Matched on the message because neither browser gives
 * this a distinguishable error type.
 */
export function isContextInvalidatedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /context invalidated|extension context|receiving end does not exist/i.test(message)
}
