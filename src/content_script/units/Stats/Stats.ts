import type { Options } from '#common'

import { Unit } from '#content_script/Unit.js'

import { ChapterStats } from './ChapterStats.tsx'
import { TotalStats } from './TotalStats.tsx'

export class Stats extends Unit {
  total: TotalStats
  chapter: ChapterStats

  constructor(options: Options, root: ParentNode = document) {
    super(options, root)

    this.total = new TotalStats(options, root)
    this.chapter = new ChapterStats(options, root)
  }

  override get name() { return 'Stats' }
  override get enabled() { return true }

  static override async clean(): Promise<void> {
    await TotalStats.clean()
    await ChapterStats.clean()

    for (const statValueElement of document.querySelectorAll('dl.stats dd')) {
      const original = statValueElement.dataset.ao3eOriginal
      if (original)
        statValueElement.textContent = original

      delete statValueElement.dataset.ao3eOriginal
    }
  }

  override async ready(): Promise<void> {
    if (this.total.enabled)
      await this.total.ready()
    if (this.chapter.enabled)
      await this.chapter.ready()

    // Fix thousands separators
    for (let statValueElement of this.root.querySelectorAll<HTMLElement>('dl.stats dd')) {
      if (statValueElement.querySelector('a'))
        statValueElement = statValueElement.querySelector('a')!

      // Get stat values as numbers if they are numbers
      // Make sure to split on / so we get both chapter counts
      const hasNumber = statValueElement
        .textContent!
        .replace(/,/g, '')
        .split('/')
        .some(val => !Number.isNaN(+val))
      if (!hasNumber)
        continue
      statValueElement.dataset.ao3eOriginal = statValueElement.textContent!
      // Text node by text node rather than through `textContent`, so markup
      // another unit put inside the value survives \u2014 the completion menu wraps
      // a chapter total in a span of its own. A number never straddles two
      // nodes, so formatting each alone gives what formatting the whole would.
      const walker = document.createTreeWalker(statValueElement, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        (node as Text).data = withThousandsSeparators((node as Text).data)
    }
  }
}

/** `12,345/100000` \u2192 `12 345/100 000` (thin spaces); anything not a number (`?`) passes through. */
function withThousandsSeparators(text: string): string {
  return text
    .replace(/,/g, '')
    .split('/')
    .map(val => Number.isNaN(+val) ? val : val.replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009'))
    .join('/')
}
