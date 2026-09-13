import type { Options, WordCountRange } from '#common'

import { isValidRange } from '#common'
import { Unit } from '#content_script/Unit.js'
import { getWordCountRange, setWordCountRange, wordCountControl } from '#content_script/wordCountFilter.js'

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

/**
 * The default each word-count control has already been offered, so it is
 * offered once. The same arrangement as the language dropdown's, for the same
 * reason: every options change re-runs this unit, and a reader who cleared the
 * range without searching yet must not find it filled back in. Keyed by the
 * range so that changing the setting itself still reaches an open page.
 */
const offered = new WeakMap<HTMLInputElement, string>()

export class DefaultSearchWordCount extends Unit {
  static override get name() { return 'DefaultSearchWordCount' }

  override get enabled(): boolean {
    return resolveDefaultWordCount(this.options) !== null
  }

  override async ready(): Promise<void> {
    const range = resolveDefaultWordCount(this.options)
    const control = wordCountControl(this.root)
    if (!range || !control)
      return

    const key = `${range.from ?? ''}-${range.to ?? ''}`
    if (offered.get(control) === key)
      return
    offered.set(control, key)

    // Respect a range the user (or the URL) already put there.
    if (getWordCountRange(this.root) !== null)
      return

    if (setWordCountRange(range, this.root))
      this.logger.debug('Defaulted the word count filter.', range)
  }
}
