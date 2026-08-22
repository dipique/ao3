import type { ThemeOption } from '#common'

import { isDarkTheme } from './utils.tsx'

/**
 * Which palette the extension's own floating surfaces (menu, popover, toast)
 * paint themselves in.
 *
 * These sit *on top of* AO3 rather than inside it: they're appended to
 * `document.body` and styled entirely by us, so unlike the rest of what we add
 * they inherit nothing useful from the reader's skin. Left alone they'd be a
 * white card on a black page.
 *
 * The signal is the skin, not the OS. AO3's skins are chosen per account and
 * say nothing about `prefers-color-scheme` — someone reading a dark skin on a
 * light desktop (or the reverse) is entirely ordinary, and a media query would
 * be wrong for both of them. {@link isDarkTheme} samples the page's actual
 * background instead, which is the only thing that answers "what is this reader
 * looking at".
 *
 * The reader can still override it: `theme.chosen` is the same setting the
 * options page obeys, so picking dark or light there covers our surfaces too.
 */
export type SurfaceTheme = 'dark' | 'light'

/** The attribute {@link applySurfaceTheme} stamps on `<html>`, as a dataset key. */
const THEME_ATTRIBUTE = 'ao3eTheme'

/** Resolve the palette: an explicit choice wins, `inherit` reads the skin. */
export function resolveSurfaceTheme(chosen: ThemeOption['chosen'] | undefined): SurfaceTheme {
  if (chosen === 'dark' || chosen === 'light')
    return chosen
  return isDarkTheme() ? 'dark' : 'light'
}

/**
 * Stamp the resolved palette on `<html>`, where the token block in
 * `content_script.css` picks it up. Every surface reads its colours from those
 * tokens, so this one attribute themes all of them at once — including the
 * toast, whose shadow root inherits the custom properties through the boundary.
 */
export function applySurfaceTheme(chosen?: ThemeOption['chosen']): SurfaceTheme {
  const theme = resolveSurfaceTheme(chosen)
  document.documentElement.dataset[THEME_ATTRIBUTE] = theme
  return theme
}

/**
 * Stamp the palette only if nothing has yet. Called as a surface is mounted, for
 * the case where one opens before the page-run pass has applied it (the reader
 * is quick, or a re-run is mid-flight) — cheap, and a mis-themed first menu is
 * exactly the glitch this feature exists to remove.
 */
export function ensureSurfaceTheme(): void {
  if (!document.documentElement.dataset[THEME_ATTRIBUTE])
    applySurfaceTheme()
}
