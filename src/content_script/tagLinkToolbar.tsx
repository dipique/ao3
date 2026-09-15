import type { FilterBehavior, Tag } from '#common'

import { options, ruleTargetColor } from '#common'

import type { MenuItem } from './contextMenu.tsx'
import type { IndicatorState } from './contextTrigger.tsx'
import type { FilterTarget } from './filterTarget.tsx'
import type { FacetKey } from './searchView/engine.ts'

import { attachMenuTrigger, buildIndicators, existingIndicator, standardLinkItems } from './contextTrigger.js'
import { activeFilterDirs, facetForTagType, filterMenuItems, filterTargetFor } from './filterTarget.js'
import { ruleBehavior, ruleIndicatorBehavior, tagKey } from './persistentFilters.js'
import { ruleBehaviorItems } from './ruleMenuItems.tsx'
import { Unit } from './Unit.js'

/**
 * The shared half of the toolbars that decorate a *tag link* — a link standing
 * for a {@link Tag} that the reader can filter on and write a rule about.
 * `TagToolbar` (the text-based tags under a blurb) and `FandomToolbar` (the
 * id-based fandoms in `h5.fandoms`) are both this, and differ only in which
 * links they claim, how a link becomes a `Tag`, and what the page's own sidebar
 * can do with one — which is exactly what {@link TagLinkToolbar}'s abstract
 * members ask for.
 *
 * Author, work and series toolbars are deliberately *not* here: they decorate
 * links that aren't tags, carry state of their own (subscriptions, marks,
 * reading progress), and share only the rule rows — which live in
 * `ruleMenuItems.tsx`, and which this module builds its menus from too.
 */

/**
 * A decorated tag link: the link itself (a menu trigger), the parsed tag, its
 * persistent hide/show/highlight behaviour (snapshot from options this run), the
 * filter its include/exclude rows drive (the search view the blurb sits in, else
 * the page's sidebar — null when neither can filter this tag), and the indicator
 * node currently shown after it (or null when nothing is active). Rebuilt each
 * `ready()`; the ephemeral include/exclude part is re-synced on filter change.
 */
export interface TagLinkEntry {
  link: HTMLAnchorElement
  tag: Tag
  behavior: FilterBehavior | null
  highlightColor: string
  filter: FilterTarget | null
  indicator: HTMLElement | null
  /**
   * Names this link's kind in its menu labels ("Hide tag" / "Hide fandom"). Kept
   * on the entry rather than read off the unit so an entry is enough to rebuild
   * its own menu — which is what the filter-change re-sync does, from module
   * scope, with no unit in hand.
   */
  noun: string
}

function computeStates(entry: TagLinkEntry): IndicatorState[] {
  const states: IndicatorState[] = activeFilterDirs(entry.filter, entry.tag.name)
  const behavior = ruleIndicatorBehavior(entry.behavior)
  if (behavior)
    states.push(behavior)
  return states
}

/** Build the tag's menu fresh at open time (so include/exclude + saved state are current). */
export async function buildTagLinkMenu(entry: TagLinkEntry): Promise<MenuItem[]> {
  const items: MenuItem[] = filterMenuItems(entry.filter, entry.tag.name)

  const { filters } = await options.get('rules')
  const key = tagKey(entry.tag)
  items.push(...ruleBehaviorItems(key, ruleBehavior(filters, key), { noun: entry.noun }))

  items.push(...standardLinkItems(entry.link))
  return items
}

/** Insert/replace/remove a tag's indicator to match its current active states. */
export function syncTagLinkIndicator(entry: TagLinkEntry): void {
  const states = computeStates(entry)
  const next = buildIndicators(states, { highlightColor: entry.highlightColor })
  if (next)
    attachMenuTrigger(next, () => buildTagLinkMenu(entry), { indicator: true, link: entry.link })

  if (entry.indicator && next)
    entry.indicator.replaceWith(next)
  else if (entry.indicator && !next)
    entry.indicator.remove()
  else if (!entry.indicator && next)
    entry.link.after(next)

  entry.indicator = next
}

/**
 * Re-sync a whole registry — what each unit hands `onFilterTargetChange`, so the
 * include/exclude indicators follow any control that mutates the filter (AO3's
 * sidebar or a search view's facets). Registered once per unit; a no-op over an
 * empty registry between page runs.
 */
export function syncTagLinkEntries(entries: TagLinkEntry[]): void {
  for (const entry of entries)
    syncTagLinkIndicator(entry)
}

export abstract class TagLinkToolbar extends Unit {
  /** Names this toolbar's links in menu labels and logs — "tag", "fandom". */
  protected abstract get noun(): string
  /** The links this toolbar claims. */
  protected abstract get selector(): string
  /** Live registry of this toolbar's decorated links, shared across page runs. */
  protected abstract get entries(): TagLinkEntry[]
  /** The tag a link stands for, or null to leave the link alone. `name` is pre-trimmed. */
  protected abstract tagFor(link: HTMLAnchorElement, name: string): Tag | null

  /** Per-run setup, once the run is known to have links to decorate. */
  protected async prepare(_links: HTMLAnchorElement[]): Promise<void> {}

  /**
   * The page's own sidebar filter for this link, used only when the link isn't
   * inside a search view. Null when this toolbar's tags have no sidebar field.
   */
  protected nativeTargetFor(_link: HTMLAnchorElement): FilterTarget | null { return null }

  /** The search-view facet this tag feeds, when the engine has one for its type. */
  protected facetFor(tag: Tag): FacetKey | null { return facetForTagType(tag.type) }

  override async ready(): Promise<void> {
    const { entries } = this
    entries.length = 0

    const links = [...this.root.querySelectorAll<HTMLAnchorElement>(this.selector)]
    if (links.length === 0)
      return

    await this.prepare(links)

    const { filters, colors } = this.options.rules

    for (const link of links) {
      const name = link.textContent?.trim()
      if (!name)
        continue
      const tag = this.tagFor(link, name)
      if (!tag)
        continue

      const entry: TagLinkEntry = {
        link,
        tag,
        behavior: ruleBehavior(filters, tagKey(tag)),
        // The star's colour follows the tag's own type, so a highlighted
        // relationship can read differently from a highlighted freeform.
        highlightColor: ruleTargetColor(tag.type ?? 'tag', colors),
        filter: filterTargetFor(link, this.facetFor(tag), this.nativeTargetFor(link)),
        indicator: existingIndicator(link),
        noun: this.noun,
      }
      entries.push(entry)

      attachMenuTrigger(link, () => buildTagLinkMenu(entry), { clickToOpen: this.options.openMenuOnClick })
      syncTagLinkIndicator(entry)
    }

    this.logger.debug(`Added ${this.noun} menus to ${entries.length} ${this.noun} links.`)
  }
}
