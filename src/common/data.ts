/**
 * The tag types AO3 supports (except "Media" and "Banned", which are not shown
 * on works), by the single-letter code we store.
 * @see https://archiveofourown.org/faq/tags#tagtypes
 * @see https://github.com/otwcode/otwarchive/blob/bd57a26224017d4b871fb70a9787d7fe3c29d249/app/models/tag.rb#L15
 *
 * The values are abbreviated to save space in browser.storage.
 *
 * A plain object rather than an `enum`, because an enum is one of the few
 * TypeScript constructs that emits runtime code, and so cannot be *erased* — it
 * has to be *transformed*. Node's built-in type stripping only erases, which put
 * every unit test that reaches this module behind a `--experimental-transform-types`
 * that newer Node no longer has. The codes and the `TagType.Rating` spelling are
 * unchanged, so nothing stored or written against it had to move.
 */
const TAG_TYPE_CODES = {
  Rating: 'r',
  ArchiveWarning: 'w',
  Category: 'c',
  Fandom: 'f',
  Relationship: 'R',
  Character: 'C',
  Freeform: 'F',
} as const

/**
 * One of the codes above. A union of string literals, which is what an enum's
 * member type was in practice — with the difference that a bare `'f'` is now
 * assignable to it, where the enum demanded `TagType.Fandom`.
 */
export type TagType = typeof TAG_TYPE_CODES[keyof typeof TAG_TYPE_CODES]

/**
 * The codes, plus the helpers that used to hang off the enum through a merged
 * namespace. The type above shares its name, which is the ordinary
 * value-and-type pairing — no namespace, and so nothing to transform. (The rule
 * only knows the merges TypeScript itself calls merges; a type and a value
 * sharing a name is legal and is what an enum was doing all along.)
 */
// eslint-disable-next-line ts/no-redeclare
export const TagType = {
  ...TAG_TYPE_CODES,

  /** Every tag type, in declaration order. */
  values(): TagType[] {
    // The codes object, not this one — `Object.values(TagType)` would hand back
    // these three functions along with the codes.
    return Object.values(TAG_TYPE_CODES)
  },

  /** What AO3 calls this tag type in its own headings. */
  toDisplayString(type: TagType): string {
    switch (type) {
      case TagType.Rating: return 'Rating'
      case TagType.ArchiveWarning: return 'Archive Warning'
      case TagType.Category: return 'Category'
      case TagType.Fandom: return 'Fandom'
      case TagType.Relationship: return 'Relationship'
      case TagType.Character: return 'Character'
      case TagType.Freeform: return 'Additional Tags'
    }
  },

  /** The class AO3 puts on this tag type's list in a blurb. */
  toCSSClass(type: TagType): string {
    switch (type) {
      // Special cases that are not in ul.tags
      case TagType.Rating: return 'rating'
      case TagType.Category: return 'category'
      // All other cases
      case TagType.ArchiveWarning: return 'warnings'
      case TagType.Fandom: return 'fandoms'
      case TagType.Relationship: return 'relationships'
      case TagType.Character: return 'characters'
      case TagType.Freeform: return 'freeforms'
    }
  },
}

/**
 * Represents a tag on AO3
 */
export interface Tag {
  /** Pretty name of the tag */
  name: string
  /** The type of the tag - might be empty if we were not able to resolve the type. */
  type?: TagType
}

/**
 * URL->Pretty
 * @see https://github.com/otwcode/otwarchive/blob/bd57a26224017d4b871fb70a9787d7fe3c29d249/app/models/tag.rb#L567-L574
 */
const TAG_NAME_SUBSTITUTIONS: Record<string, string> = {
  '*s*': '/',
  '*a*': '&',
  '*d*': '.',
  '*q*': '?',
  '*h*': '#',
}

/**
 * Takes a either a full URL or a tag name with url substitutions and returns the tag name from it
 */
export function tagNameFromURL(url: string): string {
  const raw = url.includes('/tags/') ? url.split('/tags/')[1]! : url
  return Object.entries(TAG_NAME_SUBSTITUTIONS).reduce((acc, [from, to]) => acc.replaceAll(from, to), raw)
}

/**
 * Takes a tag name and returns a URL path for it
 */
export function tagURLPathFromName(name: string): string {
  return Object.entries(TAG_NAME_SUBSTITUTIONS).reduce((acc, [from, to]) => acc.replaceAll(to, from), name)
}

/**
 * Represents a language on AO3
 *
 * @see https://archiveofourown.org/languages
 */
export interface Language {
  value: string
  label: string
}

/* Represents an author on AO3 */
export interface Author {
  /* Author user id, /users/:user_id/ */
  userId: string
  /* Author pseud or undefined to match all */
  psued?: string
}

/**
 * Represents a user on AO3
 * Only used for constructing links
 */
export interface User {
  userId: string
}

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
 * How a work that lost the contest is taken out of the listing: gone entirely,
 * or kept in place as a collapsed reason line. The two halves of what a `hide`
 * rule used to do under the old global "collapse or hide fully" switch — which
 * survives, rescoped, as {@link Options.hideShowReason}, for the hides that
 * aren't rules at all (marks, crossovers, language).
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
 * The priority a rule gets when it doesn't carry one of its own — set from the
 * behaviour chosen when the rule was created. Everything is `0` except
 * `'invert'`, which sits at `4`: high enough to beat every other rule by default
 * (which is what "Always show" has always meant), with room above it for a hide
 * rule that should win anyway, and room below for a force-show that shouldn't.
 */
export const DEFAULT_BEHAVIOR_PRIORITY: Record<FilterBehavior, number> = {
  hide: 0,
  // Collapsing is a hide that leaves a trace, so it starts out exactly as strong
  // as one — which also means a tie between the two is settled by the tie-break
  // in HideWorks (hide wins) rather than by the numbers here.
  collapse: 0,
  invert: 4,
  highlight: 0,
  hideFilter: 0,
  // A disabled rule never enters the contest, so its priority is only ever the
  // one it will have again when re-enabled — which the editor preserves rather
  // than resetting to this.
  none: 0,
}

/**
 * A rule's effective priority: its own `priority` when set (clamped to
 * 0-{@link MAX_PRIORITY}), else the default for its behaviour. Rules only store a
 * `priority` when it differs from that default, so a rule written before
 * priorities existed still behaves exactly as it used to.
 */
export function rulePriority(rule: { behavior?: FilterBehavior, priority?: number }): number {
  const own = rule.priority
  if (typeof own === 'number' && Number.isFinite(own))
    return Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, Math.trunc(own)))
  return DEFAULT_BEHAVIOR_PRIORITY[rule.behavior ?? 'hide']
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

/** Human name for a rule target, as shown in the options table and menus. */
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
   * the behaviour's default ({@link DEFAULT_BEHAVIOR_PRIORITY}); read it through
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

/** Apply a rule's matcher to one subject string. */
function matchesValue(rule: Rule, subject: string): boolean {
  if (rule.matcher === 'contains')
    return subject.toLowerCase().includes(rule.value.toLowerCase())

  if (rule.matcher === 'regex') {
    try {
      return new RegExp(rule.value.toLowerCase()).test(subject.toLowerCase())
    }
    catch {
      // An invalid regex matches nothing rather than throwing mid-render.
      return false
    }
  }

  return rule.value === subject
}

/** Whether a tag-targeted rule matches a given tag (by type, then name). */
export function ruleMatchesTag(rule: Rule, tag: Tag): boolean {
  if (!isTagTarget(rule.target))
    return false
  if (rule.target !== 'tag' && rule.target !== tag.type)
    return false
  return matchesValue(rule, tag.name)
}

/** Whether an author-targeted rule matches a given author (by user id, then optional pseud). */
export function ruleMatchesAuthor(rule: Rule, author: { userId: string, pseud?: string }): boolean {
  if (rule.target !== 'author')
    return false
  if (rule.pseud !== undefined && rule.pseud !== author.pseud)
    return false
  return matchesValue(rule, author.userId)
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

  // A purely numeric value targets the entity's id (parsed from its link).
  if (/^\d+$/.test(value))
    return entity.id !== undefined && entity.id === value

  return matchesValue({ ...rule, value }, entity.name)
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

/**
 * A find/replace rule applied to the displayed text of a work's chapters.
 */
export interface TextReplacement {
  /** The text to search for. */
  find: string
  /** The text to substitute in for each match. */
  replace: string
  /** Match only where the case matches `find` exactly. */
  caseSensitive?: boolean
  /**
   * A case-insensitive convenience: when a match starts with an uppercase
   * letter, capitalise the replacement's first letter to match. Lets one rule
   * cover both "word" and "Word". Ignored when {@link caseSensitive} is set.
   */
  matchCasing?: boolean
  /** Match only whole words — `find` must not be flanked by word characters. */
  wholeWord?: boolean
}

/** Escape a literal string for safe use inside a RegExp. */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether a string's first character is an uppercase letter. */
function startsUppercase(input: string): boolean {
  const first = input.charAt(0)
  return first !== first.toLowerCase() && first === first.toUpperCase()
}

/** Apply a single replacement rule to a string, returning the new string. */
export function applyTextReplacement(text: string, rule: TextReplacement): string {
  if (!rule.find)
    return text

  // The simplest case — case-sensitive, anywhere — needs no regex.
  if (rule.caseSensitive && !rule.wholeWord) {
    if (!text.includes(rule.find))
      return text
    return text.split(rule.find).join(rule.replace)
  }

  // `\b` keys off `\w`, so flanking lookarounds give whole-word matches that
  // work even when `find` starts or ends with punctuation.
  const body = escapeRegExp(rule.find)
  const pattern = rule.wholeWord ? `(?<!\\w)${body}(?!\\w)` : body
  const matcher = new RegExp(pattern, rule.caseSensitive ? 'g' : 'gi')
  return text.replace(matcher, (match) => {
    // Mirror a leading capital from the match onto the replacement.
    if (rule.matchCasing && rule.replace && !rule.caseSensitive && startsUppercase(match))
      return rule.replace.charAt(0).toUpperCase() + rule.replace.slice(1)
    return rule.replace
  })
}

/** Apply every rule, in order, to a string (later rules see earlier results). */
export function applyTextReplacements(text: string, rules: TextReplacement[]): string {
  return rules.reduce((acc, rule) => applyTextReplacement(acc, rule), text)
}
