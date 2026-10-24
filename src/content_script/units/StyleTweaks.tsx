import { ADDON_CLASS } from '#common'
import { Unit } from '#content_script/Unit.js'

export class StyleTweaks extends Unit {
  override get name() { return 'StyleTweaks' }
  // Every tweak this unit draws has to be named here, `forceAlignment` included:
  // a reader whose only change is the alignment would otherwise have the unit
  // filtered out before `ready()` ran, and nothing would be applied at all.
  override get enabled() {
    return this.options.styleWidthEnabled
      || this.options.showStatsColumns
      || this.options.forceAlignment !== null
      || this.options.hideMutedAuthorNotices
  }

  override async ready(): Promise<void> {
    const styleTag = document.createElement('style')
    styleTag.classList.add(ADDON_CLASS)
    document.head.appendChild(styleTag)

    const sheet = styleTag.sheet!

    if (this.options.styleWidthEnabled) {
      this.insertRule(
        sheet,
        `#workskin {
          width: ${100 - this.options.styleWidth}%
        }`,
      )
      this.insertRule(
        sheet,
        `.preface {
          margin: 0 !important
        }`,
      )
    }

    // Each value under a small label: a column as wide as its value rather than
    // its label, so a work's whole line of statistics keeps to one row.
    if (this.options.showStatsColumns) {
      this.insertRule(
        sheet,
        `dl.stats {
          align-items: flex-start;
          column-gap: 0.8em;
          row-gap: 0.45em;
        }`,
      )
      this.insertRule(
        sheet,
        `dl.stats > div {
          display: flex !important;
          flex-direction: column !important;
          align-items: flex-start;
          margin: 0;
        }`,
      )
      this.insertRule(
        sheet,
        `dl.stats > div > dt, dl.stats > div > dd {
          margin: 0;
          line-height: 1.35;
        }`,
      )
      this.insertRule(
        sheet,
        `dl.stats > div > dt {
          font-size: 0.75em;
        }`,
      )
      this.insertRule(
        sheet,
        `dl.stats > div > dd {
          font-variant-numeric: tabular-nums;
        }`,
      )
      // Greyed from whatever colour the skin gives the text, and as weakly as a
      // rule can be, so a skin that colours labels itself is left to.
      this.insertRule(
        sheet,
        `:where(dl.stats > div) > dt {
          color: color-mix(in srgb, currentColor 70%, transparent);
        }`,
      )
    }

    if (this.options.forceAlignment) {
      this.insertRule(
        sheet,
        `.userstuff * {
          text-align: ${this.options.forceAlignment} !important;
        }`,
      )
    }

    if (this.options.hideMutedAuthorNotices) {
      this.insertRule(
        sheet,
        `p.muted.notice {
          display: none !important;
        }`,
      )
    }

    this.logger.debug(
      'Using style tweaks rules: ',
      Array.from(sheet.cssRules).map(rule => rule.cssText),
    )
  }

  insertRule(sheet: CSSStyleSheet, rule: string): void {
    sheet.insertRule(rule, sheet.cssRules.length)
  }
}
