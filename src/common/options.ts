import type { AuthorFilter, Language, SeriesFilter, TagFilter, TextReplacement, WorkFilter } from './data.ts'
import type { WorkMarks } from './workMarks.ts'

import { DEFAULT_AUTHOR_HIGHLIGHT_COLOR, DEFAULT_HIGHLIGHT_COLOR, DEFAULT_SERIES_HIGHLIGHT_COLOR, DEFAULT_WORK_HIGHLIGHT_COLOR } from './data.ts'
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
  hideLanguages: {
    enabled: boolean
    show: Language[]
    /**
     * Also pre-select this language in AO3's own Sort & Filter dropdown, so the
     * archive filters server-side instead of us hiding the results after they
     * arrive. Only meaningful when exactly one language is listed — with several
     * there's no single value the dropdown could take. An explicit
     * {@link Options.searchLanguage} still wins.
     */
    applyToSearch?: boolean
  }
  hideAuthors: {
    enabled: boolean
    filters: AuthorFilter[]
    /** Highlight colour used by author filters (and force-shown authors) that don't set their own. */
    defaultHighlightColor?: string
  }
  hideTags: {
    enabled: boolean
    filters: TagFilter[]
    /** Highlight colour used by filters (and force-shown tags) that don't set their own. */
    defaultHighlightColor?: string
  }
  hideWorks: {
    enabled: boolean
    filters: WorkFilter[]
    /** Highlight colour used by filters (and force-shown works) that don't set their own. */
    defaultHighlightColor?: string
  }
  hideSeries: {
    enabled: boolean
    filters: SeriesFilter[]
    /** Highlight colour used by filters (and force-shown series) that don't set their own. */
    defaultHighlightColor?: string
  }
  /**
   * Per-work read/favourite marks, plus the switch that hides read works. Unlike
   * the filter lists these grow one entry per work you finish, so the id sets are
   * stored delta-packed — see {@link file://./workMarks.ts}.
   */
  workMarks: WorkMarks

  compressSearchUrls: boolean
  tagToolbar: boolean
  fandomToolbar: boolean
  markForLaterToolbar: boolean
  /** Floating control on listings to temporarily reveal works hidden by any filter. */
  filterToolbar: boolean
  hideAuthorToolbar: boolean
  subscribeAuthorToolbar: boolean
  muteAuthorToolbar: boolean
  /**
   * Master switch for the extension's in-page right-click / long-press context
   * menus. When off, our menus stay out of the way and the browser's native menu
   * shows on links again (the on-page indicators still open their menus).
   */
  contextMenusEnabled: boolean
  /**
   * When on, a plain left-click / tap on a decorated tag, fandom, or author link
   * opens its context menu instead of following the link. The menu's "Open" item
   * (always present) follows the link, so navigation is never lost.
   */
  openMenuOnClick: boolean
  /** On your own Marked for Later page, add a button that loads every page into one filterable view. */
  searchMarkedForLater: boolean
  /** How many works to render per page in the Search Marked for Later view (paging keeps large lists fast). */
  searchPerPage: number
  /**
   * Auto-select a default language in AO3's Sort & Filter Language dropdown
   * (works/bookmark listings and the advanced search page). Only applied when no
   * language is already chosen, so a language already in the URL is respected.
   * `language` null = none set.
   */
  searchLanguage: { enabled: boolean, language: Language | null }

  styleWidthEnabled: boolean
  styleWidth: number
  /**
   * On work pages, take over sizing of the work text (`#workskin`): a zoom
   * gesture (Ctrl+scroll / trackpad pinch) over the text changes its font size
   * and reflows it instead of zooming the page, and drag-handles on the text's
   * left/right edges set how wide the reading column is. The actual font scale
   * and width are per-device state kept in the page's `localStorage` (see
   * `ReaderMode`), so they never sync — this flag is only the on/off switch.
   */
  readerMode: boolean
  showStatsColumns: boolean
  forceAlignment: null | 'start' | 'end' | 'justified'
  /** Hide the "muted author" notices that appear where works are hidden because of a muted author. */
  hideMutedAuthorNotices: boolean
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
    hideLanguages: { enabled: false, show: [], applyToSearch: false },
    hideAuthors: { enabled: false, filters: [], defaultHighlightColor: DEFAULT_AUTHOR_HIGHLIGHT_COLOR },
    hideTags: { enabled: false, filters: [], defaultHighlightColor: DEFAULT_HIGHLIGHT_COLOR },
    hideWorks: { enabled: false, filters: [], defaultHighlightColor: DEFAULT_WORK_HIGHLIGHT_COLOR },
    hideSeries: { enabled: false, filters: [], defaultHighlightColor: DEFAULT_SERIES_HIGHLIGHT_COLOR },
    workMarks: { enabled: false, hideRead: false, read: '', favorite: '' },

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
    searchPerPage: 50,
    searchLanguage: { enabled: false, language: null },

    styleWidthEnabled: true,
    styleWidth: 40,
    readerMode: false,
    showStatsColumns: true,
    forceAlignment: null,
    hideMutedAuthorNotices: false,
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
