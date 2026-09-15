/**
 * The icons a mark can name, as **icon file names** — `<collection>/<name>`,
 * which is the path `~icons/<collection>/<name>.jsx` resolves and the class
 * `i-<collection>-<name>` generates. One name, both ends.
 *
 * The mark table is data (it lives in options and the reader edits it), but the
 * icons can't be: each context has to have the icon at build time — unplugin-
 * icons inlines the SVG for the content script, UnoCSS generates a rule per
 * class it is told about for the options page — so a mark can only name an icon
 * from {@link MARK_ICON_NAMES}. That list is the palette the options page
 * offers, the safelist the UnoCSS config builds from, and the set the two
 * per-context registries must cover; keeping it here is what stops the three
 * from drifting.
 *
 * Pure — no imports at all — because the UnoCSS config imports it from Node and
 * the content script imports it through `#common`.
 */

/**
 * Every icon a mark may use, in palette order: the ones the shipped marks wear,
 * then a handful of spares for marks the reader invents. Add to the end.
 */
export const MARK_ICON_NAMES: readonly string[] = [
  'mdi/book-check',
  'mdi/bookmark-check',
  'mdi/close-circle',
  'mdi/thumb-down',
  'mdi/sleep',
  'mdi/emoticon-sick',
  'mdi/thumb-up',
  'mdi/chili-hot',
  'mdi/skull',
  'mdi/emoticon-cry',
  'mdi/cloud',
  'mdi/heart',
  'mdi/book-off',
  'mdi/calendar-clock',
  'mdi/clock-check',
  // Spares. Nothing ships wearing these — they're here so a mark the reader
  // adds has something to be that isn't a duplicate of a verdict's icon.
  'mdi/star',
  'mdi/bookmark',
  'mdi/flag',
  'mdi/alert',
  'mdi/eye-off',
  'mdi/repeat',
  'mdi/emoticon-happy',
  'mdi/emoticon-neutral',
  'mdi/fire',
  'mdi/lightbulb',
  // Emotive spares: moods and reactions a reader might file a work under.
  'mdi/plus-thick',
  'mdi/minus-thick',
  'mdi/cat',
  'mdi/paw',
  'mdi/rabbit',
  'mdi/duck',
  'mdi/butterfly',
  'mdi/ghost',
  'mdi/emoticon-devil',
  'mdi/emoticon-dead',
  'mdi/bomb',
  'mdi/lightning-bolt',
  'mdi/heart-broken',
  'mdi/heart-multiple',
  'mdi/emoticon-kiss',
  'mdi/emoticon-lol',
  'mdi/emoticon-angry',
  'mdi/emoticon-confused',
  'mdi/emoticon-poop',
  'mdi/weather-rainy',
  'mdi/creation',
  'mdi/crown',
]

/** What a mark added from the options page wears until it's changed — `read`'s icon. */
export const DEFAULT_MARK_ICON = 'mdi/book-check'

/** What a mark naming an icon nobody has falls back to, rather than drawing nothing. */
export const FALLBACK_MARK_ICON = 'mdi/bookmark-check'

/**
 * The icon names marks used before they were file names: one key per shipped
 * mark, since the field used to be the mark's own id. A stored table is
 * converted on upgrade, but a table can also arrive from somewhere the
 * migrations don't run — a device still on an older build, syncing — so the
 * resolver keeps translating them rather than falling back to a bookmark.
 */
const LEGACY_MARK_ICONS: Record<string, string> = {
  read: 'mdi/book-check',
  no: 'mdi/close-circle',
  bad: 'mdi/thumb-down',
  boring: 'mdi/sleep',
  gross: 'mdi/emoticon-sick',
  good: 'mdi/thumb-up',
  hot: 'mdi/chili-hot',
  dark: 'mdi/skull',
  feelsy: 'mdi/emoticon-cry',
  fluff: 'mdi/cloud',
  favorite: 'mdi/heart',
  abandoned: 'mdi/book-off',
  continue: 'mdi/calendar-clock',
  saved: 'mdi/clock-check',
}

/**
 * The file name a legacy icon key used to mean, or undefined when the value
 * isn't one — including when it is already a file name. What the upgrade path
 * converts stored tables with, since it says "this and only this needs
 * rewriting" and so can't turn a name it doesn't recognise into a bookmark.
 */
export function legacyMarkIcon(icon: string | undefined): string | undefined {
  return icon === undefined ? undefined : LEGACY_MARK_ICONS[icon]
}

/**
 * A mark's stored `icon` as a name the registries can look up: itself when it's
 * one of ours, the file name it used to be spelled as when it's a legacy key,
 * and {@link FALLBACK_MARK_ICON} for anything else (a name from a build that
 * ships more icons than this one, or a hand-edited table).
 */
export function resolveMarkIcon(icon: string | undefined): string {
  if (icon && MARK_ICON_NAMES.includes(icon))
    return icon
  return legacyMarkIcon(icon) || FALLBACK_MARK_ICON
}

/**
 * The UnoCSS class for an icon name. Also what `uno.config.ts` builds its
 * safelist from — no template spells these out, because they're picked by data.
 */
export function markIconClassName(name: string): string {
  return `i-${name.replace('/', '-')}`
}
