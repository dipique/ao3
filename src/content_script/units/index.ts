import type { Unit } from '#content_script/Unit.js'

import { CaptureMarkButtons } from './CaptureMarkButtons.ts'
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
import { SearchTagWorks } from './SearchTagWorks.tsx'
import { Stats } from './Stats/Stats.ts'
import { StyleTweaks } from './StyleTweaks.tsx'
import { TagToolbar } from './TagToolbar.tsx'
import { TextReplace } from './TextReplace.ts'
import { Tools } from './Tools.tsx'
import { WordCountToolbar } from './WordCountToolbar.tsx'

export const UNITS = [
  StyleTweaks,
  // After StyleTweaks so it takes over #workskin's width (its inline width wins
  // over StyleTweaks' stylesheet rule) and measures the resulting column width.
  ReaderMode,
  TextReplace,
  HideWorks,
  // Runs after HideWorks so it can count the works HideWorks marked as hidden.
  FilterToolbar,
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
  SearchTagWorks,
  Tools,
  Stats,
  OptionsUpdater,
] as typeof Unit[]
