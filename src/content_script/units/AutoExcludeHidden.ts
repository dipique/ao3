import type { Rule, Tag } from '#common'

import { TagType, toast } from '#common'
import { getBlurb } from '#content_script/blurb.js'
import { hasFilterSidebar, loadFandomIdLookup } from '#content_script/filterSidebar.js'
import { nativeTargetForTag } from '#content_script/filterTarget.js'
import { findFacetBridge } from '#content_script/searchView/facetBridge.js'
import { Unit } from '#content_script/Unit.js'

import type { ExcludeTarget } from './HideWorks.tsx'

import { hideVerdict } from './HideWorks.tsx'

/**
 * Narrow AO3's own search to match the reader's rules, so the archive stops
 * sending works they never see.
 *
 * A hide rule is applied to results that have already arrived, twenty to a page —
 * which is why a listing can turn up with nineteen works taken out of it and one
 * left, and why the only fix has been to type the same exclusions into the Sort
 * and Filter sidebar by hand. This unit does that typing: every value that hid a
 * work outright is ticked in the sidebar, so the *next* search never fetches
 * those works at all.
 *
 * Three deliberate limits, in the order they bite:
 *
 * - Only works a rule **hides** count. A collapsed work is still on the page on
 *   purpose, and excluding what it carries would take it away for good.
 * - Only rules count. Marks, the crossover filter and the language filter are the
 *   reader's own bookkeeping (and language has {@link Options.hideLanguages}'s
 *   own "also filter searches" switch), not something to ask AO3 about.
 * - A value still carried by a work left on screen is never excluded. That is
 *   what an "always show" rule looks like from here: the work is in the listing
 *   because the reader overruled the hide, and an archive-side exclusion would
 *   quietly take it back.
 *
 * Beyond that, only exclusions AO3 is already offering are ticked — a checkbox
 * in the sidebar for that rating, warning, category, fandom or tag. The one
 * exception is the case a reader most often means: an **exact Additional Tags
 * rule**, whose value is a whole tag name and nothing else, is typed into the
 * "excluded tags" field even when the sidebar never listed it.
 *
 * Nothing is submitted. The sidebar is filled in and the reader presses Sort and
 * Filter when they're ready — the toast says so, since a filled-in form in a
 * collapsed sidebar is otherwise invisible.
 *
 * Inside one of our own search views this unit does nothing: the view weighs
 * every work it holds, not just the page on screen, so its exclusions are worked
 * out there instead (see {@link file://../searchView/hidden.ts}).
 */
export class AutoExcludeHidden extends Unit {
  static override get name() { return 'AutoExcludeHidden' }

  override get enabled(): boolean {
    return this.options.autoExcludeHidden && this.options.rules.enabled
  }

  /**
   * Nothing to undo. What this unit leaves behind is filter state the reader is
   * about to submit — ticked boxes and typed tag names, indistinguishable from
   * their own — and a re-run would only put it back. Re-running is safe anyway:
   * a value already excluded is left alone rather than toggled off.
   */
  static override async clean(): Promise<void> {}

  override async ready(): Promise<void> {
    if (!hasFilterSidebar())
      return

    /** The exclusions to make: the value, and the rule that asked for it. */
    const pending = new Map<string, { target: ExcludeTarget, rule: Rule }>()
    /** Values carried by a work still on the page — off limits; see the class doc. */
    const kept = new Set<string>()

    for (const el of this.root.querySelectorAll('.blurb')) {
      // A blurb inside a search view answers to that view's filter, which the
      // view has already settled over its whole set.
      if (findFacetBridge(el))
        continue

      const blurb = getBlurb(el)
      const { mode, excludes } = hideVerdict(blurb, this.options)
      if (mode !== 'hide') {
        for (const tag of blurb.tags)
          kept.add(valueKey(tag))
        continue
      }
      for (const { target, rule } of excludes) {
        if (!target || !rule)
          continue
        const key = valueKey(target)
        if (!pending.has(key))
          pending.set(key, { target, rule })
      }
    }

    for (const key of kept) {
      if (pending.delete(key))
        this.logger.debug(`Not excluding "${key}" — a work still shown carries it.`)
    }
    if (pending.size === 0)
      return

    // The sidebar filters fandoms by numeric id, so nothing can be said about
    // one — not even whether it is already excluded — until the lookup is in.
    if ([...pending.values()].some(({ target }) => target.type === TagType.Fandom))
      await loadFandomIdLookup()

    let applied = 0
    for (const { target, rule } of pending.values()) {
      // Straight to the native sidebar: the blurbs that answer to a search view
      // were skipped above, so there is no bridge left to prefer over it.
      const filter = nativeTargetForTag(target, target.href)
      if (!filter)
        continue
      // Already excluded, or deliberately filtered *for* — either way the reader
      // (or an earlier run of this) has spoken, and toggling would undo it.
      if (filter.isSelected('exclude', target.name) || filter.isSelected('include', target.name))
        continue
      if (!filter.hasControl('exclude', target.name) && !namesAWholeTag(rule))
        continue
      filter.toggle('exclude', target.name)
      // Counted from what actually moved rather than from the attempt: a page
      // offering only half a filter form (an include field with no exclude one)
      // takes the call and changes nothing, and a toast about it would be a lie.
      if (filter.isSelected('exclude', target.name))
        applied++
    }

    if (applied > 0) {
      this.logger.debug(`Excluded ${applied} value(s) hidden by rules from the filter.`)
      toast(
        `Excluded ${applied} hidden ${applied === 1 ? 'value' : 'values'} from the filter. Re-run the search to apply.`,
        { type: 'success' },
      )
    }
  }
}

/**
 * Whether a rule's value is a whole Additional Tags name — the one case where a
 * tag AO3 never offered is still worth typing into the excluded-tags field. A
 * `contains` or `regex` rule matches a shape rather than a tag, so what it hid
 * here says nothing about what it would hide next time.
 */
function namesAWholeTag(rule: Rule): boolean {
  return rule.target === TagType.Freeform && rule.matcher === 'exact'
}

/** A tag as one string, so a Set can hold "this name, of this type". */
function valueKey(tag: Tag): string {
  return `${tag.type ?? ''}:${tag.name.toLowerCase()}`
}
