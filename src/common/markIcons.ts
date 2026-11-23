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
  // Ratings and content warnings, as a reader files a work by what's in it.
  // Most are the extension's own drawings (`src/icons`); see knockOutWhite for
  // the white in them.
  'ao3e/mark-rating-g',
  'ao3e/mark-rating-pg',
  'ao3e/mark-rating-pg13',
  'ao3e/mark-rating-r',
  'ao3e/mark-plus-p',
  'ao3e/mark-minus-p',
  'ao3e/mark-dead-dove',
  'mdi/hand-okay',
  'ao3e/mark-warding-fingers',
  'ao3e/mark-relic-cross',
  'mdi/knife-military',
  'ao3e/mark-cringe',
]

/** What a mark added from the options page wears until it's changed — `read`'s icon. */
export const DEFAULT_MARK_ICON = 'mdi/book-check'

/** What a mark naming an icon nobody has falls back to, rather than drawing nothing. */
export const FALLBACK_MARK_ICON = 'mdi/bookmark-check'

/**
 * The icon names marks used before they were file names; all instances are now converted,
 * so this can safely be removed
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

const WHITE = /\s(?:fill|stroke)="(?:#fff|#ffffff|white)"/i
const WHITE_PART = /<(?:path|circle|ellipse|rect|line|polyline|polygon)\b[^>]*\/>/g

/**
 * An icon drawn as white on its own colour — the rating badges' letters, the
 * cringing face's features — as the same icon with those parts cut out instead.
 *
 * The content script inlines an icon's SVG, so white stays white over the mark's
 * colour. The options page draws icons as CSS masks, which keep only an image's
 * alpha: the white parts would be as opaque as the shape behind them and vanish
 * into it. Cut out, they show the page through, which is the nearest a
 * one-colour mask can come. The UnoCSS config applies this to the extension's
 * own icons; anything with no white part comes back unchanged.
 *
 * Takes the white parts as self-closing elements with a literal white fill or
 * stroke, which is how the icons in `src/icons` are written.
 */
export function knockOutWhite(svg: string): string {
  const parts = svg.match(/^(\s*<svg\b[^>]*>)([\s\S]*)(<\/svg>\s*)$/)
  if (!parts || !WHITE.test(svg))
    return svg
  const [, open, inner, close] = parts as unknown as [string, string, string, string]
  const holes: string[] = []
  const rest = inner.replace(WHITE_PART, (element) => {
    if (!WHITE.test(element))
      return element
    holes.push(element.replace(WHITE, match => match.replace(/"[^"]*"/, '"#000"')))
    return ''
  })
  const [x = '0', y = '0', width = '24', height = '24'] = open.match(/\bviewBox="([^"]+)"/)?.[1]?.trim().split(/[\s,]+/) ?? []
  const id = 'ao3e-knock-out'
  const mask = `<mask id="${id}" maskUnits="userSpaceOnUse" x="${x}" y="${y}" width="${width}" height="${height}">`
    + `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#fff"/>${holes.join('')}</mask>`
  return `${open}${mask}<g mask="url(#${id})">${rest}</g>${close}`
}
