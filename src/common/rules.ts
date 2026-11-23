import type { Tag } from './data.ts'

import { TagType } from './data.ts'

/**
 * The rules list: what a rule matches, what it does and how strongly, and the
 * pure helpers that read it, describe it and write it.
 */

/**
 * What a rule does with the works (and tags/authors/titles) it matches:
 * - `'hide'` (or missing): take the work out of the listing entirely. The
 *   default. On a native listing its `<li>` is hidden outright (the peek pill
 *   still reveals it); in one of our search views it is dropped from the results
 *   altogether, so a page still fills with the number of works you asked for.
 * - `'collapse'`: keep the work in the listing, squeezed down to a one-line
 *   reason with a "Show" button. The gentler half of what `'hide'` used to be —
 *   a collapsed work still takes its place in a listing (and its slot on a
 *   search view's page), which is the whole point: you can see it was there.
 * - `'invert'`: force-show the work even when another rule would hide it. Also
 *   highlights the match by default (a force-shown work usually wants to stand
 *   out); opt out by setting `color` to `'transparent'`.
 * - `'highlight'`: visually highlight the match, without affecting whether the
 *   work is hidden.
 * - `'hideFilter'`: hide the matched *tag* itself — from a work's tag list, from
 *   the filter sidebar, and from the search view's facets — without affecting
 *   whether the work is shown. For noise tags ("Story", "X is a jerk") that only
 *   cost you reading time. Tag rules only; see {@link ruleAffectsWorks}.
 * - `'none'`: do nothing at all. The rule is kept — its value, matcher, priority
 *   and colour intact — but matches nothing anywhere: no hiding, no highlight,
 *   no indicator. For putting a rule aside without losing it (or the work of
 *   writing its regex) to try the page without it. Note that an export read by
 *   the *upstream* extension, which knows only a boolean `invert`, sees a
 *   disabled rule as a plain hide rule; our own exports round-trip it intact.
 */
export type FilterBehavior = 'hide' | 'collapse' | 'invert' | 'highlight' | 'hideFilter' | 'none'

/**
 * Whether a rule takes part in deciding if a work is shown — i.e. it takes the
 * work away (`hide`), squeezes it down (`collapse`) or force-shows it
 * (`invert`). The purely presentational behaviours (`highlight`, `hideFilter`)
 * only change how the *match* is drawn, and `none` does nothing whatever, so
 * they're all skipped when HideWorks collects its reasons. Stated as the
 * behaviours that do count rather than the ones that don't, so a behaviour added
 * later stays out until it's let in.
 */
export function ruleAffectsWorks(rule: { behavior?: FilterBehavior }): boolean {
  const behavior = rule.behavior ?? 'hide'
  return behavior === 'hide' || behavior === 'collapse' || behavior === 'invert'
}

/**
 * Whether a rule has a priority to show: it takes part in deciding whether a
 * work is shown ({@link ruleAffectsWorks}), or it is switched off (`none`) and
 * keeps its priority for when it's switched back on.
 */
export function ruleHasPriority(rule: { behavior?: FilterBehavior }): boolean {
  return rule.behavior === 'none' || ruleAffectsWorks(rule)
}

/**
 * How a work that lost the contest is taken out of the listing: gone entirely,
 * or kept in place as a collapsed reason line. The two halves of what a `hide`
 * rule used to do under the old global "collapse or hide fully" switch — which
 * survives, rescoped, as {@link Options.hideShowReason}, for the hides that
 * aren't rules at all (marks, crossovers).
 */
export type HideMode = 'hide' | 'collapse'

/**
 * The {@link HideMode} a work-affecting rule asks for. `invert` never reaches
 * here — a force-show hides nothing — so a rule that isn't a `collapse` is a
 * hide, which is also what the missing-`behavior` default has always meant.
 */
export function ruleHideMode(rule: { behavior?: FilterBehavior }): HideMode {
  return rule.behavior === 'collapse' ? 'collapse' : 'hide'
}

// ---------------------------------------------------------------------------
// Rule priority. Every rule carries a 0-9 strength; the highest-priority rule
// matching a work decides whether it's hidden, so a force-show no longer wins
// unconditionally over everything else.
// ---------------------------------------------------------------------------

/** Lowest (and default) rule priority. */
export const MIN_PRIORITY = 0
/** Highest rule priority. */
export const MAX_PRIORITY = 9

/**
 * The priority an "Always show" rule gets when neither it nor the rules
 * settings ({@link RulePriorityDefaults.alwaysShowPriority}) say otherwise: high
 * enough to beat every other rule by default (which is what "Always show" has
 * always meant), with room above it for a hide rule that should win anyway, and
 * room below for a force-show that shouldn't.
 */
export const DEFAULT_ALWAYS_SHOW_PRIORITY = 4

/** The part of the rules settings that decides what a rule's priority is when it sets none. */
export interface RulePriorityDefaults {
  /**
   * The priority of an "Always show" rule that sets none of its own. Absent
   * means {@link DEFAULT_ALWAYS_SHOW_PRIORITY}.
   */
  alwaysShowPriority?: number
}

/** `value` truncated onto the 0-{@link MAX_PRIORITY} scale, or `undefined` when it isn't a number at all. */
export function clampPriority(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return undefined
  return Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, Math.trunc(value)))
}

/**
 * The priority a rule doing `behavior` gets when it doesn't carry one of its
 * own. Everything is {@link MIN_PRIORITY} except `'invert'`, which takes the
 * settings' {@link RulePriorityDefaults.alwaysShowPriority}.
 *
 * Collapsing is a hide that leaves a trace, so it starts out exactly as strong
 * as one — which also means a tie between the two is settled by the tie-break
 * in HideWorks (hide wins) rather than by the numbers here. A disabled rule
 * never enters the contest, so its priority is only ever the one it will have
 * again when re-enabled — which the editor preserves rather than resetting to
 * this.
 */
export function defaultRulePriority(behavior: FilterBehavior, defaults: RulePriorityDefaults): number {
  if (behavior !== 'invert')
    return MIN_PRIORITY
  return clampPriority(defaults.alwaysShowPriority) ?? DEFAULT_ALWAYS_SHOW_PRIORITY
}

/**
 * A rule's effective priority: its own `priority` when set (clamped to
 * 0-{@link MAX_PRIORITY}), else the default for its behaviour. Rules only store a
 * `priority` when it differs from that default, so a rule written before
 * priorities existed still behaves exactly as it used to, and an "Always show"
 * rule left at its default follows the settings when they change.
 */
export function rulePriority(rule: { behavior?: FilterBehavior, priority?: number }, defaults: RulePriorityDefaults): number {
  return clampPriority(rule.priority) ?? defaultRulePriority(rule.behavior ?? 'hide', defaults)
}

/**
 * Whether a hide rule at `priority` is strong enough for "Exclude hidden works
 * from the search" to hand to a search filter: at least `minPriority`
 * ({@link Options.autoExcludeMinPriority}), brought onto the scale, with
 * anything that isn't a number counting as {@link MIN_PRIORITY}.
 *
 * A rule below it still hides the works it matches; it just isn't asked of the
 * archive. The filter reaches every page of results, not only the one whose
 * works were weighed, so a weak hide rule excluded there would also take out
 * works on other pages that a stronger "always show" would have kept.
 */
export function excludesFromSearch(priority: number, minPriority: unknown): boolean {
  return priority >= (clampPriority(minPriority) ?? MIN_PRIORITY)
}

// ---------------------------------------------------------------------------
// Rules — one list, one shape, for tags, fandoms, authors, works and series.
// ---------------------------------------------------------------------------

/**
 * What a rule matches. `'tag'` means any tag regardless of type; a {@link TagType}
 * restricts to that one type; the remaining three target the work's author, the
 * work itself, or a series it belongs to.
 *
 * This single field is also what the default highlight colours are keyed on (see
 * {@link DEFAULT_RULE_COLORS}), so a rule's colour follows from what it targets
 * rather than from which list it used to live in.
 */
export type RuleTarget = 'tag' | TagType | 'author' | 'work' | 'series'

/** Every rule target, in the order the options UI offers them. */
export const RULE_TARGETS: RuleTarget[] = ['tag', ...TagType.values(), 'author', 'work', 'series']

/** Whether a target names a tag (any type, or one specific type). */
export function isTagTarget(target: RuleTarget): target is 'tag' | TagType {
  return target !== 'author' && target !== 'work' && target !== 'series'
}

/** Whether a target is a work or a series, which a rule matches by title or by the id in its link. */
export function isEntityTarget(target: RuleTarget): target is 'work' | 'series' {
  return target === 'work' || target === 'series'
}

/** Whether a work or series rule's text is a number, which matches the id in its link whatever the matcher. */
export function matchesById(target: RuleTarget, value: string): boolean {
  return isEntityTarget(target) && /^\d+$/.test(value.trim())
}

/** Human name for a rule target, as shown in the options list and menus. */
export function ruleTargetLabel(target: RuleTarget): string {
  switch (target) {
    case 'tag': return 'Any tag'
    case 'author': return 'Author'
    case 'work': return 'Work'
    case 'series': return 'Series'
    default: return TagType.toDisplayString(target)
  }
}

/**
 * What a rule matches, and how: `Fandom "Some Fandom"`, `Any tag contains "au"`,
 * and with the pseud an author rule is narrowed to, `Author "someone" (alt)`.
 */
export function ruleSubject(rule: Rule): string {
  const noun = ruleTargetLabel(rule.target)

  const subject = matchesById(rule.target, rule.value)
    ? `${noun} id ${rule.value.trim()}`
    : rule.matcher === 'contains'
      ? `${noun} contains "${rule.value}"`
      : rule.matcher === 'regex'
        ? `${noun} matches /${rule.value}/`
        : `${noun} "${rule.value}"`
  return rule.pseud ? `${subject} (${rule.pseud})` : subject
}

/**
 * A rule as a reason names it: its {@link ruleSubject}, and a priority other
 * than 0, which is otherwise invisible at exactly the moment it decided things.
 */
export function ruleDescription(rule: Rule, defaults: RulePriorityDefaults): string {
  const body = ruleSubject(rule)
  const priority = rulePriority(rule, defaults)
  return priority === 0 ? body : `${body} (priority ${priority})`
}

/**
 * One entry in the Rules list — the single shape that used to be four separate
 * lists (`hideTags`, `hideAuthors`, `hideWorks`, `hideSeries`). What it matches
 * is decided by {@link Rule.target}; everything else (how it matches, what it
 * does, how strongly, what colour it highlights in) is shared by every target.
 */
export interface Rule {
  /** What this rule matches: any tag, one tag type, an author, a work, or a series. */
  target: RuleTarget
  /**
   * The value matched: a tag name, an author's user id, or a work/series title.
   * For `'work'`/`'series'` a purely numeric value matches the entity's id
   * instead of its title (so `4232377` hides `/series/4232377` whatever it's called).
   */
  value: string
  /** Author rules only: restrict the rule to one of that author's pseuds. */
  pseud?: string
  /** How {@link Rule.value} matches. `exact` is case-sensitive; `contains`/`regex` are not. */
  matcher: 'exact' | 'contains' | 'regex'
  /** What to do with the match. Missing is treated as `'hide'`. */
  behavior?: FilterBehavior
  /**
   * How strongly this rule asserts itself, 0-9. Only stored when it differs from
   * the behaviour's default ({@link defaultRulePriority}); read it through
   * {@link rulePriority}.
   */
  priority?: number
  /**
   * Highlight colour (any CSS color) used when the rule highlights its match —
   * i.e. when `behavior === 'highlight'`, or `behavior === 'invert'` and not
   * opted out. The literal `'transparent'` on an invert rule means "no
   * highlight". Missing falls back to the target's default colour. See
   * {@link ruleHighlightColor}.
   */
  color?: string
}

/**
 * A pleasant, visible-but-not-loud default highlight colour for tag rules: a
 * translucent amber (`#rrggbbaa`, ~62% opacity) so it reads as a gentle wash
 * rather than a loud block.
 */
export const DEFAULT_HIGHLIGHT_COLOR = '#ffe0829e'

/**
 * Default highlight colour for author rules — a translucent sky-blue at the same
 * opacity as {@link DEFAULT_HIGHLIGHT_COLOR}. Deliberately a different hue so a
 * highlighted byline reads as distinct from a highlighted tag.
 */
export const DEFAULT_AUTHOR_HIGHLIGHT_COLOR = '#82b4ff9e'

/** Default highlight colour for work rules — a translucent violet, again its own hue. */
export const DEFAULT_WORK_HIGHLIGHT_COLOR = '#c9b0ff9e'

/** Default highlight colour for series rules — a translucent mint. */
export const DEFAULT_SERIES_HIGHLIGHT_COLOR = '#9ee8c79e'

/**
 * The built-in highlight colour for every rule target. Tags (of any type) share
 * the amber default; authors, works and series each keep the hue they had when
 * they were separate lists. User overrides live in `options.rules.colors`, keyed
 * by the same targets — which is what makes the defaults data rather than four
 * ad-hoc settings.
 */
export const DEFAULT_RULE_COLORS: Record<RuleTarget, string> = {
  tag: DEFAULT_HIGHLIGHT_COLOR,
  [TagType.Rating]: DEFAULT_HIGHLIGHT_COLOR,
  [TagType.ArchiveWarning]: DEFAULT_HIGHLIGHT_COLOR,
  [TagType.Category]: DEFAULT_HIGHLIGHT_COLOR,
  [TagType.Fandom]: DEFAULT_HIGHLIGHT_COLOR,
  [TagType.Relationship]: DEFAULT_HIGHLIGHT_COLOR,
  [TagType.Character]: DEFAULT_HIGHLIGHT_COLOR,
  [TagType.Freeform]: DEFAULT_HIGHLIGHT_COLOR,
  author: DEFAULT_AUTHOR_HIGHLIGHT_COLOR,
  work: DEFAULT_WORK_HIGHLIGHT_COLOR,
  series: DEFAULT_SERIES_HIGHLIGHT_COLOR,
}

/**
 * The colours the rule editor offers a rule beside its target's default, as
 * swatches. Picking one stores its colour as the rule's own `color`; a rule
 * whose colour equals one shows that swatch picked.
 */
export const HIGHLIGHT_PRESETS = [
  { name: 'Sky', color: '#0ea5e9' },
  { name: 'Amber', color: '#f59e0b' },
  { name: 'Violet', color: '#7c3aed' },
] as const satisfies readonly { name: string, color: string }[]

export type HighlightPreset = typeof HIGHLIGHT_PRESETS[number]

/** Per-target highlight colour overrides, as stored in `options.rules.colors`. */
export type RuleColors = Partial<Record<RuleTarget, string>>

/** The default highlight colour for a target: the user's override, else the built-in. */
export function ruleTargetColor(target: RuleTarget, colors?: RuleColors): string {
  return colors?.[target] || DEFAULT_RULE_COLORS[target] || DEFAULT_HIGHLIGHT_COLOR
}

/**
 * The colour a rule should highlight its match with, or `null` if it does not
 * highlight. Highlight rules always highlight; invert rules highlight too (so
 * force-shown works stand out) unless their colour is the sentinel
 * `'transparent'` ("No highlight"). A rule with no colour of its own falls back
 * to its target's default (see {@link ruleTargetColor}).
 */
export function ruleHighlightColor(rule: Rule, colors?: RuleColors): string | null {
  switch (rule.behavior) {
    case 'highlight':
      return rule.color || ruleTargetColor(rule.target, colors)
    case 'invert':
      return rule.color === 'transparent' ? null : rule.color || ruleTargetColor(rule.target, colors)
    default:
      return null
  }
}

/** The rules among `rules` that highlight their match, each with its {@link ruleHighlightColor}, in list order. */
export function highlightingRules(rules: Rule[], colors?: RuleColors): { rule: Rule, color: string }[] {
  return rules.flatMap((rule) => {
    const color = ruleHighlightColor(rule, colors)
    return color === null ? [] : [{ rule, color }]
  })
}

/**
 * Apply a rule's matcher to one subject string: exact is case-sensitive,
 * contains and regex aren't, and an invalid regex matches nothing. The rule
 * editor's regex tester calls it too, so its verdicts are the live rules'.
 */
export function ruleValueMatches(rule: Pick<Rule, 'value' | 'matcher'>, subject: string): boolean {
  if (rule.matcher === 'contains')
    return subject.toLowerCase().includes(rule.value.toLowerCase())

  if (rule.matcher === 'regex')
    return ruleRegex(rule.value)?.test(subject) ?? false

  return rule.value === subject
}

/**
 * Every pattern compiled so far, by its source; null for one that doesn't
 * compile. A listing tests each regex rule against every tag of every work, so
 * compiling it once per test would be most of what the rule costs.
 */
const compiledRegexes = new Map<string, RegExp | null>()

function ruleRegex(pattern: string): RegExp | null {
  let compiled = compiledRegexes.get(pattern)
  if (compiled !== undefined)
    return compiled
  try {
    // Case-insensitivity is the `i` flag's job, not `toLowerCase()`'s: lowering
    // the *pattern* rewrites every negated class into its opposite (`\S`→`\s`,
    // `\D`→`\d`, `\W`→`\w`, `\B`→`\b`), so `omega\S+verse` used to match the
    // one set of tags the reader meant to exclude. No `g` flag either, so
    // `test` keeps no position between one name and the next.
    compiled = new RegExp(pattern, 'i')
  }
  catch {
    // An invalid regex matches nothing rather than throwing mid-render.
    compiled = null
  }
  compiledRegexes.set(pattern, compiled)
  return compiled
}

/** Whether a tag-targeted rule matches a given tag (by type, then name). */
export function ruleMatchesTag(rule: Rule, tag: Tag): boolean {
  if (!isTagTarget(rule.target))
    return false
  if (rule.target !== 'tag' && rule.target !== tag.type)
    return false
  return ruleValueMatches(rule, tag.name)
}

/** Whether an author-targeted rule matches a given author (by user id, then optional pseud). */
export function ruleMatchesAuthor(rule: Rule, author: { userId: string, pseud?: string }): boolean {
  if (rule.target !== 'author')
    return false
  if (rule.pseud !== undefined && rule.pseud !== author.pseud)
    return false
  return ruleValueMatches(rule, author.userId)
}

/** A work or series, as parsed from its link: a numeric id (if known) and display name. */
export interface FilterableEntity {
  /** The id parsed from the entity's `/works/:id` or `/series/:id` link. */
  id?: string
  /** The entity's display name (the link text). */
  name: string
}

/**
 * Whether a work/series-targeted rule matches a given entity. A purely numeric
 * `value` matches the entity's id exactly; otherwise the name is matched with
 * the rule's matcher. An empty value matches nothing.
 */
export function ruleMatchesEntity(rule: Rule, kind: 'work' | 'series', entity: FilterableEntity): boolean {
  if (rule.target !== kind)
    return false
  const value = rule.value.trim()
  if (value === '')
    return false

  if (matchesById(kind, value))
    return entity.id !== undefined && entity.id === value

  return ruleValueMatches({ ...rule, value }, entity.name)
}

// ---------------------------------------------------------------------------
// Exact rules — the one rule a menu on a tag, author, work or series link
// reads and writes. Everything a menu can act on reduces to a {@link RuleKey}.
// ---------------------------------------------------------------------------

/** What an exact-match rule points at: its target and value, and for an author, optionally one pseud. */
export interface RuleKey {
  target: RuleTarget
  value: string
  /** Author rules only — a rule for one pseud is distinct from one for the account. */
  pseud?: string
}

/** The key for a tag/fandom link: its type when known, else "any tag". */
export function tagKey(tag: Tag): RuleKey {
  return { target: (tag.type ?? 'tag') as TagType | 'tag', value: tag.name }
}

/** The key for an author byline (optionally narrowed to one pseud). */
export function authorKey(userId: string, pseud?: string): RuleKey {
  return { target: 'author', value: userId, pseud }
}

/** The key for a work or series, by its numeric AO3 id. */
export function entityKey(kind: 'work' | 'series', id: string): RuleKey {
  return { target: kind, value: id }
}

/** Whether `rule` is the exact-match rule on this key. */
export function ruleHasKey(rule: Rule, key: RuleKey): boolean {
  return rule.matcher === 'exact'
    && rule.target === key.target
    && rule.value === key.value
    && (rule.pseud ?? undefined) === (key.pseud ?? undefined)
}

/** The exact-match rule on this key, if there is one. */
export function findExactRule(rules: Rule[], key: RuleKey): Rule | undefined {
  return rules.find(rule => ruleHasKey(rule, key))
}

/** What a rule does, or `null` for no rule at all. */
export function behaviorOf(rule: Rule | undefined): FilterBehavior | null {
  return rule ? (rule.behavior ?? 'hide') : null
}

/** The behaviour currently applied to this exact key, or `null` if no rule matches it. */
export function ruleBehavior(rules: Rule[], key: RuleKey): FilterBehavior | null {
  return behaviorOf(findExactRule(rules, key))
}

/**
 * The behaviour an on-page indicator should draw for a rule, or `null` for
 * nothing. Everything {@link behaviorOf} returns except `'none'`: a disabled
 * rule is meant to be invisible, and a badge for a rule that does nothing would
 * be a badge for nothing. (The menu still offers "Clear", so the rule is
 * reachable from the page once you open it.)
 */
export function ruleIndicatorBehavior(behavior: FilterBehavior | null): Exclude<FilterBehavior, 'none'> | null {
  return behavior && behavior !== 'none' ? behavior : null
}

/**
 * The rules besides the tag's own exact one (on its {@link tagKey}) that weigh
 * in on whether a work carrying `tag` shows: those matching it by `contains`
 * or `regex`, or exactly under another target (an "Any tag" rule on a typed
 * tag). A tag's menu writes only its own rule, so these are the ones it has to
 * point out besides.
 */
export function matchedTagRules(rules: Rule[], tag: Tag): Rule[] {
  const key = tagKey(tag)
  return rules.filter(rule => ruleAffectsWorks(rule) && !ruleHasKey(rule, key) && ruleMatchesTag(rule, tag))
}

/** One indicator on a tag link, and the rules behind it. */
export interface RuleIndicator {
  behavior: Exclude<FilterBehavior, 'none'>
  /**
   * How the rule the icon stands for matched: the tag's own exact rule when it
   * does this, else the strongest rule that does, the first listed of equals.
   */
  matcher: Rule['matcher']
  /**
   * Every rule doing this, as {@link ruleDescription} names it, the one the icon
   * stands for first. Empty when the tag's own rule is the only one: that is
   * the rule the tag's menu shows, and needs no naming.
   */
  reasons: string[]
}

/**
 * The indicators a tag link carries for the rules: whatever its own exact rule
 * does, and whatever the {@link matchedTagRules} do to its works, one
 * indicator per behaviour.
 */
export function tagRuleIndicators(rules: Rule[], tag: Tag, defaults: RulePriorityDefaults): RuleIndicator[] {
  const own = findExactRule(rules, tagKey(tag))
  const groups = new Map<Exclude<FilterBehavior, 'none'>, Rule[]>()
  const add = (rule: Rule) => {
    const behavior = ruleIndicatorBehavior(behaviorOf(rule))
    if (behavior)
      groups.set(behavior, [...groups.get(behavior) ?? [], rule])
  }

  if (own)
    add(own)
  const strongestFirst = matchedTagRules(rules, tag)
    .sort((a, b) => rulePriority(b, defaults) - rulePriority(a, defaults))
  for (const rule of strongestFirst)
    add(rule)

  return [...groups].map(([behavior, behind]) => ({
    behavior,
    matcher: behind[0]!.matcher,
    reasons: behind.length === 1 && behind[0] === own ? [] : behind.map(rule => ruleDescription(rule, defaults)),
  }))
}

/**
 * `priority` as a rule doing `behavior` stores it: clamped to the 0-9 range,
 * and left out when it is the behaviour's default, which {@link rulePriority}
 * supplies anyway.
 */
export function storedPriority(behavior: FilterBehavior, priority: number | undefined, defaults: RulePriorityDefaults): number | undefined {
  const clamped = clampPriority(priority)
  return clamped === defaultRulePriority(behavior, defaults) ? undefined : clamped
}

/**
 * `rules` with the key's exact rule replaced by one doing `behavior`, moved to
 * the end of the list, or removed when `behavior` is null.
 *
 * A priority the old rule set for itself is kept, so switching a hide raised to
 * 7 over to a collapse leaves a collapse at 7. A rule at its behaviour's default
 * takes the new behaviour's default instead: it never asked for a strength of
 * its own.
 */
export function replaceExactRule(rules: Rule[], key: RuleKey, behavior: FilterBehavior | null, defaults: RulePriorityDefaults): Rule[] {
  const old = findExactRule(rules, key)
  const next = rules.filter(rule => rule !== old)
  if (behavior === null)
    return next
  const priority = storedPriority(behavior, old?.priority, defaults)
  next.push({
    target: key.target,
    value: key.value,
    ...key.pseud !== undefined ? { pseud: key.pseud } : {},
    matcher: 'exact',
    behavior,
    ...priority !== undefined ? { priority } : {},
  })
  return next
}

/**
 * Choosing `behavior` for a key from a menu: the behaviour the rule already has
 * clears it, and anything else replaces it (see {@link replaceExactRule}).
 */
export function toggleExactRule(rules: Rule[], key: RuleKey, behavior: FilterBehavior, defaults: RulePriorityDefaults): Rule[] {
  const current = findExactRule(rules, key)
  const chosenAgain = current !== undefined && (current.behavior ?? 'hide') === behavior
  return replaceExactRule(rules, key, chosenAgain ? null : behavior, defaults)
}

/** `rules` with the key's exact rule set to `priority`, in place. Unchanged when the key has no rule. */
export function setExactRulePriority(rules: Rule[], key: RuleKey, priority: number, defaults: RulePriorityDefaults): Rule[] {
  return withPriority(rules, findExactRule(rules, key), priority, defaults)
}

/**
 * `rules` with the stored rule equal to `rule`, field for field, set to
 * `priority`, in place. For a rule known only by what it says — one a work was
 * weighed against, which may match by `contains` or `regex` and so has no
 * {@link RuleKey}. Unchanged when no stored rule is equal to it.
 */
export function setRulePriorityOf(rules: Rule[], rule: Rule, priority: number, defaults: RulePriorityDefaults): Rule[] {
  return withPriority(rules, rules.find(stored => sameRule(stored, rule)), priority, defaults)
}

function sameRule(a: Rule, b: Rule): boolean {
  const keys = Object.keys(a) as (keyof Rule)[]
  return keys.length === Object.keys(b).length && keys.every(k => a[k] === b[k])
}

function withPriority(rules: Rule[], target: Rule | undefined, priority: number, defaults: RulePriorityDefaults): Rule[] {
  return rules.map((rule) => {
    if (rule !== target)
      return rule
    const { priority: _old, ...rest } = rule
    const stored = storedPriority(rule.behavior ?? 'hide', priority, defaults)
    return stored === undefined ? rest : { ...rest, priority: stored }
  })
}

/**
 * Map a legacy boolean `invert` flag onto {@link FilterBehavior} for filters
 * imported from (or shared by) the upstream extension, returning the filter with
 * `invert` stripped. An `invert: true` becomes `behavior: 'invert'`; a falsy
 * `invert` leaves the default (`'hide'`). An existing `behavior` always wins — we
 * never override one that's already set. Idempotent on filters that have no
 * `invert`, so it's safe to run repeatedly (e.g. on every import/migration).
 */
export function filterFromInvert<T extends Record<string, any>>(filter: T): Omit<T, 'invert'> {
  if (!('invert' in filter))
    return filter
  const { invert, ...rest } = filter as Record<string, any>
  if (rest.behavior === undefined && invert)
    rest.behavior = 'invert'
  return rest as Omit<T, 'invert'>
}

/**
 * Add an `invert` flag mirroring `behavior === 'invert'`, so an exported filter
 * still force-shows correctly when loaded by the upstream extension (which reads
 * `invert`, not `behavior`). Keeps `behavior`/`color` so our own re-import is
 * lossless. The inverse of {@link filterFromInvert}.
 */
export function filterWithInvert<T extends { behavior?: FilterBehavior }>(filter: T): T & { invert: boolean } {
  return { ...filter, invert: filter.behavior === 'invert' }
}
