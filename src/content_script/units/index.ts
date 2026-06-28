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
import { MarkForLaterToolbar } from './MarkForLaterToolbar.tsx'
import { MuteAuthorToolbar } from './MuteAuthorToolbar.tsx'
import { OptionsUpdater } from './OptionsUpdater.tsx'
import { SearchMarkedForLater } from './SearchMarkedForLater.tsx'
import { Stats } from './Stats/Stats.ts'
import { StyleTweaks } from './StyleTweaks.tsx'
import { SubscribeAuthorToolbar } from './SubscribeAuthorToolbar.tsx'
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
  TagToolbar,
  FandomToolbar,
  HideAuthorToolbar,
  SubscribeAuthorToolbar,
  MuteAuthorToolbar,
  MarkForLaterToolbar,
  // After MarkForLaterToolbar so the work toggle inserts left of its button.
  FilterWorkToolbar,
  FilterSeriesToolbar,
  SearchMarkedForLater,
  Tools,
  Stats,
  OptionsUpdater,
] as typeof Unit[]
