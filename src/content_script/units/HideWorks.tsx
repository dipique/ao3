import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiEye from '~icons/mdi/eye.jsx'
import MdiMinusCircle from '~icons/mdi/minus-circle.jsx'

import { type Tag, type TagFilter, TagType } from '#common'
import { ADDON_CLASS, authorFilterMatchesAuthor, tagFilterMatchesTag } from '#common'
import {
  type CheckboxGroup,
  hasCheckboxGroupFields,
  hasFandomFilterFields,
  hasTagFilterFields,
  isCheckboxGroupSelected,
  isFandomSelected,
  isTagSelected,
  loadFandomIdLookup,
  onFilterChange,
  resetFilterSidebarCaches,
  resolveFandomIdSync,
  resolveFandomIdWithFetch,
  toggleCheckboxGroupFilter,
  toggleFandomFilter,
  toggleTagFilter,
} from '#content_script/filterSidebar.js'
import { Unit } from '#content_script/Unit.js'
import { getTagFromElement } from '#content_script/utils.js'
import React from '#dom'

const BLURB_WRAPPER_CLASS = `${ADDON_CLASS}--hide-works--wrapper`
const REASONS_CLASS = `${ADDON_CLASS}--hide-works--reasons`
const LABEL_CLASS = `${ADDON_CLASS}--hide-works--reason-label`
const VALUE_CLASS = `${ADDON_CLASS}--hide-works--reason-value`
const EXCLUDE_CLASS = `${ADDON_CLASS}--hide-works--exclude`
const EXCLUDE_ACTIVE_CLASS = `${ADDON_CLASS}--hide-works--exclude-active`

/** A blurb tag, plus the fandom link href (needed to resolve a fandom's id). */
type BlurbTag = Tag & { href?: string }

interface Blurb {
  language?: string | null
  fandoms: string[]
  authors: { userId: string, pseud?: string }[]
  tags: BlurbTag[]
}

/**
 * Where an inline "exclude" button adds the value in the filter sidebar:
 * - `tag`: text tags (relationship/character/freeform), by name.
 * - `fandom`: id-based, resolved from the name/href.
 * - `checkbox`: a fixed group (rating/warning/category) whose full set of
 *   checkboxes is always present, matched by name.
 */
type ExcludeTarget
  = | { kind: 'tag', name: string }
    | { kind: 'fandom', name: string, href?: string }
    | { kind: 'checkbox', group: CheckboxGroup, name: string }

interface ReasonItem {
  /** The actual matched value (tag/fandom/author/language) to display. */
  value: string
  /**
   * Human description of the rule that matched, shown on hover (and as the
   * primary text when "show matched values" is off).
   */
  rule: string
  /** If set, an inline exclude button is offered for this value. */
  exclude?: ExcludeTarget
}

/** Reason items grouped by display label, e.g. `Relationship` -> [items]. */
type HideReasons = Record<string, ReasonItem[]>

/**
 * Which categories of filter contributed to hiding a work. Recorded on the
 * blurb (as `data-ao3e-hidden-by`) so the floating filter toolbar can reveal
 * just the works hidden by, say, tag filters.
 */
type HideKind = 'tags' | 'authors' | 'crossovers' | 'languages'

function addReason(reasons: HideReasons, label: string, item: ReasonItem) {
  if (!(label in reasons))
    reasons[label] = []
  reasons[label]!.push(item)
}

// ---------------------------------------------------------------------------
// Inline exclude buttons. Registered across all hidden works on the page so a
// filter change made anywhere (here, or a tag/fandom toolbar) re-syncs them.
// ---------------------------------------------------------------------------

const excludeButtons: { button: HTMLButtonElement, target: ExcludeTarget }[] = []

const CHECKBOX_GROUP_NOUNS: Record<CheckboxGroup, string> = {
  rating: 'rating',
  archive_warning: 'warning',
  category: 'category',
}

function excludeNoun(target: ExcludeTarget): string {
  switch (target.kind) {
    case 'fandom': return 'fandom'
    case 'checkbox': return CHECKBOX_GROUP_NOUNS[target.group]
    default: return 'tag'
  }
}

function setExcludeButtonState(button: HTMLButtonElement, target: ExcludeTarget, selected: boolean): void {
  button.classList.toggle(EXCLUDE_ACTIVE_CLASS, selected)
  button.setAttribute('aria-pressed', String(selected))
  const label = selected
    ? `Remove "${target.name}" from the excluded ${excludeNoun(target)}s`
    : `Exclude "${target.name}" from the results`
  button.title = label
  button.setAttribute('aria-label', label)
}

function excludeTargetSelected(target: ExcludeTarget): boolean {
  switch (target.kind) {
    case 'tag':
      return isTagSelected('exclude', target.name)
    case 'checkbox':
      return isCheckboxGroupSelected('exclude', target.group, target.name)
    case 'fandom': {
      const id = resolveFandomIdSync(target.name)
      return id != null && isFandomSelected('exclude', id)
    }
  }
}

function refreshExcludeButtons(): void {
  for (const { button, target } of excludeButtons)
    setExcludeButtonState(button, target, excludeTargetSelected(target))
}

// Registered once; iterating an empty registry between page runs is a no-op.
onFilterChange(refreshExcludeButtons)

export class HideWorks extends Unit {
  static override get name() { return 'HideWorks' }
  override get enabled() {
    return (
      this.options.hideCrossovers.enabled
      || this.options.hideLanguages.enabled
      || this.options.hideAuthors.enabled
      || this.options.hideTags.enabled
    )
  }

  static override async clean(): Promise<void> {
    excludeButtons.length = 0
    resetFilterSidebarCaches()
    const wrappers = document.querySelectorAll(`.${BLURB_WRAPPER_CLASS}`)
    this.logger.debug('Cleaning wrappers', wrappers)
    for (const wrapper of wrappers) {
      const parent = wrapper.parentNode! as HTMLLIElement
      delete parent.dataset.ao3eHidden
      delete parent.dataset.ao3eHiddenBy
      wrapper.parentNode!.append(...wrapper.childNodes)
      wrapper.remove()
    }
  }

  override async ready(): Promise<void> {
    this.logger.debug('Hiding works...')
    excludeButtons.length = 0

    const blurbElements = document.querySelectorAll('.blurb')

    let usedFandomExclude = false
    for (const blurbElement of blurbElements) {
      const blurb = getBlurb(blurbElement)
      const { reasons, kinds } = this.processBlurb(blurb)

      if (Object.keys(reasons).length === 0)
        continue

      if (this.hideWork(blurbElement, reasons, kinds))
        usedFandomExclude = true
    }

    // Fandom exclude buttons need the id lookup to show their initial state and
    // to filter on click. Load it lazily, then re-sync any buttons we built.
    if (usedFandomExclude)
      void loadFandomIdLookup().then(refreshExcludeButtons)
  }

  processBlurb(blurb: Blurb): { reasons: HideReasons, kinds: Set<HideKind> } {
    const { options: { hideLanguages, hideAuthors, hideCrossovers, hideTags } } = this
    const reasons: HideReasons = {}
    const kinds = new Set<HideKind>()

    if (
      hideLanguages?.enabled
      && blurb.language
      && !hideLanguages.show.some(e => e.label === blurb.language)
    ) {
      addReason(reasons, 'Language', { value: blurb.language, rule: `Language is "${blurb.language}"` })
      kinds.add('languages')
    }

    if (
      hideCrossovers?.enabled
      && blurb.fandoms.length > hideCrossovers.maxFandoms
    ) {
      addReason(reasons, 'Too many fandoms', {
        value: `${blurb.fandoms.length} fandoms`,
        rule: `More than ${hideCrossovers.maxFandoms} fandoms`,
      })
      kinds.add('crossovers')
    }

    // Highlight filters are purely visual (handled by HighlightTags) and never
    // hide or force-show, so they're excluded from the hide decision here.
    const tagMatches = hideTags?.enabled
      ? blurb.tags.flatMap((tag) => {
          const filter = hideTags.filters.find(f => f.behavior !== 'highlight' && tagFilterMatchesTag(f, tag))
          return filter ? [{ tag, filter }] : []
        })
      : []

    // Highlight-only author filters never hide or force-show (HighlightAuthors
    // handles them), so they're excluded from the hide decision here too.
    const authorMatches = hideAuthors?.enabled
      ? blurb.authors.flatMap((author) => {
          const filter = hideAuthors.filters.find(f => f.behavior !== 'highlight' && authorFilterMatchesAuthor(f, author))
          return filter ? [{ author, filter }] : []
        })
      : []

    // If any matching filter is a force-show rule, the work is not hidden at all
    // — return with no reasons. Tags and authors both express this via behavior.
    const forceShow = tagMatches.some(m => m.filter.behavior === 'invert')
      || authorMatches.some(m => m.filter.behavior === 'invert')
    if (forceShow)
      return { reasons, kinds }

    if (tagMatches.length > 0)
      kinds.add('tags')
    for (const { tag, filter } of tagMatches) {
      const type = filter.type ?? tag.type
      const label = type ? TagType.toDisplayString(type) : 'Tag'
      addReason(reasons, label, {
        value: tag.name,
        rule: describeTagFilter(filter),
        exclude: tagExcludeTarget(tag),
      })
    }

    if (authorMatches.length > 0)
      kinds.add('authors')
    for (const { author, filter } of authorMatches) {
      const value = author.pseud ? `${author.userId} (${author.pseud})` : author.userId
      const rule = filter.pseud ? `Author ${filter.userId} (${filter.pseud})` : `Author ${filter.userId}`
      addReason(reasons, 'Author', { value, rule })
    }

    return { reasons, kinds }
  }

  /**
   * Collapse the work and prepend the reason message. Returns true if it
   * rendered at least one fandom exclude button (so the caller knows to load
   * the fandom id lookup).
   */
  hideWork(blurb: Element, reasons: HideReasons, kinds: Set<HideKind>): boolean {
    this.logger.debug('Hiding:', blurb)
    if (blurb instanceof HTMLElement && kinds.size > 0)
      blurb.dataset.ao3eHiddenBy = [...kinds].join(' ')
    const wrapper = (
      <div class={BLURB_WRAPPER_CLASS} data-ao3e-hidden></div>
    )
    wrapper.append(...blurb.childNodes)
    blurb.append(wrapper)

    // If reasons should not be shown, just hide the entire <li>
    if (!this.options.hideShowReason) {
      (blurb as HTMLLIElement).hidden = true
      return false
    }

    const showValues = this.options.hideShowMatchedValues
    const reasonsNode = this.buildReasons(reasons, showValues)

    const isHiddenSpan: HTMLSpanElement = <span title="This work is hidden."><MdiEyeOff /></span>
    const wasHiddenSpan: HTMLSpanElement = <span title="This work was hidden."><MdiEye /></span>
    const showButtonSpan: HTMLSpanElement = (
      <span>
        <MdiEye />
        {' '}
        Show
      </span>
    )
    const hideButtonSpan: HTMLSpanElement = (
      <span>
        <MdiEyeOff />
        {' '}
        Hide
      </span>
    )
    const toggleButton = <button>{showButtonSpan}</button>
    const msg = (
      <div class={`${ADDON_CLASS}  ${ADDON_CLASS}--hide-works--msg`}>
        <div class={`${ADDON_CLASS}--hide-works--reason-line`}>
          {isHiddenSpan}
          {reasonsNode.node}
        </div>
        <div class="actions">{toggleButton}</div>
      </div>
    )

    toggleButton.addEventListener('click', (e: MouseEvent) => {
      e.preventDefault()
      if (wrapper.dataset.ao3eHidden !== undefined) {
        isHiddenSpan.parentNode!.replaceChild(wasHiddenSpan, isHiddenSpan)
        toggleButton!.replaceChild(hideButtonSpan, showButtonSpan)
        delete wrapper.dataset.ao3eHidden
      }
      else {
        wasHiddenSpan.parentNode!.replaceChild(isHiddenSpan, wasHiddenSpan)
        toggleButton!.replaceChild(showButtonSpan, hideButtonSpan)
        wrapper.dataset.ao3eHidden = ''
      }
    })

    blurb.insertBefore(msg, blurb.childNodes[0]!)
    return reasonsNode.usedFandomExclude
  }

  buildReasons(reasons: HideReasons, showValues: boolean): { node: HTMLElement, usedFandomExclude: boolean } {
    const container: HTMLElement = <em class={REASONS_CLASS}></em>
    let usedFandomExclude = false

    Object.entries(reasons).forEach(([label, items], groupIndex) => {
      if (groupIndex > 0)
        container.append(document.createTextNode(' | '))
      container.append(<span class={LABEL_CLASS}>{`${label}: `}</span>)

      items.forEach((item, i) => {
        if (i > 0)
          container.append(document.createTextNode(', '))

        const text = showValues ? item.value : item.rule
        const title = showValues ? item.rule : item.value
        container.append(<span class={VALUE_CLASS} title={title}>{text}</span>)

        const excludeButton = item.exclude ? this.buildExcludeButton(item.exclude) : null
        if (excludeButton) {
          container.append(excludeButton)
          if (item.exclude!.kind === 'fandom')
            usedFandomExclude = true
        }
      })
    })

    return { node: container, usedFandomExclude }
  }

  /**
   * Build an inline exclude button, or null when this page has no matching
   * filter sidebar to add the value to.
   */
  buildExcludeButton(target: ExcludeTarget): HTMLButtonElement | null {
    if (target.kind === 'tag' && !hasTagFilterFields())
      return null
    if (target.kind === 'fandom' && !hasFandomFilterFields())
      return null
    if (target.kind === 'checkbox' && !hasCheckboxGroupFields(target.group))
      return null

    const button = (
      <button type="button" class={EXCLUDE_CLASS} aria-pressed="false">
        <MdiMinusCircle />
      </button>
    ) as HTMLElement as HTMLButtonElement

    setExcludeButtonState(button, target, excludeTargetSelected(target))

    button.addEventListener('click', (e) => {
      e.preventDefault()
      void this.onExcludeClick(button, target)
    })

    excludeButtons.push({ button, target })
    return button
  }

  async onExcludeClick(button: HTMLButtonElement, target: ExcludeTarget): Promise<void> {
    if (target.kind === 'tag') {
      if (!toggleTagFilter('exclude', target.name))
        this.logger.warn(`No exclude field for tag "${target.name}"; cannot update filter.`)
      return
    }

    if (target.kind === 'checkbox') {
      if (!toggleCheckboxGroupFilter('exclude', target.group, target.name))
        this.logger.warn(`No exclude checkbox for ${target.group} "${target.name}"; cannot update filter.`)
      return
    }

    // Fandoms filter by id, which may require an async lookup/fetch.
    button.disabled = true
    await loadFandomIdLookup()
    let id = resolveFandomIdSync(target.name)
    if (id == null && target.href)
      id = await resolveFandomIdWithFetch(target.name, target.href)
    button.disabled = false

    if (id == null) {
      this.logger.warn(`Could not resolve an id for fandom "${target.name}"; cannot filter.`)
      return
    }
    toggleFandomFilter('exclude', id, target.name)
  }
}

function getBlurb(blurbElement: Element): Blurb {
  const language = blurbElement.querySelector('dd.language')?.textContent

  const fandoms = Array.from(blurbElement.querySelectorAll('.fandoms a')).map(
    fandom => fandom.textContent!,
  )

  const authors = Array.from(
    blurbElement.querySelectorAll('.heading a[rel=author]'),
  ).map((author) => {
    const parts = new URL(author.href).pathname.split('/')
    return {
      userId: parts[2]!,
      pseud: parts[4],
    }
  })

  const tags: BlurbTag[] = [
    ...Array.from(blurbElement.querySelector('.required-tags .rating')?.textContent?.split(',') || []).map(name => ({
      name: name.trim(),
      type: 'r' as TagType,
    })),
    ...Array.from(blurbElement.querySelector('.required-tags .category')?.textContent?.split(',') || []).map(name => ({
      name: name.trim(),
      type: 'c' as TagType,
    })),
    ...Array.from(blurbElement.querySelectorAll('.fandoms .tag')).map(tag => ({
      name: tag.textContent!,
      type: 'f' as TagType,
      href: tag instanceof HTMLAnchorElement ? tag.href : undefined,
    })),
    ...Array.from(
      blurbElement.querySelectorAll(':not(.own) > ul.tags .tag'),
    ).map((tag) => {
      return getTagFromElement(tag)
    }),
  ]

  return { language, fandoms, authors, tags }
}

/** Human description of a tag filter's matching rule, for hover/rule display. */
function describeTagFilter(filter: TagFilter): string {
  switch (filter.matcher) {
    case 'contains':
      return `contains "${filter.name}"`
    case 'regex':
      return `matches /${filter.name}/`
    default:
      return `"${filter.name}"`
  }
}

/** Where a matched tag should be added if the user clicks its exclude button. */
function tagExcludeTarget(tag: BlurbTag): ExcludeTarget | undefined {
  switch (tag.type) {
    // Fandoms are filtered by id (resolved from the name and link).
    case TagType.Fandom:
      return { kind: 'fandom', name: tag.name, href: tag.href }
    // Ratings, warnings and categories have a fixed set of exclude checkboxes
    // present on every works-filter page, matched by name.
    case TagType.Rating:
      return { kind: 'checkbox', group: 'rating', name: tag.name }
    case TagType.ArchiveWarning:
      return { kind: 'checkbox', group: 'archive_warning', name: tag.name }
    case TagType.Category:
      return { kind: 'checkbox', group: 'category', name: tag.name }
    // Relationships, characters, additional tags (and untyped tags) are
    // excludable by name through the excluded-tag-names field.
    default:
      return { kind: 'tag', name: tag.name }
  }
}
