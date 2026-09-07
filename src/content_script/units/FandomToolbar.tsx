import type { Tag } from '#common'
import type { FilterTarget } from '#content_script/filterTarget.js'
import type { TagLinkEntry } from '#content_script/tagLinkToolbar.js'

import { TagType } from '#common'
import { clearMenuTriggers } from '#content_script/contextTrigger.js'
import {
  loadFandomIdLookup,
  resetFilterSidebarCaches,
  scrapeSidebar,
} from '#content_script/filterSidebar.js'
import { nativeFandomTarget, onFilterTargetChange } from '#content_script/filterTarget.js'
import { findFacetBridge } from '#content_script/searchView/facetBridge.ts'
import { syncTagLinkEntries, TagLinkToolbar } from '#content_script/tagLinkToolbar.js'

/**
 * Blurb fandom links. Unlike the text-based tags handled by TagToolbar, the
 * sidebar filters fandoms by numeric id, so include/exclude must resolve each
 * displayed name to an id first — the one thing the in-memory search view's
 * fandom facet doesn't need, since it filters the works it already holds by
 * name. Hide / always-show / highlight, however, are persistent rules keyed by
 * name (target {@link TagType.Fandom}), so they need no id and work on any page.
 */
const FANDOM_LINK_SELECTOR = 'h5.fandoms a.tag'

const entries: TagLinkEntry[] = []

onFilterTargetChange(() => syncTagLinkEntries(entries))

export class FandomToolbar extends TagLinkToolbar {
  static override get name() { return 'FandomToolbar' }
  override get enabled() { return this.options.fandomToolbar }

  protected override get noun() { return 'fandom' }
  protected override get selector() { return FANDOM_LINK_SELECTOR }
  protected override get entries() { return entries }

  /** The sidebar's fandom filter, or null when this run has no use for it. */
  private nativeFilter: FilterTarget | null = null

  static override async clean(): Promise<void> {
    entries.length = 0
    clearMenuTriggers()
    resetFilterSidebarCaches()
  }

  protected override async prepare(links: HTMLAnchorElement[]): Promise<void> {
    // Inside a search view the facet bridge filters by name, so the whole id
    // apparatus is beside the point; on a native listing include/exclude needs
    // the lookup, while hide/highlight (by name) never does.
    const bridged = !!findFacetBridge(links[0]!)
    this.nativeFilter = bridged ? null : nativeFandomTarget()
    if (this.nativeFilter) {
      await loadFandomIdLookup()
      scrapeSidebar()
    }
  }

  protected override nativeTargetFor(link: HTMLAnchorElement): FilterTarget | null {
    // The native fallback carries this link's href, so a fandom missing from the
    // index can still be resolved from its own page on first use.
    return this.nativeFilter && nativeFandomTarget(link.href)
  }

  protected override tagFor(_link: HTMLAnchorElement, name: string): Tag {
    return { name, type: TagType.Fandom }
  }
}
