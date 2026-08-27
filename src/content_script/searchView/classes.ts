import { ADDON_CLASS } from '#common'

/**
 * The class names that identify the search view's host container and the native
 * listing it stands in front of.
 *
 * They live in their own leaf module because things outside the search view need
 * to recognise them — the floating filter toolbar has to leave the listing it
 * covers out of its "N filtered works" count — and importing `host.tsx` for a
 * string would put a cycle between the two.
 */

/** The container the view is mounted into, in place of the native listing. */
export const HOST = `${ADDON_CLASS}--search-host`

export const cx = (suffix: string): string => `${HOST}--${suffix}`

/**
 * Put on the native listing (and its chrome) while the view stands in for it.
 * Everything under it is still in the page, just not what the reader is looking
 * at.
 */
export const NATIVE_HIDDEN_CLASS = cx('native-hidden')

/** The view itself (its own class prefix, distinct from the host's). */
export const VIEW_ROOT = `${ADDON_CLASS}--search-view`

/**
 * A work the view is holding but not showing: filtered out, or on one of the
 * pages the reader isn't on. Still in the results list, so anything counting
 * what's actually in front of the reader has to skip it.
 */
export const VIEW_HIDDEN_CLASS = `${VIEW_ROOT}--hidden`
