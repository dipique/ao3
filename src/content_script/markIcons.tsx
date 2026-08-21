import MdiBookCheck from '~icons/mdi/book-check.jsx'
import MdiBookmarkCheck from '~icons/mdi/bookmark-check.jsx'
import MdiCalendarClock from '~icons/mdi/calendar-clock.jsx'
import MdiClockCheck from '~icons/mdi/clock-check.jsx'
import MdiEmoticonSick from '~icons/mdi/emoticon-sick.jsx'
import MdiHeart from '~icons/mdi/heart.jsx'
import MdiSleep from '~icons/mdi/sleep.jsx'
import MdiThumbDown from '~icons/mdi/thumb-down.jsx'
import MdiThumbUp from '~icons/mdi/thumb-up.jsx'

import React from '#dom'

/**
 * Icons a mark can name in its `icon` field. The mark table is data (it lives in
 * options and can be edited), but the icons can't be — unplugin-icons inlines
 * each SVG at build time, so only what's imported here exists at runtime. A mark
 * naming something absent falls back to the generic bookmark rather than
 * rendering nothing.
 *
 * Keys are the mark ids the defaults ship with, so the common case is
 * `icon: '<own id>'` and nothing has to be looked up twice.
 */
const MARK_ICONS: Record<string, () => Node> = {
  read: () => <MdiBookCheck />,
  favorite: () => <MdiHeart />,
  good: () => <MdiThumbUp />,
  boring: () => <MdiSleep />,
  bad: () => <MdiThumbDown />,
  gross: () => <MdiEmoticonSick />,
  continue: () => <MdiCalendarClock />,
  saved: () => <MdiClockCheck />,
}

/** The icon factory for a mark's `icon` key, falling back to a generic bookmark. */
export function markIcon(icon: string | undefined): () => Node {
  return (icon && MARK_ICONS[icon]) || (() => <MdiBookmarkCheck />)
}
