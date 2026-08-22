import type { Tag } from '#common'

import { TagType } from '#common'

export function getTag(linkUrl: string): Tag | undefined {
  const url = new URL(linkUrl)
  const a = document.querySelector(`a[href="${url.pathname}"]`)

  if (!a)
    return

  return getTagFromElement(a)
}

/**
 * A work page types its tag lists on the wrapping `dd` (e.g. `dd.freeform.tags`)
 * instead of the `li`, and in the singular — so the plural classes
 * {@link TagType.toCSSClass} looks for never match there.
 */
const WORK_META_TAG_CLASSES: Record<string, TagType> = {
  rating: TagType.Rating,
  warning: TagType.ArchiveWarning,
  category: TagType.Category,
  fandom: TagType.Fandom,
  relationship: TagType.Relationship,
  character: TagType.Character,
  freeform: TagType.Freeform,
}

export function getTagFromElement(tagElement: Element): Tag {
  const parent = tagElement?.closest('.fandoms,li')

  let tagType: TagType | undefined
  for (const type of TagType.values()) {
    const cssClass = TagType.toCSSClass(type)
    if (parent?.classList.contains(cssClass)) {
      tagType = type
      break
    }
  }

  // Blurb tags carry their type on the `li`; work-page tags don't, so fall back
  // to the `dd` their list lives in.
  if (tagType === undefined) {
    const dd = tagElement?.closest('dd.tags')
    for (const [cssClass, type] of Object.entries(WORK_META_TAG_CLASSES)) {
      if (dd?.classList.contains(cssClass)) {
        tagType = type
        break
      }
    }
  }

  return {
    name: tagElement.textContent!,
    type: tagType,
  }
}

export function isDarkTheme(): boolean {
  // At `document_start` there is no body yet. "Not dark" is the right answer for
  // a page we cannot measure — it matches AO3's default skin.
  if (!document.body)
    return false
  const bgColor = window.getComputedStyle(document.body).backgroundColor
  if (bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent') {
    return isDark(bgColor)
  }
  return false
}

function isDark(color: string) {
  const rgbMatch = color.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/,
  )
  if (rgbMatch) {
    const r = Number.parseFloat(rgbMatch[1]!)
    const g = Number.parseFloat(rgbMatch[2]!)
    const b = Number.parseFloat(rgbMatch[3]!)
    const brightness = 0.299 * r + 0.587 * g + 0.114 * b
    return brightness < 128
  }
  return false
}
