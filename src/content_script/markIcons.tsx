import Ao3eMarkCringe from '~icons/ao3e/mark-cringe.jsx'
import Ao3eMarkDeadDove from '~icons/ao3e/mark-dead-dove.jsx'
import Ao3eMarkPlusP from '~icons/ao3e/mark-plus-p.jsx'
import Ao3eMarkRatingG from '~icons/ao3e/mark-rating-g.jsx'
import Ao3eMarkRatingPg13 from '~icons/ao3e/mark-rating-pg13.jsx'
import Ao3eMarkRatingPg from '~icons/ao3e/mark-rating-pg.jsx'
import Ao3eMarkRatingR from '~icons/ao3e/mark-rating-r.jsx'
import Ao3eMarkRelicCross from '~icons/ao3e/mark-relic-cross.jsx'
import Ao3eMarkWardingFingers from '~icons/ao3e/mark-warding-fingers.jsx'
import MdiAlert from '~icons/mdi/alert.jsx'
import MdiBomb from '~icons/mdi/bomb.jsx'
import MdiBookCheck from '~icons/mdi/book-check.jsx'
import MdiBookOff from '~icons/mdi/book-off.jsx'
import MdiBookmarkCheck from '~icons/mdi/bookmark-check.jsx'
import MdiBookmark from '~icons/mdi/bookmark.jsx'
import MdiButterfly from '~icons/mdi/butterfly.jsx'
import MdiCalendarClock from '~icons/mdi/calendar-clock.jsx'
import MdiCat from '~icons/mdi/cat.jsx'
import MdiChiliHot from '~icons/mdi/chili-hot.jsx'
import MdiClockCheckOutline from '~icons/mdi/clock-check-outline.jsx'
import MdiClockCheck from '~icons/mdi/clock-check.jsx'
import MdiCloseCircle from '~icons/mdi/close-circle.jsx'
import MdiCloud from '~icons/mdi/cloud.jsx'
import MdiCreation from '~icons/mdi/creation.jsx'
import MdiCrown from '~icons/mdi/crown.jsx'
import MdiDuck from '~icons/mdi/duck.jsx'
import MdiEmoticonAngry from '~icons/mdi/emoticon-angry.jsx'
import MdiEmoticonConfused from '~icons/mdi/emoticon-confused.jsx'
import MdiEmoticonCry from '~icons/mdi/emoticon-cry.jsx'
import MdiEmoticonDead from '~icons/mdi/emoticon-dead.jsx'
import MdiEmoticonDevil from '~icons/mdi/emoticon-devil.jsx'
import MdiEmoticonHappy from '~icons/mdi/emoticon-happy.jsx'
import MdiEmoticonKiss from '~icons/mdi/emoticon-kiss.jsx'
import MdiEmoticonLol from '~icons/mdi/emoticon-lol.jsx'
import MdiEmoticonNeutral from '~icons/mdi/emoticon-neutral.jsx'
import MdiEmoticonPoop from '~icons/mdi/emoticon-poop.jsx'
import MdiEmoticonSick from '~icons/mdi/emoticon-sick.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiFire from '~icons/mdi/fire.jsx'
import MdiFlag from '~icons/mdi/flag.jsx'
import MdiGhost from '~icons/mdi/ghost.jsx'
import MdiHandOkay from '~icons/mdi/hand-okay.jsx'
import MdiHeartBroken from '~icons/mdi/heart-broken.jsx'
import MdiHeartMultiple from '~icons/mdi/heart-multiple.jsx'
import MdiHeart from '~icons/mdi/heart.jsx'
import MdiKnifeMilitary from '~icons/mdi/knife-military.jsx'
import MdiLightbulb from '~icons/mdi/lightbulb.jsx'
import MdiLightningBolt from '~icons/mdi/lightning-bolt.jsx'
import MdiMinusThick from '~icons/mdi/minus-thick.jsx'
import MdiPaw from '~icons/mdi/paw.jsx'
import MdiPlusThick from '~icons/mdi/plus-thick.jsx'
import MdiRabbit from '~icons/mdi/rabbit.jsx'
import MdiRepeat from '~icons/mdi/repeat.jsx'
import MdiSkull from '~icons/mdi/skull.jsx'
import MdiSleep from '~icons/mdi/sleep.jsx'
import MdiStar from '~icons/mdi/star.jsx'
import MdiThumbDown from '~icons/mdi/thumb-down.jsx'
import MdiThumbUp from '~icons/mdi/thumb-up.jsx'
import MdiWeatherRainy from '~icons/mdi/weather-rainy.jsx'

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
  'mdi/plus-thick': () => <MdiPlusThick />,
  'mdi/minus-thick': () => <MdiMinusThick />,
  'mdi/cat': () => <MdiCat />,
  'mdi/paw': () => <MdiPaw />,
  'mdi/rabbit': () => <MdiRabbit />,
  'mdi/duck': () => <MdiDuck />,
  'mdi/butterfly': () => <MdiButterfly />,
  'mdi/ghost': () => <MdiGhost />,
  'mdi/emoticon-devil': () => <MdiEmoticonDevil />,
  'mdi/emoticon-dead': () => <MdiEmoticonDead />,
  'mdi/bomb': () => <MdiBomb />,
  'mdi/lightning-bolt': () => <MdiLightningBolt />,
  'mdi/heart-broken': () => <MdiHeartBroken />,
  'mdi/heart-multiple': () => <MdiHeartMultiple />,
  'mdi/emoticon-kiss': () => <MdiEmoticonKiss />,
  'mdi/emoticon-lol': () => <MdiEmoticonLol />,
  'mdi/emoticon-angry': () => <MdiEmoticonAngry />,
  'mdi/emoticon-confused': () => <MdiEmoticonConfused />,
  'mdi/emoticon-poop': () => <MdiEmoticonPoop />,
  'mdi/weather-rainy': () => <MdiWeatherRainy />,
  'mdi/creation': () => <MdiCreation />,
  'mdi/crown': () => <MdiCrown />,
  'ao3e/mark-rating-g': () => <Ao3eMarkRatingG />,
  'ao3e/mark-rating-pg': () => <Ao3eMarkRatingPg />,
  'ao3e/mark-rating-pg13': () => <Ao3eMarkRatingPg13 />,
  'ao3e/mark-rating-r': () => <Ao3eMarkRatingR />,
  'ao3e/mark-plus-p': () => <Ao3eMarkPlusP />,
  'ao3e/mark-dead-dove': () => <Ao3eMarkDeadDove />,
  'mdi/hand-okay': () => <MdiHandOkay />,
  'ao3e/mark-warding-fingers': () => <Ao3eMarkWardingFingers />,
  'ao3e/mark-relic-cross': () => <Ao3eMarkRelicCross />,
  'mdi/knife-military': () => <MdiKnifeMilitary />,
  'ao3e/mark-cringe': () => <Ao3eMarkCringe />,
}

/** The icon factory for a mark's `icon` field, falling back to a generic bookmark. */
export function markIcon(icon: string | undefined): () => Node {
  return MARK_ICONS[resolveMarkIcon(icon)] ?? MARK_ICONS[FALLBACK_MARK_ICON]!
}

/**
 * Outlined versions of the mark icons, drawn as such, for a control that offers
 * a mark rather than showing one. Only Marked for Later's default has a place
 * that needs it; any other icon is traced from its filled shape instead.
 */
const MARK_OUTLINES: Record<string, () => Node> = {
  'mdi/clock-check': () => <MdiClockCheckOutline />,
}

/** The drawn outline of a mark's icon, or null where there is none and the filled icon has to be traced. */
export function markOutlineIcon(icon: string | undefined): (() => Node) | null {
  return MARK_OUTLINES[resolveMarkIcon(icon)] ?? null
}
