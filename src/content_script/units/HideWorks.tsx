import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiEye from '~icons/mdi/eye.jsx'
import MdiMinusCircle from '~icons/mdi/minus-circle.jsx'

import type { HideMode, MarkId, Options, ProgressSource, Rule } from '#common'
import type { FilterTarget } from '#content_script/filterTarget.js'
import type { FacetKey } from '#content_script/searchView/engine.ts'

import { ADDON_CLASS, describeProgress, findProgress, hiddenByMarks, hiddenLabel, markHidesResults, marksHideAnything, progressSources, readiness, ruleAffectsWorks, ruleHideMode, ruleMatchesAuthor, ruleMatchesEntity, ruleMatchesTag, rulePriority, ruleTargetLabel, TagType, todayEpochDays } from '#common'
import { type Blurb, type BlurbTag, getBlurb } from '#content_script/blurb.js'
import { attachPopoverTrigger, clearMenuTriggers } from '#content_script/contextTrigger.js'
import {
  loadFandomIdLookup,
  resetFilterSidebarCaches,
} from '#content_script/filterSidebar.js'
import {
  facetForTagType,
  filterTargetFor,
  nativeTargetForTag,
  onFilterTargetChange,
} from '#content_script/filterTarget.js'
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
 * The value an inline "exclude" button excludes, and the tag type that decides
 * where it lands — the search view's matching facet when the blurb is inside
 * one, else the sidebar field/checkbox AO3 filters that type with. See
 * {@link file://../filterTarget.tsx}.
 */
interface ExcludeTarget {
  name: string
  type?: TagType
  /** The tag's own page, so an unknown fandom's id can be fetched on demand. */
  href?: string
  /**
   * For a value that isn't a tag at all — a work's language. Naming the facet
   * outright is also what says there is no sidebar equivalent, so the button
   * appears only inside a search view.
   */
  facet?: FacetKey
}

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
  /**
   * What this reason asks for: the work gone, or collapsed to its reason line.
   * A rule says so itself; the hides that aren't rules all take it from
   * {@link Options.hideShowReason}.
   */
  mode: HideMode
}

/**
 * The verdict on one blurb: how it leaves the listing (`null` when nothing hides
 * it), why, and which categories of rule were responsible.
 */
export interface HideVerdict {
  mode: HideMode | null
  reasons: HideReasons
  kinds: Set<HideKind>
}

function addReason(reasons: HideReasons, label: string, item: ReasonItem) {
  if (!(label in reasons))
    reasons[label] = []
  reasons[label]!.push(item)
}

// ---------------------------------------------------------------------------
// Inline exclude buttons. Registered across all hidden works on the page (or in
// the search view) so a filter change made anywhere — here, or a tag/fandom
// toolbar, or the view's own facet rows — re-syncs them.
// ---------------------------------------------------------------------------

interface ExcludeButton {
  button: HTMLButtonElement
  target: ExcludeTarget
  /** Where this button's exclude lands; resolved when the button was built. */
  filter: FilterTarget
}

const excludeButtons: ExcludeButton[] = []

/** What to call the thing being excluded, in the button's hover text. */
function excludeNoun(target: ExcludeTarget): string {
  if (target.facet === 'language')
    return 'language'
  switch (target.type) {
    case TagType.Fandom: return 'fandom'
    case TagType.Rating: return 'rating'
    case TagType.ArchiveWarning: return 'warning'
    case TagType.Category: return 'category'
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

function refreshExcludeButtons(): void {
  for (const { button, target, filter } of excludeButtons)
    setExcludeButtonState(button, target, filter.isSelected('exclude', target.name))
}

// Registered once; iterating an empty registry between page runs is a no-op.
onFilterTargetChange(refreshExcludeButtons)

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

  /**
   * Everything {@link processBlurb} needs beyond the blurb itself — the hiding
   * marks, the work-affecting rules, today's date. Derived from the options
   * rather than copied out in `ready()`, so a unit built only to weigh a blurb
   * (see {@link hideVerdict}) is as good as one that ran; {@link runState}'s
   * cache means every unit sharing an options object shares the work.
   */
  private get run(): RunState {
    return runState(this.options)
  }

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
    // blurb's — which is exactly how the search view runs this unit, one blurb
    // at a time, and its buttons exclude into the view's own facets.
    if (this.root === document)
      excludeButtons.length = 0

    const blurbElements = this.rootBlurbs()

    let usedFandomExclude = false
    for (const blurbElement of blurbElements) {
      const blurb = getBlurb(blurbElement)
      const { mode, reasons, kinds } = this.processBlurb(blurb)

      if (!mode)
        continue

      if (this.hideWork(blurbElement, mode, reasons, kinds))
        usedFandomExclude = true
    }

    // A fandom exclude button pointed at the sidebar needs the id lookup to show
    // its initial state and to filter on click. Load it lazily, then re-sync any
    // buttons we built.
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
   *
   * What survives then decides *how* the work goes: the strongest surviving
   * reason picks between collapsing the work and taking it away entirely, and a
   * tie goes to hiding — the reader who wrote a hide rule that strong asked for
   * the work gone, and a collapse rule of merely equal strength shouldn't quietly
   * put it back on the page. The hides that aren't rules all speak with
   * {@link Options.hideShowReason}'s voice.
   */
  processBlurb(blurb: Blurb): HideVerdict {
    const { options: { hideLanguages, hideCrossovers, workMarks, hideShowReason } } = this
    const { hiddenMarks, progress, today, rules } = this.run
    const reasons: HideReasons = {}
    const kinds = new Set<HideKind>()
    /** What the hides that aren't rules ask for; a rule always says for itself. */
    const plainMode: HideMode = hideShowReason ? 'collapse' : 'hide'

    const hides: HideCandidate[] = []
    /** The strongest force-show matching this work; -1 when none does. */
    let bar = -1

    /**
     * Weigh every rule matching one subject: force-shows raise the bar, and the
     * strongest hide becomes that subject's single candidate reason (a tag
     * matching three hide rules is still one thing wrong with the work). Between
     * two of equal strength the one that hides outright wins, for the same reason
     * it wins the contest below.
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
        if (!best) {
          best = rule
          continue
        }
        const bestPriority = rulePriority(best)
        if (priority > bestPriority)
          best = rule
        else if (priority === bestPriority && ruleHideMode(rule) === 'hide')
          best = rule
      }
      return best
    }

    const addHide = (rule: Rule, label: string, kind: HideKind, item: Omit<ReasonItem, 'rule'>) => {
      hides.push({
        label,
        kind,
        priority: rulePriority(rule),
        mode: ruleHideMode(rule),
        item: { ...item, rule: describeRule(rule) },
      })
    }

    // Marks first: "you already read this" is the reason you're most likely to
    // want to act on, and a collapsed work hides its own title.
    const markId = blurb.work ? hiddenMarks.get(blurb.work.id) : undefined
    if (markId) {
      const config = workMarks.marks[markId]
      hides.push({
        label: config?.label || markId,
        kind: 'marks',
        priority: 0,
        mode: plainMode,
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
    const ongoing = blurb.work ? findProgress(progress, blurb.work.id) : null
    if (ongoing) {
      const published = blurb.chapters?.written ?? null
      const state = readiness(ongoing.progress, published, today)
      if (state !== 'ready') {
        const config = workMarks.marks[ongoing.id]
        hides.push({
          label: hiddenLabel(state, config?.label || ongoing.id),
          kind: 'marks',
          priority: 0,
          mode: plainMode,
          item: {
            value: blurb.work!.name,
            rule: describeProgress(ongoing.progress, published, today),
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
        mode: plainMode,
        item: {
          value: blurb.language,
          rule: `Language is "${blurb.language}"`,
          // AO3's sidebar picks one language at a time and can't exclude any, so
          // this row is the search view's alone — there the language is just
          // another facet, and dropping it takes these placeholders out too.
          exclude: { name: blurb.language, facet: 'language' },
        },
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
        mode: plainMode,
        item: {
          value: `${blurb.fandoms.length} fandoms`,
          rule: `More than ${hideCrossovers.maxFandoms} fandoms`,
        },
      })
    }

    for (const tag of blurb.tags) {
      const rule = weigh(rules.filter(r => ruleMatchesTag(r, tag)))
      if (!rule)
        continue
      const label = tag.type ? TagType.toDisplayString(tag.type) : 'Tag'
      addHide(rule, label, 'tags', { value: tag.name, exclude: tagExcludeTarget(tag) })
    }

    for (const author of blurb.authors) {
      const rule = weigh(rules.filter(r => ruleMatchesAuthor(r, author)))
      if (!rule)
        continue
      const value = author.pseud ? `${author.userId} (${author.pseud})` : author.userId
      addHide(rule, 'Author', 'authors', { value })
    }

    if (blurb.work) {
      const rule = weigh(rules.filter(r => ruleMatchesEntity(r, 'work', blurb.work!)))
      if (rule)
        addHide(rule, 'Work', 'works', { value: blurb.work.name })
    }

    for (const series of blurb.series) {
      const rule = weigh(rules.filter(r => ruleMatchesEntity(r, 'series', series)))
      if (rule)
        addHide(rule, 'Series', 'series', { value: series.name })
    }

    // Settle the contest: anything at or below the force-show bar is overruled,
    // and a work with nothing left is simply shown. The strongest of what's left
    // says how the work goes, hiding outright winning a tie.
    let mode: HideMode | null = null
    let winner = -1
    for (const candidate of hides) {
      if (candidate.priority <= bar)
        continue
      addReason(reasons, candidate.label, candidate.item)
      kinds.add(candidate.kind)
      if (candidate.priority > winner || (candidate.priority === winner && candidate.mode === 'hide')) {
        winner = candidate.priority
        mode = candidate.mode
      }
    }

    return { mode, reasons, kinds }
  }

  /**
   * Take the work out of the listing, the way `mode` asks: `'collapse'` squeezes
   * it down to its reason line with a "Show" button, `'hide'` drops the whole
   * `<li>` (the peek pill can still bring it back). Returns true if it rendered
   * at least one fandom exclude button, so the caller knows to load the fandom id
   * lookup.
   */
  hideWork(blurb: Element, mode: HideMode, reasons: HideReasons, kinds: Set<HideKind>): boolean {
    this.logger.debug('Hiding:', blurb)
    if (blurb instanceof HTMLElement && kinds.size > 0)
      blurb.dataset.ao3eHiddenBy = [...kinds].join(' ')
    const wrapper = (
      <div class={BLURB_WRAPPER_CLASS} data-ao3e-hidden></div>
    )
    wrapper.append(...blurb.childNodes)
    blurb.append(wrapper)

    // Nothing to explain on a work that isn't there: hide the whole <li>. The
    // wrapper above still went on, so `clean()` and the peek CSS find it.
    if (mode === 'hide') {
      (blurb as HTMLLIElement).hidden = true
      return false
    }

    const showValues = this.options.hideShowMatchedValues
    const reasonsNode = this.buildReasons(blurb, reasons, showValues)

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

  buildReasons(blurb: Element, reasons: HideReasons, showValues: boolean): { node: HTMLElement, usedFandomExclude: boolean } {
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

        const excluder = item.exclude ? this.buildExcludeButton(blurb, item.exclude) : null
        if (excluder) {
          container.append(excluder.button)
          // Only the sidebar's fandom filter needs the id lookup; a search
          // view's fandom facet matches the name it already scraped.
          if (excluder.filter.kind === 'native' && item.exclude!.type === TagType.Fandom)
            usedFandomExclude = true
        }
      })
    })

    return { node: container, usedFandomExclude }
  }

  /**
   * Build an inline exclude button and register it, or null when nothing here
   * can filter the value: the blurb is on a plain listing with no filter
   * sidebar, and not inside a search view either. Returns the registry entry, so
   * the caller can see which of the two filters it ended up pointing at.
   */
  buildExcludeButton(blurb: Element, target: ExcludeTarget): ExcludeButton | null {
    const filter = filterTargetFor(
      blurb,
      target.facet ?? facetForTagType(target.type),
      // A named facet means the value is not a tag, so there is nothing in AO3's
      // sidebar to fall back to.
      target.facet ? null : nativeTargetForTag(target, target.href),
    )
    if (!filter)
      return null

    const button = (
      <button type="button" class={EXCLUDE_CLASS} aria-pressed="false">
        <MdiMinusCircle />
      </button>
    ) as HTMLElement as HTMLButtonElement

    setExcludeButtonState(button, target, filter.isSelected('exclude', target.name))

    button.addEventListener('click', (e) => {
      e.preventDefault()
      // No state written back here: every filter notifies once it has actually
      // moved (the native fandom one only after its id resolves), and that
      // notification is what re-syncs this button along with everything else.
      filter.toggle('exclude', target.name)
    })

    const entry: ExcludeButton = { button, target, filter }
    excludeButtons.push(entry)
    return entry
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

/**
 * What a matched tag's exclude button excludes. Which filter field, checkbox or
 * facet that turns into is `filterTarget`'s business — all this has to carry is
 * the tag itself, plus its link so an unknown fandom's id can still be fetched.
 */
function tagExcludeTarget(tag: BlurbTag): ExcludeTarget {
  return { name: tag.name, type: tag.type, href: tag.href }
}

/**
 * Weigh one blurb the way the unit does, without running it — for asking "would
 * this work be hidden?" about works that aren't (yet) on screen. The search view
 * needs the answer for every work it holds, not just the page it's showing: a
 * work a rule hides outright is dropped from the results entirely, so a page
 * still fills with the number of works the reader asked for.
 *
 * A throwaway unit rather than a free function so there is exactly one copy of
 * the contest; `runState`'s cache means a whole listing pays for the mark table
 * once, however many of these are built.
 */
export function hideVerdict(blurb: Blurb, options: Options): HideVerdict {
  return new HideWorks(options).processBlurb(blurb)
}
