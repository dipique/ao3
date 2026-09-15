import type { Unit } from '#content_script/Unit.js'

import { AutoExcludeHidden } from './AutoExcludeHidden.ts'
import { CaptureMarkButtons } from './CaptureMarkButtons.ts'
import { CollapsibleDashboard } from './CollapsibleDashboard.ts'
import { CompressSearchUrls } from './CompressSearchUrls.ts'
import { DefaultSearchLanguage } from './DefaultSearchLanguage.ts'
import { DefaultSearchWordCount } from './DefaultSearchWordCount.ts'
import { FandomToolbar } from './FandomToolbar.tsx'
import { FilterSeriesToolbar, FilterWorkToolbar } from './FilterEntityToolbars.tsx'
import { FilterToolbar } from './FilterToolbar.tsx'
import { HideAuthorToolbar } from './HideAuthorToolbar.tsx'
import { HideFilters } from './HideFilters.ts'
import { HideWorks } from './HideWorks.tsx'
import { HighlightAuthors } from './HighlightAuthors.ts'
import { HighlightSeries, HighlightWorks } from './HighlightEntities.ts'
import { HighlightTags } from './HighlightTags.ts'
import { OptionsUpdater } from './OptionsUpdater.tsx'
import { ReaderMode } from './ReaderMode.ts'
import { RequiredTagsToolbar } from './RequiredTagsToolbar.tsx'
import { SearchMarkedForLater } from './SearchMarkedForLater.tsx'
import { SearchReadWorks } from './SearchReadWorks.tsx'
import { SearchSeriesWorks } from './SearchSeriesWorks.tsx'
import { SearchTagWorks } from './SearchTagWorks.tsx'
import { SearchTextResults } from './SearchTextResults.tsx'
import { Stats } from './Stats/Stats.ts'
import { StyleTweaks } from './StyleTweaks.tsx'
import { SyncNotice } from './SyncNotice.ts'
import { TagToolbar } from './TagToolbar.tsx'
import { TextReplace } from './TextReplace.ts'
import { TextReplaceTools } from './TextReplaceTools.tsx'
import { Tools } from './Tools.tsx'
import { WordCountToolbar } from './WordCountToolbar.tsx'

export const UNITS = [
  StyleTweaks,
  // After StyleTweaks so it takes over #workskin's width (its inline width wins
  // over StyleTweaks' stylesheet rule) and measures the resulting column width.
  ReaderMode,
  CollapsibleDashboard,
  TextReplace,
  // After TextReplace, whose spans are what its underlines and click-to-edit hang on.
  TextReplaceTools,
  HideWorks,
  // Runs after HideWorks so it can count the works HideWorks marked as hidden.
  FilterToolbar,
  // Beside HideWorks: it weighs the same works, and turns the ones a rule takes
  // away outright into exclusions in AO3's own filter, so the next search never
  // fetches them.
  AutoExcludeHidden,
  HighlightTags,
  // After HighlightTags: a tag can't be both highlighted and hidden, but if a
  // page ever matched both rules, hiding should be what the reader sees.
  HideFilters,
  HighlightAuthors,
  HighlightWorks,
  HighlightSeries,
  CompressSearchUrls,
  DefaultSearchLanguage,
  DefaultSearchWordCount,
  CaptureMarkButtons,
  // The context-menu decorators. Subscribe/mute/mark-for-later were folded into
  // the author and work menus, so they're no longer separate units.
  TagToolbar,
  RequiredTagsToolbar,
  FandomToolbar,
  HideAuthorToolbar,
  FilterWorkToolbar,
  FilterSeriesToolbar,
  WordCountToolbar,
  SearchMarkedForLater,
  // After SearchMarkedForLater, whose button its own sits next to.
  SearchReadWorks,
  SearchSeriesWorks,
  SearchTagWorks,
  SearchTextResults,
  Tools,
  Stats,
  OptionsUpdater,
  // Last: a toast about sync, independent of everything the page itself shows.
  SyncNotice,
] as typeof Unit[]
