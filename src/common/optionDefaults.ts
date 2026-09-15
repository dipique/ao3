import type { Options } from './options.ts'

import { DEFAULT_WORD_COUNT_RANGES } from './wordCount.ts'
import { createDefaultMarks, MARKS_VERSION } from './workMarks.ts'

/**
 * Every option's default value — what a fresh install starts with, and what a
 * stored value is compared against to decide whether it needs storing at all.
 *
 * Kept out of `options.ts` so it can be imported where the extension APIs don't
 * exist: that module builds its storage over `browser.storage` as soon as it
 * loads, and the sync tests need these values (and their shape) under a plain
 * `node --test`. Only pure modules may be imported here.
 */
export const OPTION_DEFAULTS: Options = {
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
  hideLanguages: { enabled: false, show: [], applyToSearch: false },
  rules: { enabled: false, filters: [], colors: {} },
  autoExcludeHidden: false,
  workMarks: { enabled: false, marks: createDefaultMarks(), version: MARKS_VERSION },

  pruneOrphanedBlurbs: false,

  compressSearchUrls: false,
  tagToolbar: false,
  fandomToolbar: false,
  markForLaterToolbar: false,
  filterToolbar: false,
  hideAuthorToolbar: false,
  subscribeAuthorToolbar: false,
  muteAuthorToolbar: false,
  contextMenusEnabled: true,
  openMenuOnClick: false,
  searchMarkedForLater: true,
  searchProfileListsRefreshHours: 24,
  searchReadWorks: true,
  searchTagWorks: true,
  searchSeriesWorks: true,
  searchTextResults: true,
  searchPerPage: 50,
  searchMaxResults: 1000,
  searchLanguage: { enabled: false, language: null },
  wordCountToolbar: { enabled: false, ranges: DEFAULT_WORD_COUNT_RANGES.map(range => ({ ...range })) },
  searchWordCount: { enabled: false, from: null, to: null },

  styleWidthEnabled: true,
  styleWidth: 40,
  readerMode: false,
  collapsibleDashboard: false,
  showStatsColumns: true,
  forceAlignment: null,
  hideMutedAuthorNotices: false,
  textReplacements: { enabled: false, tools: false, rules: [] },

  theme: { chosen: 'inherit', current: 'light' },
  user: { },

  verbose: false,
}
