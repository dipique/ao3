import type { Options, WordCountRange } from '#common'

import { isValidRange } from '#common'
import { Unit } from '#content_script/Unit.js'
import { getWordCountRange, setWordCountRange } from '#content_script/wordCountFilter.js'

/**
 * Pre-fill AO3's Word Count filter with a default range, so browsing defaults to
 * the lengths you actually read without dialling them in each time.
 *
 * The companion to {@link file://./DefaultSearchLanguage.ts}, and deliberately
 * the same deal: it runs at the same point (page ready), fills the same Sort &
 * Filter sidebar (plus the advanced search page's single `word_count` field),
 * and only when nothing is set yet — so a range already chosen, or one carried
 * in the page URL, is left alone. We only set the controls; the user still
 * submits the filter form as normal.
 */

/** The default range, or null when the setting is off or its bounds are unusable. */
export function resolveDefaultWordCount(options: Options): WordCountRange | null {
  const { enabled, from, to } = options.searchWordCount
  if (!enabled)
    return null
  const range: WordCountRange = { from: from ?? null, to: to ?? null }
  return isValidRange(range) ? range : null
}

export class DefaultSearchWordCount extends Unit {
  static override get name() { return 'DefaultSearchWordCount' }

  override get enabled(): boolean {
    return resolveDefaultWordCount(this.options) !== null
  }

  override async ready(): Promise<void> {
    const range = resolveDefaultWordCount(this.options)
    if (!range)
      return

    // Respect a range the user (or the URL) already put there.
    if (getWordCountRange(this.root) !== null)
      return

    if (setWordCountRange(range, this.root))
      this.logger.debug('Defaulted the word count filter.', range)
  }
}
