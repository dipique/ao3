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
 * What a tag filter does with works/tags it matches:
 * - `'hide'` (or missing): hide the work. The default.
 * - `'invert'`: force-show the work even if another filter would hide it. Also
 *   highlights the matching tag by default (a force-shown work usually wants to
 *   stand out); opt out by setting `color` to `'transparent'`.
 * - `'highlight'`: visually highlight the matching tag, without affecting whether
 *   the work is hidden.
 */
export type TagFilterBehavior = 'hide' | 'invert' | 'highlight'

/**
 * A pleasant, visible-but-not-loud default highlight colour: a translucent
 * amber (`#rrggbbaa`, ~62% opacity) so it reads as a gentle wash rather than a
 * loud block. Users can override the default in options (see
 * `Options.hideTags.defaultHighlightColor`), and any filter can set its own.
 */
export const DEFAULT_HIGHLIGHT_COLOR = '#ffe0829e'

export interface TagFilter {
  /** Value of the filter. Will be Tag.name if matcher === exact */
  name: string
  /** Type of the tag. If not provided, the filter will match all types. */
  type?: TagType
  /** How to match */
  matcher: 'exact' | 'contains' | 'regex'
  /** What to do with matching works/tags. Missing is treated as `'hide'`. */
  behavior?: TagFilterBehavior
  /**
   * Highlight colour (any CSS color) used when the filter highlights its
   * matching tag — i.e. when `behavior === 'highlight'`, or `behavior ===
   * 'invert'` and not opted out. The literal `'transparent'` on an invert
   * filter means "no highlight". See {@link tagFilterHighlightColor}.
   */
  color?: string
}

/**
 * The colour a filter should highlight its matching tags with, or `null` if it
 * does not highlight. Highlight filters always highlight; invert filters
 * highlight too (so force-shown works stand out) unless their colour is the
 * sentinel `'transparent'` ("No highlight"). A filter with no explicit colour
 * falls back to `defaultColor` (the user-configurable default highlight colour),
 * which itself defaults to {@link DEFAULT_HIGHLIGHT_COLOR}.
 */
export function tagFilterHighlightColor(filter: TagFilter, defaultColor: string = DEFAULT_HIGHLIGHT_COLOR): string | null {
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
  /** If true, the filter will be inverted - excluding rather than including from the hide list - therefore force-showing. */
  invert?: boolean
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
