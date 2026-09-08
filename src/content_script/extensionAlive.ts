import { isExtensionContextValid, toast } from '#common'

/**
 * Telling the reader when this page's copy of the extension has stopped being
 * one.
 *
 * A content script is orphaned when the extension is reloaded, updated or
 * disabled under an open tab (see {@link file://./../common/extensionContext.ts}).
 * Everything it drew is still on the page and still clickable, but from that
 * moment storage reads answer from defaults and writes are dropped — so an
 * action taken from that UI does nothing whatsoever, and does it quietly. The
 * menu closes, the editor saves, the toast says "Replacement added", and the
 * setting simply isn't there.
 *
 * `#common` fails soft on purpose, because most of what it does is not the
 * reader's doing — a decorating pass that can't read settings should stop, not
 * shout. This is the other half of that bargain: the places where somebody
 * pressed something and is waiting for the result, and is owed an explanation
 * instead of silence.
 *
 * The check is cheap and synchronous, so it goes at the top of the handler,
 * before any of the work. It can't be airtight — the context can die between
 * the check and the write it guards — but that window is milliseconds against a
 * state that lasts as long as the tab does.
 */

/** What the reader is told, wherever it ends up being shown. */
export const EXTENSION_RELOADED
  = 'AO3 Enhancements was reloaded or updated, so this page can no longer save anything. Reload the page and try again.'

/**
 * How long to go before saying it again. Matched to the toast's own life, so
 * someone clicking around a dead page is answered every time rather than once,
 * without ever stacking two copies of the same notice.
 */
const REPEAT_AFTER = 5000

let lastToldAt = 0

/**
 * Whether the extension can still be reached — and if it can't, say so.
 *
 * Guard anything the reader starts with `if (!extensionAlive()) return`. Where
 * the surface has a better place for the message than a toast (a form's own
 * error row), test {@link isExtensionContextValid} and show
 * {@link EXTENSION_RELOADED} there instead.
 */
export function extensionAlive(): boolean {
  if (isExtensionContextValid())
    return true

  const now = Date.now()
  if (now - lastToldAt >= REPEAT_AFTER) {
    lastToldAt = now
    toast(EXTENSION_RELOADED, { type: 'error' })
  }
  return false
}
