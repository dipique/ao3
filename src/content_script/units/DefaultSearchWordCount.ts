import type { Options, WordCountRange } from '#common'

import { formatWordCountRange, isValidRange } from '#common'
import { DefaultSearchFilter } from '#content_script/defaultSearchFilter.js'
import { getWordCountRange, setWordCountRange, wordCountControl } from '#content_script/wordCountFilter.js'

/**
 * Pre-fill AO3's Word Count filter with a default range, so browsing defaults to
 * the lengths you actually read without dialling them in each time — in the Sort
 * & Filter sidebar's pair of fields, or the advanced search page's single
 * `word_count` field.
 */

/** The default range, or null when the setting is off or its bounds are unusable. */
export function resolveDefaultWordCount(options: Options): WordCountRange | null {
  const { enabled, from, to } = options.searchWordCount
  if (!enabled)
    return null
  const range: WordCountRange = { from: from ?? null, to: to ?? null }
  return isValidRange(range) ? range : null
}

export class DefaultSearchWordCount extends DefaultSearchFilter<WordCountRange, HTMLInputElement> {
  static override get name() { return 'DefaultSearchWordCount' }

  protected resolve() { return resolveDefaultWordCount(this.options) }
  protected key(range: WordCountRange) { return `${range.from ?? ''}-${range.to ?? ''}` }

  protected controls() {
    const control = wordCountControl(this.root)
    return control ? [control] : []
  }

  protected isSet() { return getWordCountRange(this.root) !== null }
  protected apply(_control: HTMLInputElement, range: WordCountRange) { return setWordCountRange(range, this.root) }
  protected describe(range: WordCountRange) { return `Word count filter set to ${formatWordCountRange(range)} words.` }
}
