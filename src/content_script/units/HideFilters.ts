import type { Rule, Tag } from '#common'

import { ADDON_CLASS, ruleMatchesTag, TagType } from '#common'
import { checkboxTagName } from '#content_script/filterSidebar.js'
import { Unit } from '#content_script/Unit.js'
import { getTagFromElement } from '#content_script/utils.js'

const HIDDEN_CLASS = `${ADDON_CLASS}--hidden-filter`
/** Marks the last still-visible `li` of a comma list, so it drops its comma. */
const LAST_VISIBLE_CLASS = `${ADDON_CLASS}--hidden-filter-last`

/** Tag links, in blurb tag lists and in a work's own meta list. */
const TAG_SELECTOR = 'a.tag'
/** The `li` a tag link sits in, when it's part of a tag list (never the blurb's own `li`). */
const TAG_ITEM_SELECTOR = 'ul.tags > li, ul.commas > li'

/**
 * The sidebar's id-keyed filter checkbox groups and the tag type each lists.
 * Matched on the `[…_ids][]` tail so one selector covers both the include and
 * the exclude column. The free-text tag fields hold only what the user typed, so
 * there's nothing to hide there.
 */
const SIDEBAR_GROUPS: [key: string, type: TagType][] = [
  ['rating_ids', TagType.Rating],
  ['archive_warning_ids', TagType.ArchiveWarning],
  ['category_ids', TagType.Category],
  ['fandom_ids', TagType.Fandom],
  ['relationship_ids', TagType.Relationship],
  ['character_ids', TagType.Character],
  ['freeform_ids', TagType.Freeform],
]

/**
 * Hides the tags themselves for filters set to `'hideFilter'` — noise tags like
 * "Story" or "<character> is a jerk" that say nothing about whether you want the
 * work. Wherever such a tag is listed it's taken out of the page: a work's tag
 * list (blurbs and the work's own meta) and the "Sort and Filter" sidebar's
 * include/exclude lists. The work itself is untouched — that's HideWorks' job,
 * and `hideFilter` deliberately takes no part in it (see `ruleAffectsWorks`).
 *
 * The search view has no DOM sidebar to walk; its facet rows are filtered from
 * the same rules by `makeFacetHider` (searchView/decorate.ts).
 */
export class HideFilters extends Unit {
  static override get name() { return 'HideFilters' }
  override get enabled() { return this.options.rules.enabled }

  static override async clean(): Promise<void> {
    // Both classes sit on native page elements, so the generic ADDON_CLASS
    // cleanup won't catch them — undo them by hand.
    for (const el of document.querySelectorAll(`.${HIDDEN_CLASS}`))
      el.classList.remove(HIDDEN_CLASS)
    for (const el of document.querySelectorAll(`.${LAST_VISIBLE_CLASS}`))
      el.classList.remove(LAST_VISIBLE_CLASS)
  }

  override async ready(): Promise<void> {
    const filters = this.options.rules.filters.filter(f => f.behavior === 'hideFilter')
    if (filters.length === 0)
      return

    const count = this.hideTagLinks(filters) + this.hideSidebarRows(filters)
    this.logger.debug(`Hid ${count} tags.`)
  }

  /** Hide matching tags in every tag list under `root`. Returns how many. */
  private hideTagLinks(filters: Rule[]): number {
    // Lists we hid something in, so their trailing comma can be fixed up after.
    const lists = new Set<HTMLElement>()
    let count = 0

    for (const el of this.root.querySelectorAll(TAG_SELECTOR)) {
      const name = el.textContent?.trim()
      if (!name)
        continue
      const tag: Tag = { ...getTagFromElement(el), name }
      if (!filters.some(f => ruleMatchesTag(f, tag)))
        continue

      // Take out the whole list item when there is one (so its separator goes
      // too); a fandom heading lists its links bare, so hide the link itself.
      const item = el.closest<HTMLElement>(TAG_ITEM_SELECTOR)
      ;(item ?? el).classList.add(HIDDEN_CLASS)
      if (item?.parentElement)
        lists.add(item.parentElement)
      count++
    }

    // AO3 draws the separators with `li:after`, and suppresses it on the last
    // child — which may now be hidden, leaving a dangling comma. Mark the last
    // one still showing so it drops its comma too.
    for (const list of lists) {
      const visible = Array.from(list.children).filter(li => !li.classList.contains(HIDDEN_CLASS))
      visible.at(-1)?.classList.add(LAST_VISIBLE_CLASS)
    }

    return count
  }

  /** Hide matching rows in the filter sidebar's include/exclude lists. Returns how many. */
  private hideSidebarRows(filters: Rule[]): number {
    // The sidebar is page furniture, not part of a blurb — skip it when we're
    // scoped to one (the search view decorating a single freshly scraped work).
    if (!(this.root instanceof Document))
      return 0

    let count = 0
    for (const [key, type] of SIDEBAR_GROUPS) {
      for (const input of this.root.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][name$="[${key}][]"]`)) {
        // Never hide a filter the user has actually turned on — a checked box
        // that vanished would be an invisible constraint on their results.
        if (input.checked)
          continue
        const name = checkboxTagName(input)
        if (!name || !filters.some(f => ruleMatchesTag(f, { name, type })))
          continue
        const row = input.closest<HTMLElement>('li') ?? input.closest<HTMLElement>('label') ?? input
        row.classList.add(HIDDEN_CLASS)
        count++
      }
    }
    return count
  }
}
