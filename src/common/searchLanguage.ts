import type { Language } from './data.ts'
import type { Options } from './options.ts'

/** The shape `option.hideLanguages` was stored in. */
interface LegacyLanguageHide { enabled: boolean, show: Language[], applyToSearch?: boolean }

/** What retiring the stored `hideLanguages` setting writes besides removing it. */
export interface LanguageHideRetirement {
  /** The default language filter to store, when the hidden-around language carries over. */
  searchLanguage?: Options['searchLanguage']
}

/**
 * Plan the retirement of `hideLanguages`, the setting that hid every work not in
 * a listed language after the listing had loaded. Languages are only ever
 * filtered by AO3's own Language dropdown now, so a reader who hid around one
 * language gets it as {@link Options.searchLanguage} instead — unless a default
 * language is already on, which is the reader's own explicit choice. Several
 * languages have no single value the dropdown could take, so they carry nothing.
 *
 * Takes the raw stored values. Returns null when there's no `hideLanguages` left
 * to remove, which makes a second run over the result a no-op.
 */
export function planLanguageHideRetirement(stored: { hideLanguages?: unknown, searchLanguage?: unknown }): LanguageHideRetirement | null {
  if (stored.hideLanguages === undefined)
    return null

  const hide = stored.hideLanguages as Partial<LegacyLanguageHide> | null
  const current = stored.searchLanguage as Partial<Options['searchLanguage']> | undefined
  const only: Partial<Language> | undefined = Array.isArray(hide?.show) && hide.show.length === 1 ? hide.show[0] : undefined

  if (!hide?.enabled || !only?.value || (current?.enabled && current.language?.value))
    return {}

  return { searchLanguage: { enabled: true, language: { label: only.label ?? only.value, value: only.value } } }
}
