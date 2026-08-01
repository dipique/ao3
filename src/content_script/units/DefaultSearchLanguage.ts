import type { Language, Options } from '#common'

import { Unit } from '#content_script/Unit.js'

/**
 * Pre-select a default language in AO3's Sort & Filter "Language" dropdown so
 * browsing defaults to the language you read in, without picking it each time.
 *
 * The dropdown is the `*_search[language_id]` <select> — `work_search[language_id]`
 * inside the `#work-filters` sidebar on works listings and the advanced search
 * page (`/works/search`), and `bookmark_search[language_id]` on bookmark
 * listings — all matched by the `[language_id]` name suffix.
 *
 * Only a dropdown still on "any language" is filled in, so a language already
 * chosen (e.g. carried in the page URL) is left untouched. We only set the
 * control's value; the user still submits the filter form as normal.
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

export class DefaultSearchLanguage extends Unit {
  static override get name() { return 'DefaultSearchLanguage' }

  override get enabled(): boolean {
    return resolveDefaultLanguage(this.options) !== null
  }

  override async ready(): Promise<void> {
    const language = resolveDefaultLanguage(this.options)
    if (!language)
      return

    const selects = this.root.querySelectorAll<HTMLSelectElement>(LANGUAGE_SELECT_SELECTOR)
    let applied = 0
    for (const select of selects) {
      // Respect a language the user already has chosen; only fill in the default
      // when the dropdown is still on its blank "any language" option.
      if (select.value !== '')
        continue
      // Guard against a stale saved code the current page's list doesn't offer.
      if (![...select.options].some(option => option.value === language.value))
        continue
      select.value = language.value
      applied++
    }

    if (applied > 0)
      this.logger.debug(`Defaulted ${applied} language dropdown(s) to "${language.label}".`)
  }
}
