import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiEye from '~icons/mdi/eye.jsx'
import MdiMinusCircle from '~icons/mdi/minus-circle.jsx'

import type { MarkId, Options, ProgressSource, Rule } from '#common'

import { ADDON_CLASS, describeProgress, findProgress, hiddenByMarks, hiddenLabel, markHidesResults, marksHideAnything, progressSources, readiness, ruleAffectsWorks, ruleMatchesAuthor, ruleMatchesEntity, ruleMatchesTag, rulePriority, ruleTargetLabel, TagType, todayEpochDays } from '#common'
import { type Blurb, type BlurbTag, getBlurb } from '#content_script/blurb.js'
import { attachPopoverTrigger, clearMenuTriggers } from '#content_script/contextTrigger.js'
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
import { markIcon } from '#content_script/markIcons.js'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const BLURB_WRAPPER_CLASS = `${ADDON_CLASS}--hide-works--wrapper`
const REASONS_CLASS = `${ADDON_CLASS}--hide-works--reasons`
const LABEL_CLASS = `${ADDON_CLASS}--hide-works--reason-label`
const REASON_ICON_CLASS = `${ADDON_CLASS}--hide-works--reason-icon`
const VALUE_CLASS = `${ADDON_CLASS}--hide-works--reason-value`
const EXCLUDE_CLASS = `${ADDON_CLASS}--hide-works--exclude`
const EXCLUDE_ACTIVE_CLASS = `${ADDON_CLASS}--hide-works--exclude-active`

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
  /** Icon shown before this reason's group label. */
  icon?: () => Node
}

/** Reason items grouped by display label, e.g. `Relationship` -> [items]. */
type HideReasons = Record<string, ReasonItem[]>

/**
 * Which categories of rule contributed to hiding a work. Recorded on the blurb
 * (as `data-ao3e-hidden-by`) so the floating filter toolbar can reveal just the
 * works hidden by, say, tag rules.
 */
type HideKind = 'tags' | 'authors' | 'crossovers' | 'languages' | 'works' | 'series' | 'marks'

/**
 * One reason a work might be hidden, before the priority contest is settled.
 * Reasons that lose to a higher-priority "always show" never reach the reader —
 * saying a work is hidden by a rule that was overruled would be a lie.
 */
interface HideCandidate {
  label: string
  item: ReasonItem
  kind: HideKind
  /** The rule's effective priority; non-rule hides (language, crossover, marks) sit at 0. */
  priority: number
}

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

/**
 * Everything a run works out from the options before it can weigh a single
 * blurb. Cached against the options object rather than recomputed per unit,
 * because the search view decorates its results one blurb at a time: a page of
 * fifty builds fifty of these units from the same options, and unpacking the
 * mark table fifty times over would be the most expensive thing on that path.
 *
 * Any options change hands out a fresh object and so a fresh entry — `today`
 * included, which keeps the "fixed for the run, so a listing is consistent"
 * guarantee and merely holds it until the next re-run.
 */
interface RunState {
  hiddenMarks: Map<string, MarkId>
  progress: ProgressSource[]
  today: number
  rules: Rule[]
}

const runStates = new WeakMap<Options, RunState>()

function runState(options: Options): RunState {
  const cached = runStates.get(options)
  if (cached)
    return cached
  const { workMarks } = options
  const state: RunState = {
    hiddenMarks: workMarks.enabled ? hiddenByMarks(workMarks.marks) : new Map(),
    // Only the *hiding* progress marks matter here; one left visible is still
    // tracked and still shows its indicator, it just never collapses a work.
    progress: workMarks.enabled
      ? progressSources(workMarks.marks).filter(source => markHidesResults(workMarks.marks, source.id))
      : [],
    today: todayEpochDays(),
    // Presentational rules are handled elsewhere (HighlightTags colours the tag,
    // HideFilters hides it) and never hide or force-show, so they're dropped here.
    rules: options.rules.enabled ? options.rules.filters.filter(ruleAffectsWorks) : [],
  }
  runStates.set(options, state)
  return state
}

export class HideWorks extends Unit {
  static override get name() { return 'HideWorks' }

  // The four fields below are this run's {@link RunState}, copied out in
  // `ready()` so {@link processBlurb} can weigh a blurb without re-reading
  // options. See {@link runState} for why they're derived once and shared.

  /**
   * Work ids some mark hides, mapped to the mark responsible. Empty unless marks
   * are on and at least one of them hides.
   */
  private hiddenMarks = new Map<string, MarkId>()

  /**
   * The hiding progress marks' entries, unpacked. Separate from
   * {@link hiddenMarks} because carrying a progress mark isn't itself a reason to
   * hide — {@link processBlurb} weighs each work's own progress against the
   * chapter count on its blurb.
   */
  private progress: ProgressSource[] = []

  /** Today, as days since the epoch — fixed for the run so a listing is consistent. */
  private today = 0

  /** The work-affecting rules (hide/always-show; never highlight-only). */
  private rules: Rule[] = []

  override get enabled() {
    return (
      this.options.rules.enabled
      || this.options.hideCrossovers.enabled
      || this.options.hideLanguages.enabled
      || this.marksCanHide
    )
  }

  /**
   * Whether any mark is set to collapse the works carrying it. Goes through
   * {@link marksHideAnything} rather than `hiddenByMarks`, which excludes
   * progress marks — a reader whose only hiding mark is the ongoing one would
   * otherwise have this unit filtered out before `ready()` ever ran.
   */
  private get marksCanHide(): boolean {
    const { workMarks } = this.options
    return workMarks.enabled && marksHideAnything(workMarks.marks)
  }

  static override async clean(): Promise<void> {
    excludeButtons.length = 0
    clearMenuTriggers()
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

  /**
   * The blurbs this run covers. Normally every blurb under the unit's root; when
   * the root *is* a blurb, that blurb alone — the search view decorates its
   * results one at a time, and those blurbs were never on the page for a
   * document-wide scan to have found.
   */
  private rootBlurbs(): Iterable<Element> {
    const { root } = this
    if (root instanceof Element && root.matches('.blurb'))
      return [root]
    return root.querySelectorAll('.blurb')
  }

  override async ready(): Promise<void> {
    this.logger.debug('Hiding works...')
    // A full-page run owns the exclude-button registry and starts it fresh; a
    // per-blurb run only adds to it, or it would drop every button but the last
    // blurb's. (Neither page offering the search view today has a filter
    // sidebar, so in practice it stays empty there — but the view is meant to be
    // reusable on pages that do have one.)
    if (this.root === document)
      excludeButtons.length = 0
    const run = runState(this.options)
    this.hiddenMarks = run.hiddenMarks
    this.progress = run.progress
    this.today = run.today
    this.rules = run.rules

    const blurbElements = this.rootBlurbs()

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

  /**
   * Decide whether a blurb is hidden, and why.
   *
   * Every rule matching the work is weighed by its priority (see `rulePriority`):
   * the strongest "always show" sets the bar, and only hide reasons *above* that
   * bar survive. A tie goes to the force-show — "always show" is a promise, and
   * matching a hide rule of equal strength shouldn't quietly break it. With
   * everything at its default that reproduces the old behaviour exactly
   * (force-show at 4, everything else at 0), while leaving a hide rule at 5+ able
   * to win, and a force-show dropped below 4 able to lose.
   *
   * Hides that aren't rules at all — language, crossover, and marks — weigh 0, so
   * an "always show" still overrules them.
   */
  processBlurb(blurb: Blurb): { reasons: HideReasons, kinds: Set<HideKind> } {
    const { options: { hideLanguages, hideCrossovers, workMarks } } = this
    const reasons: HideReasons = {}
    const kinds = new Set<HideKind>()

    const hides: HideCandidate[] = []
    /** The strongest force-show matching this work; -1 when none does. */
    let bar = -1

    /**
     * Weigh every rule matching one subject: force-shows raise the bar, and the
     * strongest hide becomes that subject's single candidate reason (a tag
     * matching three hide rules is still one thing wrong with the work).
     */
    const weigh = (matched: Rule[]): Rule | undefined => {
      let best: Rule | undefined
      for (const rule of matched) {
        const priority = rulePriority(rule)
        if (rule.behavior === 'invert') {
          if (priority > bar)
            bar = priority
          continue
        }
        if (!best || priority > rulePriority(best))
          best = rule
      }
      return best
    }

    const addHide = (rule: Rule, label: string, kind: HideKind, item: Omit<ReasonItem, 'rule'>) => {
      hides.push({ label, kind, priority: rulePriority(rule), item: { ...item, rule: describeRule(rule) } })
    }

    // Marks first: "you already read this" is the reason you're most likely to
    // want to act on, and a collapsed work hides its own title.
    const markId = blurb.work ? this.hiddenMarks.get(blurb.work.id) : undefined
    if (markId) {
      const config = workMarks.marks[markId]
      hides.push({
        label: config?.label || markId,
        kind: 'marks',
        priority: 0,
        item: {
          value: blurb.work!.name,
          rule: `You marked this work as ${(config?.label || markId).toLowerCase()}`,
          icon: markIcon(config?.icon),
        },
      })
    }

    // An ongoing work is collapsed only while it isn't worth opening — there's
    // nothing new since the reader stopped, or a wait-until date they set hasn't
    // come round yet. Weighed at 0 like every other non-rule hide, so an "always
    // show" rule still overrules it.
    const ongoing = blurb.work ? findProgress(this.progress, blurb.work.id) : null
    if (ongoing) {
      const published = blurb.chapters?.written ?? null
      const state = readiness(ongoing.progress, published, this.today)
      if (state !== 'ready') {
        const config = workMarks.marks[ongoing.id]
        hides.push({
          label: hiddenLabel(state, config?.label || ongoing.id),
          kind: 'marks',
          priority: 0,
          item: {
            value: blurb.work!.name,
            rule: describeProgress(ongoing.progress, published, this.today),
            icon: markIcon(config?.icon),
          },
        })
      }
    }

    if (
      hideLanguages?.enabled
      && blurb.language
      && !hideLanguages.show.some(e => e.label === blurb.language)
    ) {
      hides.push({
        label: 'Language',
        kind: 'languages',
        priority: 0,
        item: { value: blurb.language, rule: `Language is "${blurb.language}"` },
      })
    }

    if (
      hideCrossovers?.enabled
      && blurb.fandoms.length > hideCrossovers.maxFandoms
    ) {
      hides.push({
        label: 'Too many fandoms',
        kind: 'crossovers',
        priority: 0,
        item: {
          value: `${blurb.fandoms.length} fandoms`,
          rule: `More than ${hideCrossovers.maxFandoms} fandoms`,
        },
      })
    }

    for (const tag of blurb.tags) {
      const rule = weigh(this.rules.filter(r => ruleMatchesTag(r, tag)))
      if (!rule)
        continue
      const label = tag.type ? TagType.toDisplayString(tag.type) : 'Tag'
      addHide(rule, label, 'tags', { value: tag.name, exclude: tagExcludeTarget(tag) })
    }

    for (const author of blurb.authors) {
      const rule = weigh(this.rules.filter(r => ruleMatchesAuthor(r, author)))
      if (!rule)
        continue
      const value = author.pseud ? `${author.userId} (${author.pseud})` : author.userId
      addHide(rule, 'Author', 'authors', { value })
    }

    if (blurb.work) {
      const rule = weigh(this.rules.filter(r => ruleMatchesEntity(r, 'work', blurb.work!)))
      if (rule)
        addHide(rule, 'Work', 'works', { value: blurb.work.name })
    }

    for (const series of blurb.series) {
      const rule = weigh(this.rules.filter(r => ruleMatchesEntity(r, 'series', series)))
      if (rule)
        addHide(rule, 'Series', 'series', { value: series.name })
    }

    // Settle the contest: anything at or below the force-show bar is overruled,
    // and a work with nothing left is simply shown.
    for (const candidate of hides) {
      if (candidate.priority <= bar)
        continue
      addReason(reasons, candidate.label, candidate.item)
      kinds.add(candidate.kind)
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
      // A collapsed work hides its own title (and the indicator that normally
      // rides next to it), so the reason line is the only place left to say
      // *why* at a glance — worth an icon wherever the reason has one.
      const icon = items.find(item => item.icon)?.icon
      if (icon)
        container.append(<span class={REASON_ICON_CLASS}>{icon()}</span>)
      container.append(<span class={LABEL_CLASS}>{`${label}: `}</span>)

      items.forEach((item, i) => {
        if (i > 0)
          container.append(document.createTextNode(', '))

        const text = showValues ? item.value : item.rule
        const title = showValues ? item.rule : item.value
        // The rule stays in `title` for desktop hover; tap/click/long-press (and
        // right-click) opens it as a popover so it's reachable without a pointer.
        const valueSpan = <span class={VALUE_CLASS} title={title}>{text}</span>
        attachPopoverTrigger(valueSpan, () => hintNode(title))
        container.append(valueSpan)

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

/**
 * The hover text as nodes, one line per line.
 *
 * `openPopover` renders a string as a text node, where the `\n` of a two-line
 * hint — the ongoing mark's, which says what's unread *and* what the wait-until
 * date does — collapses like any other HTML whitespace and reads as one run-on
 * sentence. The `title=` attribute honours the newline, so only the
 * tap/long-press path needs this.
 */
function hintNode(text: string): Node {
  const fragment = document.createDocumentFragment()
  for (const line of text.split('\n'))
    fragment.append(<div>{line}</div>)
  return fragment
}

/**
 * Human description of the rule that matched, for the hover/rule display. Names
 * what the rule targets as well as how it matched, since one list now holds
 * rules for tags, authors, works and series — and calls out a non-default
 * priority, which is otherwise invisible at exactly the moment it decided things.
 */
function describeRule(rule: Rule): string {
  const noun = ruleTargetLabel(rule.target)
  const value = rule.value.trim()

  const body = (rule.target === 'work' || rule.target === 'series') && /^\d+$/.test(value)
    ? `${noun} id ${value}`
    : rule.matcher === 'contains'
      ? `${noun} contains "${rule.value}"`
      : rule.matcher === 'regex'
        ? `${noun} matches /${rule.value}/`
        : `${noun} "${rule.value}"`

  const priority = rulePriority(rule)
  return priority === 0 ? body : `${body} (priority ${priority})`
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
