import type { Unit } from '#content_script/Unit.js'

import { CompressSearchUrls } from './CompressSearchUrls.ts'
import { FandomToolbar } from './FandomToolbar.tsx'
import { HideAuthorToolbar } from './HideAuthorToolbar.tsx'
import { HideWorks } from './HideWorks.tsx'
import { OptionsUpdater } from './OptionsUpdater.tsx'
import { Stats } from './Stats/Stats.ts'
import { StyleTweaks } from './StyleTweaks.tsx'
import { SubscribeAuthorToolbar } from './SubscribeAuthorToolbar.tsx'
import { TagToolbar } from './TagToolbar.tsx'
import { Tools } from './Tools.tsx'

export const UNITS = [
  StyleTweaks,
  HideWorks,
  CompressSearchUrls,
  TagToolbar,
  FandomToolbar,
  HideAuthorToolbar,
  SubscribeAuthorToolbar,
  Tools,
  Stats,
  OptionsUpdater,
] as typeof Unit[]
