import type { Language } from '#common'

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

export class DefaultSearchLanguage extends DefaultSearchFilter<Language, HTMLSelectElement> {
  static override get name() { return 'DefaultSearchLanguage' }

  protected resolve() {
    const { enabled, language } = this.options.searchLanguage
    return enabled && language?.value ? language : null
  }

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
