import type { Language, Options } from '#common'

import { DefaultSearchFilter } from '#content_script/defaultSearchFilter.js'

/**
 * Pre-select a default language in AO3's Sort & Filter "Language" dropdown so
 * browsing defaults to the language you read in, without picking it each time.
 *
 * The dropdown is the `*_search[language_id]` <select> — `work_search[language_id]`
 * inside the `#work-filters` sidebar on works listings and the advanced search
 * page (`/works/search`), and `bookmark_search[language_id]` on bookmark
 * listings — all matched by the `[language_id]` name suffix. A dropdown still on
 * its blank "any language" option is the one with nothing chosen.
 */
const LANGUAGE_SELECT_SELECTOR = 'select[name$="[language_id]"]'

/**
 * Which language to default the dropdown to, from the one place that decides it.
 *
 * Two settings can ask for this, so they're resolved in a fixed order rather
 * than by two units racing to fill the same control:
 *
 * 1. **Default search language** — the explicit setting, and so the winner.
 * 2. **Hide works in other languages**, when its "also filter searches" box is
 *    ticked. Hiding is client-side: the works still load and we collapse them.
 *    Pre-selecting the same language lets AO3 filter them out server-side, which
 *    is why the two belong together. It needs exactly one language listed —
 *    with several there's no single value the dropdown could take.
 *
 * Returns null when neither applies.
 */
export function resolveDefaultLanguage(options: Options): Language | null {
  const { searchLanguage, hideLanguages } = options

  if (searchLanguage.enabled && searchLanguage.language?.value)
    return searchLanguage.language

  if (hideLanguages.enabled && hideLanguages.applyToSearch && hideLanguages.show.length === 1) {
    const only = hideLanguages.show[0]!
    if (only.value)
      return only
  }

  return null
}

export class DefaultSearchLanguage extends DefaultSearchFilter<Language, HTMLSelectElement> {
  static override get name() { return 'DefaultSearchLanguage' }

  protected resolve() { return resolveDefaultLanguage(this.options) }
  protected key(language: Language) { return language.value }
  protected controls() { return [...this.root.querySelectorAll<HTMLSelectElement>(LANGUAGE_SELECT_SELECTOR)] }
  protected isSet(select: HTMLSelectElement) { return select.value !== '' }

  protected apply(select: HTMLSelectElement, language: Language) {
    // Guard against a stale saved code the current page's list doesn't offer.
    if (![...select.options].some(option => option.value === language.value))
      return false
    select.value = language.value
    return true
  }

  protected describe(language: Language) { return `Language filter set to ${language.label}.` }
}
