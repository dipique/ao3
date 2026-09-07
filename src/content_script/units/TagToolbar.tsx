import type { Tag } from '#common'
import type { FilterTarget } from '#content_script/filterTarget.js'
import type { TagLinkEntry } from '#content_script/tagLinkToolbar.js'

import { clearMenuTriggers } from '#content_script/contextTrigger.js'
import { resetFilterSidebarCaches } from '#content_script/filterSidebar.js'
import { nativeTagTarget, onFilterTargetChange } from '#content_script/filterTarget.js'
import { syncTagLinkEntries, TagLinkToolbar } from '#content_script/tagLinkToolbar.js'
import { getTagFromElement } from '#content_script/utils.js'

/**
 * Blurb tag links we decorate. These are the text-based tags (relationships,
 * characters, additional tags, warnings) shown under each work — NOT the
 * fandom tags in `h5.fandoms`, which are id-based and handled by FandomToolbar.
 */
const TAG_LINK_SELECTOR = '.blurb ul.tags a.tag'

const entries: TagLinkEntry[] = []

// Re-sync the include/exclude indicators when any control mutates the filter —
// AO3's sidebar or a search view's facets. Registered once; a no-op over an empty
// registry between page runs.
onFilterTargetChange(() => syncTagLinkEntries(entries))

export class TagToolbar extends TagLinkToolbar {
  static override get name() { return 'TagToolbar' }
  override get enabled() { return this.options.tagToolbar }

  protected override get noun() { return 'tag' }
  protected override get selector() { return TAG_LINK_SELECTOR }
  protected override get entries() { return entries }

  /**
   * The sidebar's text-tag fields, resolved once per run: the lookup behind it is
   * page-wide, and a run covers one page (or one search view) at a time.
   */
  private nativeFilter: FilterTarget | null = null

  static override async clean(): Promise<void> {
    entries.length = 0
    clearMenuTriggers()
    resetFilterSidebarCaches()
  }

  protected override async prepare(): Promise<void> {
    this.nativeFilter = nativeTagTarget()
  }

  protected override nativeTargetFor(): FilterTarget | null {
    return this.nativeFilter
  }

  protected override tagFor(link: HTMLAnchorElement, name: string): Tag {
    // getTagFromElement reads the (untrimmed) link text; match the trimmed name
    // used when persistent filters are saved.
    return { ...getTagFromElement(link), name }
  }
}
