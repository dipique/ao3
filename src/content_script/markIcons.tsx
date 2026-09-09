import MdiAlert from '~icons/mdi/alert.jsx'
import MdiBookCheck from '~icons/mdi/book-check.jsx'
import MdiBookOff from '~icons/mdi/book-off.jsx'
import MdiBookmarkCheck from '~icons/mdi/bookmark-check.jsx'
import MdiBookmark from '~icons/mdi/bookmark.jsx'
import MdiCalendarClock from '~icons/mdi/calendar-clock.jsx'
import MdiChiliHot from '~icons/mdi/chili-hot.jsx'
import MdiClockCheck from '~icons/mdi/clock-check.jsx'
import MdiCloseCircle from '~icons/mdi/close-circle.jsx'
import MdiCloud from '~icons/mdi/cloud.jsx'
import MdiEmoticonCry from '~icons/mdi/emoticon-cry.jsx'
import MdiEmoticonHappy from '~icons/mdi/emoticon-happy.jsx'
import MdiEmoticonNeutral from '~icons/mdi/emoticon-neutral.jsx'
import MdiEmoticonSick from '~icons/mdi/emoticon-sick.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiFire from '~icons/mdi/fire.jsx'
import MdiFlag from '~icons/mdi/flag.jsx'
import MdiHeart from '~icons/mdi/heart.jsx'
import MdiLightbulb from '~icons/mdi/lightbulb.jsx'
import MdiRepeat from '~icons/mdi/repeat.jsx'
import MdiSkull from '~icons/mdi/skull.jsx'
import MdiSleep from '~icons/mdi/sleep.jsx'
import MdiStar from '~icons/mdi/star.jsx'
import MdiThumbDown from '~icons/mdi/thumb-down.jsx'
import MdiThumbUp from '~icons/mdi/thumb-up.jsx'

import { FALLBACK_MARK_ICON, resolveMarkIcon } from '#common'
import React from '#dom'

/**
 * The content script's half of the mark icon registry: an icon file name as a
 * factory for the inlined SVG.
 *
 * The names themselves, and which ones exist, live in `#common`'s `markIcons`
 * module — shared with the options page's registry and with the UnoCSS config.
 * Every name that module lists needs an entry here, since unplugin-icons only
 * inlines what this file imports.
 */
const MARK_ICONS: Record<string, () => Node> = {
  'mdi/book-check': () => <MdiBookCheck />,
  'mdi/bookmark-check': () => <MdiBookmarkCheck />,
  'mdi/close-circle': () => <MdiCloseCircle />,
  'mdi/thumb-down': () => <MdiThumbDown />,
  'mdi/sleep': () => <MdiSleep />,
  'mdi/emoticon-sick': () => <MdiEmoticonSick />,
  'mdi/thumb-up': () => <MdiThumbUp />,
  'mdi/chili-hot': () => <MdiChiliHot />,
  'mdi/skull': () => <MdiSkull />,
  'mdi/emoticon-cry': () => <MdiEmoticonCry />,
  'mdi/cloud': () => <MdiCloud />,
  'mdi/heart': () => <MdiHeart />,
  'mdi/book-off': () => <MdiBookOff />,
  'mdi/calendar-clock': () => <MdiCalendarClock />,
  'mdi/clock-check': () => <MdiClockCheck />,
  'mdi/star': () => <MdiStar />,
  'mdi/bookmark': () => <MdiBookmark />,
  'mdi/flag': () => <MdiFlag />,
  'mdi/alert': () => <MdiAlert />,
  'mdi/eye-off': () => <MdiEyeOff />,
  'mdi/repeat': () => <MdiRepeat />,
  'mdi/emoticon-happy': () => <MdiEmoticonHappy />,
  'mdi/emoticon-neutral': () => <MdiEmoticonNeutral />,
  'mdi/fire': () => <MdiFire />,
  'mdi/lightbulb': () => <MdiLightbulb />,
}

/** The icon factory for a mark's `icon` field, falling back to a generic bookmark. */
export function markIcon(icon: string | undefined): () => Node {
  return MARK_ICONS[resolveMarkIcon(icon)] ?? MARK_ICONS[FALLBACK_MARK_ICON]!
}
