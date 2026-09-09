/**
 * The options page's half of the mark icon registry: an icon file name as the
 * UnoCSS class that draws it.
 *
 * The names themselves, and which ones exist, live in `#common`'s `markIcons`
 * module — shared with the content script's registry and with the UnoCSS
 * config, which safelists exactly these classes (no template writes one out,
 * since the mark table picks them by data).
 */

import { markIconClassName, resolveMarkIcon } from '#common'

/** The icon class for a mark's `icon` field, falling back to a generic bookmark. */
export function markIconClass(icon: string | undefined): string {
  return markIconClassName(resolveMarkIcon(icon))
}
