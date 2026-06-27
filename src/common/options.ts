import type { AuthorFilter, Language, TagFilter, TextReplacement } from './data.ts'

import { DEFAULT_HIGHLIGHT_COLOR } from './data.ts'
import { createStorage } from './storage.ts'

export interface ThemeOption {
  chosen: 'inherit' | 'dark' | 'light'
  current: 'dark' | 'light'
}

export interface Options {
  showTotalTime: boolean
  showTotalFinish: boolean
  showChapterWords: boolean
  showChapterTime: boolean
  showChapterFinish: boolean
  showChapterDate: boolean
  wordsPerMinute: number
  showKudosHitsRatio: boolean

  hideShowReason: boolean
  hideShowMatchedValues: boolean
  hideCrossovers: { enabled: boolean, maxFandoms: number }
  hideLanguages: { enabled: boolean, show: Language[] }
  hideAuthors: { enabled: boolean, filters: AuthorFilter[] }
  hideTags: {
    enabled: boolean
    filters: TagFilter[]
    /** Highlight colour used by filters (and force-shown tags) that don't set their own. */
    defaultHighlightColor?: string
  }

  compressSearchUrls: boolean
  tagToolbar: boolean
  fandomToolbar: boolean
  markForLaterToolbar: boolean
  /** Floating control on listings to temporarily reveal tag-filtered works. */
  filterToolbar: boolean
  hideAuthorToolbar: boolean
  subscribeAuthorToolbar: boolean
  muteAuthorToolbar: boolean

  styleWidthEnabled: boolean
  styleWidth: number
  showStatsColumns: boolean
  forceAlignment: null | 'start' | 'end' | 'justified'
  textReplacements: { enabled: boolean, rules: TextReplacement[] }

  theme: ThemeOption
  user: { userId?: string }

  // Special case - see ./logger.ts
  verbose: boolean
}

export const options = createStorage<Options>({
  area: 'local',
  name: 'Options',
  prefix: 'option.',
  ignoredEvents: ['theme', 'user'],
  defaults: {
    showTotalTime: true,
    showTotalFinish: true,
    showChapterWords: true,
    showChapterTime: true,
    showChapterFinish: true,
    showChapterDate: true,
    wordsPerMinute: 200,
    showKudosHitsRatio: true,

    hideShowReason: true,
    hideShowMatchedValues: true,
    hideCrossovers: { enabled: true, maxFandoms: 7 },
    hideLanguages: { enabled: false, show: [] },
    hideAuthors: { enabled: false, filters: [] },
    hideTags: { enabled: false, filters: [], defaultHighlightColor: DEFAULT_HIGHLIGHT_COLOR },

    compressSearchUrls: false,
    tagToolbar: false,
    fandomToolbar: false,
    markForLaterToolbar: false,
    filterToolbar: false,
    hideAuthorToolbar: false,
    subscribeAuthorToolbar: false,
    muteAuthorToolbar: false,

    styleWidthEnabled: true,
    styleWidth: 40,
    showStatsColumns: true,
    forceAlignment: null,
    textReplacements: { enabled: false, rules: [] },

    theme: { chosen: 'inherit', current: 'light' },
    user: { },

    verbose: false,
  },
})

// eslint-disable-next-line ts/no-namespace, ts/no-redeclare
export namespace options {
  export type Id = keyof Options
  export type BooleanId = keyof Pick<Options, { [K in keyof Options]: Options[K] extends boolean ? K : never }[keyof Options]>
  export type NumberId = keyof Pick<Options, { [K in keyof Options]: Options[K] extends number ? K : never }[keyof Options]>
}
