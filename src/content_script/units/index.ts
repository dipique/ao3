import type { Unit } from '#content_script/Unit.js'

import { CompressSearchUrls } from './CompressSearchUrls.ts'
import { FandomToolbar } from './FandomToolbar.tsx'
import { FilterSeriesToolbar, FilterWorkToolbar } from './FilterEntityToolbars.tsx'
import { FilterToolbar } from './FilterToolbar.tsx'
import { HideAuthorToolbar } from './HideAuthorToolbar.tsx'
import { HideWorks } from './HideWorks.tsx'
import { HighlightAuthors } from './HighlightAuthors.ts'
import { HighlightSeries, HighlightWorks } from './HighlightEntities.ts'
import { HighlightTags } from './HighlightTags.ts'
import { OptionsUpdater } from './OptionsUpdater.tsx'
import { SearchMarkedForLater } from './SearchMarkedForLater.tsx'
import { Stats } from './Stats/Stats.ts'
import { StyleTweaks } from './StyleTweaks.tsx'
import { TagToolbar } from './TagToolbar.tsx'
import { TextReplace } from './TextReplace.ts'
import { Tools } from './Tools.tsx'

export const UNITS = [
  StyleTweaks,
  TextReplace,
  HideWorks,
  // Runs after HideWorks so it can count the works HideWorks marked as hidden.
  FilterToolbar,
  HighlightTags,
  HighlightAuthors,
  HighlightWorks,
  HighlightSeries,
  CompressSearchUrls,
  // The context-menu decorators. Subscribe/mute/mark-for-later were folded into
  // the author and work menus, so they're no longer separate units.
  TagToolbar,
  FandomToolbar,
  HideAuthorToolbar,
  FilterWorkToolbar,
  FilterSeriesToolbar,
  SearchMarkedForLater,
  Tools,
  Stats,
  OptionsUpdater,
] as typeof Unit[]
