import type { Tag } from '#common'

import { TagType, toast } from '#common'
import { getBlurb } from '#content_script/blurb.js'
import { hasFilterSidebar, loadFandomIdLookup, resolveFandomIdSync } from '#content_script/filterSidebar.js'
import { nativeTargetForTag } from '#content_script/filterTarget.js'
import { findFacetBridge } from '#content_script/searchView/facetBridge.js'
import { Unit } from '#content_script/Unit.js'

import type { ExcludeTarget } from './HideWorks.tsx'

import { hideVerdict } from './HideWorks.tsx'

/**
 * The values (see {@link valueKey}) this page has already had its say about.
 *
 * Every options change re-runs every unit, and picking a rule from a context menu
 * is one. Once a value has been excluded it's the reader's: unticking it before
 * they search is a decision, and a re-run that ticked it again — or ticked a
 * different value to take the same work out — would quietly overrule them. So a
 * hidden work carrying a value weighed earlier counts as dealt with. A work that
 * only turns up hidden later, by the rule just added, is still new, which is the
 * case a re-run is for.
 */
const handled = new Set<string>()

/**
 * Narrow AO3's own search to match the reader's rules, so the archive stops
 * sending works they never see.
 *
 * A hide rule is applied to results that have already arrived, twenty to a page —
 * which is why a listing can turn up with nineteen works taken out of it and one
 * left, and why the only fix has been to type the same exclusions into the Sort
 * and Filter sidebar by hand. This unit does that typing: each work a rule hid
 * outright gets **one** exclusion in the sidebar, so the *next* search never
 * fetches it at all.
 *
 * One per work, and no more, because a rule is a shape rather than a list: a
 * "contains torture" rule matches a different handful of tags on every page, and
 * excluding all of them would grow the query without bound. Any one of a hidden
 * work's matched values is enough to keep that work out, so the unit takes the
 * first that will do — in the order {@link hideVerdict} reports them — and a
 * work that is already covered, because one of its values is excluded (by an
 * earlier work on this page, or by the reader), adds nothing.
 *
 * Limits on what that one exclusion may be, in the order they bite:
 *
 * - Only works a rule **hides** count. A collapsed work is still on the page on
 *   purpose, and excluding what it carries would take it away for good.
 * - Only rules count. Marks, the crossover filter and the language filter are the
 *   reader's own bookkeeping (and language has {@link Options.hideLanguages}'s
 *   own "also filter searches" switch), not something to ask AO3 about. A work
 *   they hid can still be excluded by a rule that hid it as well.
 * - A value still carried by a work left on screen is never excluded. That is
 *   what an "always show" rule looks like from here: the work is in the listing
 *   because the reader overruled the hide, and an archive-side exclusion would
 *   quietly take it back.
 * - A value the reader is filtering *for* is never excluded.
 * - The sidebar has to be able to say it — see {@link canExclude}.
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
   * their own. A re-run doesn't put it back either: see {@link handled}.
   */
  static override async clean(): Promise<void> {}

  override async ready(): Promise<void> {
    if (!hasFilterSidebar())
      return

    /** Per hidden work, the values a rule hid it by, in the verdict's order. */
    const hidden: Candidate[][] = []
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
      const candidates: Candidate[] = []
      for (const { target, rule } of excludes) {
        if (target && rule)
          candidates.push({ key: valueKey(target), target })
      }
      if (candidates.length > 0)
        hidden.push(candidates)
    }
    if (hidden.length === 0)
      return

    // The sidebar filters fandoms by numeric id, so nothing can be said about
    // one — not even whether it is already excluded — until the lookup is in.
    if (hidden.some(candidates => candidates.some(({ target }) => target.type === TagType.Fandom)))
      await loadFandomIdLookup()

    let applied = 0
    for (const candidates of hidden) {
      const open = candidates.filter(({ key }) => !kept.has(key))
      // Already on its way out: one of its values is excluded — by an earlier
      // work on this page, or by the reader — or was weighed on an earlier run.
      if (open.some(({ key }) => handled.has(key)) || candidates.some(isExcluded))
        continue

      for (const { key, target } of open) {
        // Straight to the native sidebar: the blurbs that answer to a search view
        // were skipped above, so there is no bridge left to prefer over it.
        const filter = nativeTargetForTag(target, target.href)
        if (!filter || !canExclude(target, filter.hasControl('exclude', target.name)))
          continue
        // Deliberately filtered *for* — the reader has spoken; try the next value.
        if (filter.isSelected('include', target.name))
          continue
        filter.toggle('exclude', target.name)
        // Checked rather than assumed: a page offering only half a filter form
        // (an include field with no exclude one) takes the call and changes
        // nothing, and then the work still needs one of its other values.
        if (filter.isSelected('exclude', target.name)) {
          handled.add(key)
          applied++
          break
        }
      }
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

/** One value a rule hid a work by, and its {@link valueKey}. */
interface Candidate {
  key: string
  target: ExcludeTarget
}

/** Whether the sidebar already excludes this value. */
function isExcluded({ target }: Candidate): boolean {
  return nativeTargetForTag(target, target.href)?.isSelected('exclude', target.name) ?? false
}

/**
 * Whether the sidebar can exclude this value right now, synchronously — a
 * control it already offers, or one of the two things it can be told about:
 *
 * - any tag it filters by name (additional tags, characters, relationships,
 *   untyped tags) is typed into the "excluded tags" field;
 * - a fandom whose id is already known gets a checkbox injected. One that would
 *   have to be fetched is passed over: the fetch would land after this work had
 *   moved on to its next value, and tick a second exclusion for it.
 *
 * Rating, warning and category are a fixed set of boxes — no box, no exclusion.
 */
function canExclude(target: ExcludeTarget, hasControl: boolean): boolean {
  if (hasControl)
    return true
  switch (target.type) {
    case TagType.Rating:
    case TagType.ArchiveWarning:
    case TagType.Category:
      return false
    case TagType.Fandom:
      return resolveFandomIdSync(target.name) != null
    default:
      return true
  }
}

/** A tag as one string, so a Set can hold "this name, of this type". */
function valueKey(tag: Tag): string {
  return `${tag.type ?? ''}:${tag.name.toLowerCase()}`
}
