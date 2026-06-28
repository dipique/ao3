/**
 * Enum of the tag types that AO3 supports (except "Media" and "Banned" which are not shown on works)
 * @see https://archiveofourown.org/faq/tags#tagtypes
 * @see https://github.com/otwcode/otwarchive/blob/bd57a26224017d4b871fb70a9787d7fe3c29d249/app/models/tag.rb#L15
 *
 * The values are abbreviated to save space in browser.storage
 */
export enum TagType {
  Rating = 'r',
  ArchiveWarning = 'w',
  Category = 'c',
  Fandom = 'f',
  Relationship = 'R',
  Character = 'C',
  Freeform = 'F',
}

// eslint-disable-next-line ts/no-namespace
export declare namespace TagType {
  export function values(): TagType[]
  export function toDisplayString(type: TagType): string
  export function toCSSClass(type: TagType): string
}

Object.defineProperties(TagType, {
  values: {
    enumerable: false,
    value() {
      return Object.values(TagType) as TagType[]
    },
  },
  toDisplayString: {
    enumerable: false,
    value(type: TagType) {
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
  },
  toCSSClass: {
    enumerable: false,
    value(type: TagType) {
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
  },
})

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
 * What a tag or author filter does with the works (and tags/authors) it matches:
 * - `'hide'` (or missing): hide the work. The default.
 * - `'invert'`: force-show the work even if another filter would hide it. Also
 *   highlights the match by default (a force-shown work usually wants to stand
 *   out); opt out by setting `color` to `'transparent'`.
 * - `'highlight'`: visually highlight the match, without affecting whether the
 *   work is hidden.
 *
 * Shared by {@link TagFilter} and {@link AuthorFilter} so the two behave alike.
 */
export type FilterBehavior = 'hide' | 'invert' | 'highlight'

/**
 * A pleasant, visible-but-not-loud default highlight colour for tag filters: a
 * translucent amber (`#rrggbbaa`, ~62% opacity) so it reads as a gentle wash
 * rather than a loud block. Users can override the default in options (see
 * `Options.hideTags.defaultHighlightColor`), and any filter can set its own.
 */
export const DEFAULT_HIGHLIGHT_COLOR = '#ffe0829e'

/**
 * Default highlight colour for author filters — a translucent sky-blue at the
 * same opacity as {@link DEFAULT_HIGHLIGHT_COLOR}. Deliberately a different hue
 * from the tag default so a highlighted author byline reads as distinct from a
 * highlighted tag at a glance. Overridable via `Options.hideAuthors.defaultHighlightColor`.
 */
export const DEFAULT_AUTHOR_HIGHLIGHT_COLOR = '#82b4ff9e'

/**
 * Default highlight colour for work filters — a translucent violet at the same
 * opacity as {@link DEFAULT_HIGHLIGHT_COLOR}. A distinct hue from the tag (amber)
 * and author (blue) defaults so a highlighted work title stands apart at a
 * glance. Overridable via `Options.hideWorks.defaultHighlightColor`.
 */
export const DEFAULT_WORK_HIGHLIGHT_COLOR = '#c9b0ff9e'

/**
 * Default highlight colour for series filters — a translucent mint, again a hue
 * of its own so highlighted series read as distinct from highlighted works,
 * tags, and authors. Overridable via `Options.hideSeries.defaultHighlightColor`.
 */
export const DEFAULT_SERIES_HIGHLIGHT_COLOR = '#9ee8c79e'

export interface TagFilter {
  /** Value of the filter. Will be Tag.name if matcher === exact */
  name: string
  /** Type of the tag. If not provided, the filter will match all types. */
  type?: TagType
  /** How to match */
  matcher: 'exact' | 'contains' | 'regex'
  /** What to do with matching works/tags. Missing is treated as `'hide'`. */
  behavior?: FilterBehavior
  /**
   * Highlight colour (any CSS color) used when the filter highlights its
   * matching tag — i.e. when `behavior === 'highlight'`, or `behavior ===
   * 'invert'` and not opted out. The literal `'transparent'` on an invert
   * filter means "no highlight". See {@link filterHighlightColor}.
   */
  color?: string
}

/**
 * The colour a filter (tag or author) should highlight its match with, or `null`
 * if it does not highlight. Highlight filters always highlight; invert filters
 * highlight too (so force-shown works stand out) unless their colour is the
 * sentinel `'transparent'` ("No highlight"). A filter with no explicit colour
 * falls back to `defaultColor` (the user-configurable default highlight colour),
 * which itself defaults to {@link DEFAULT_HIGHLIGHT_COLOR}.
 */
export function filterHighlightColor(filter: { behavior?: FilterBehavior, color?: string }, defaultColor: string = DEFAULT_HIGHLIGHT_COLOR): string | null {
  switch (filter.behavior) {
    case 'highlight':
      return filter.color || defaultColor
    case 'invert':
      return filter.color === 'transparent' ? null : filter.color || defaultColor
    default:
      return null
  }
}

/** Whether a tag filter matches a given tag (by type, then name/contains/regex). */
export function tagFilterMatchesTag(filter: TagFilter, tag: Tag): boolean {
  if (filter.type !== undefined && filter.type !== tag.type)
    return false

  if (filter.matcher === 'contains')
    return tag.name.toLowerCase().includes(filter.name.toLowerCase())

  if (filter.matcher === 'regex') {
    try {
      return new RegExp(filter.name.toLowerCase()).test(tag.name.toLowerCase())
    }
    catch {
      // An invalid regex matches nothing rather than throwing mid-render.
      return false
    }
  }

  return filter.name === tag.name
}

export interface AuthorFilter {
  /** Value of the filter. */
  userId: string
  /** Value of the filter. */
  pseud?: string
  /**
   * What to do with works by the matching author. Missing is treated as
   * `'hide'`. Mirrors {@link TagFilter.behavior} so authors and tags align.
   *
   * Cross-extension note: upstream AO3 Enhancements expresses force-show with a
   * boolean `invert` flag instead. We don't store `invert` — imports map it onto
   * `behavior` (see {@link filterFromInvert}) and exports re-emit it (see
   * {@link filterWithInvert}) so settings stay usable in both extensions.
   */
  behavior?: FilterBehavior
  /**
   * Highlight colour (any CSS color) used when the filter highlights the
   * author's byline — i.e. when `behavior === 'highlight'`, or `behavior ===
   * 'invert'` and not opted out. The literal `'transparent'` on an invert filter
   * means "no highlight". See {@link filterHighlightColor}.
   */
  color?: string
}

/** Whether an author filter matches a given author (by userId, then optional pseud). */
export function authorFilterMatchesAuthor(filter: AuthorFilter, author: { userId: string, pseud?: string }): boolean {
  return filter.userId === author.userId && (filter.pseud === undefined || filter.pseud === author.pseud)
}

/**
 * A filter that matches a single work or series — by AO3 id or by name. The two
 * share one shape (see {@link WorkFilter}, {@link SeriesFilter}); they differ
 * only in which option list they live in and which default colour they inherit.
 *
 * A purely numeric {@link value} is treated as the entity's id and matched
 * exactly against the id parsed from its link (so e.g. `4232377` hides
 * `/series/4232377` regardless of its title). Any other value matches the
 * entity's display name via {@link matcher}. Behaviour and highlight colour
 * mirror {@link TagFilter}/{@link AuthorFilter} so all four kinds behave alike.
 */
export interface EntityFilter {
  /** A numeric AO3 id (matched against the link's id) or a name to match. */
  value: string
  /** How a non-numeric {@link value} matches the name. A numeric value always matches the id exactly. */
  matcher: 'exact' | 'contains' | 'regex'
  /** What to do with the matching work/series. Missing is treated as `'hide'`. */
  behavior?: FilterBehavior
  /**
   * Highlight colour (any CSS color) used when the filter highlights its match —
   * i.e. when `behavior === 'highlight'`, or `behavior === 'invert'` and not
   * opted out. The literal `'transparent'` on an invert filter means "no
   * highlight". See {@link filterHighlightColor}.
   */
  color?: string
}

/** A filter matching a single work, by work id or title. See {@link EntityFilter}. */
export type WorkFilter = EntityFilter
/** A filter matching a single series, by series id or title. See {@link EntityFilter}. */
export type SeriesFilter = EntityFilter

/** A work or series, as parsed from its link: a numeric id (if known) and display name. */
export interface FilterableEntity {
  /** The id parsed from the entity's `/works/:id` or `/series/:id` link. */
  id?: string
  /** The entity's display name (the link text). */
  name: string
}

/**
 * Whether an entity filter matches a given work/series. A numeric `value`
 * matches the entity's id exactly; otherwise the name is matched using the
 * filter's `matcher` (mirroring {@link tagFilterMatchesTag}: `exact` is
 * case-sensitive, `contains`/`regex` are case-insensitive). An empty value or an
 * invalid regex matches nothing.
 */
export function entityFilterMatches(filter: EntityFilter, entity: FilterableEntity): boolean {
  const value = filter.value.trim()
  if (value === '')
    return false

  // A purely numeric value targets the entity's id (parsed from its link).
  if (/^\d+$/.test(value))
    return entity.id !== undefined && entity.id === value

  if (filter.matcher === 'contains')
    return entity.name.toLowerCase().includes(value.toLowerCase())

  if (filter.matcher === 'regex') {
    try {
      return new RegExp(value.toLowerCase()).test(entity.name.toLowerCase())
    }
    catch {
      // An invalid regex matches nothing rather than throwing mid-render.
      return false
    }
  }

  return entity.name === value
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
