/**
 * Icons a mark can name in its `icon` field, as UnoCSS icon classes.
 *
 * The mark table is data (it lives in options and can be edited), but the icons
 * can't be: UnoCSS generates a rule per class it finds, so only what's listed
 * here — and safelisted in `uno.config.ts`, since these are built from a
 * variable rather than written in a template — exists in the stylesheet. The
 * content script keeps its own copy of this map (see
 * `content_script/markIcons.tsx`), where the constraint is the same and the
 * mechanism is unplugin-icons inlining each SVG at build time.
 */
export const MARK_ICON_CLASSES: Record<string, string> = {
  read: 'i-mdi-book-check',
  favorite: 'i-mdi-heart',
  good: 'i-mdi-thumb-up',
  boring: 'i-mdi-sleep',
  bad: 'i-mdi-thumb-down',
  gross: 'i-mdi-emoticon-sick',
  saved: 'i-mdi-clock-check',
}

/** The icon class for a mark's `icon` key, falling back to a generic bookmark. */
export function markIconClass(icon: string | undefined): string {
  return (icon && MARK_ICON_CLASSES[icon]) || 'i-mdi-bookmark-check'
}
