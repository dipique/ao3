import type { ThemeOption } from '#common'

export type Theme = ThemeOption['current']

/** The theme the page shows: the reader's choice, or AO3's own when the choice is to follow AO3. */
export function shownTheme(theme: ThemeOption): Theme {
  return theme.chosen === 'inherit' ? theme.current : theme.chosen
}

/**
 * The choice the top bar's theme switch makes: the opposite of the theme now
 * showing, always explicit. Following AO3 is chosen again only in Appearance.
 */
export function toggledTheme(theme: ThemeOption): Theme {
  return shownTheme(theme) === 'dark' ? 'light' : 'dark'
}
