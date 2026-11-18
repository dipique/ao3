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

  /** What a group of tags of this type is called: `Ratings`, `Archive Warnings`, `Additional Tags`. */
  toPluralString(type: TagType): string {
    switch (type) {
      case TagType.Rating: return 'Ratings'
      case TagType.ArchiveWarning: return 'Archive Warnings'
      case TagType.Category: return 'Categories'
      case TagType.Fandom: return 'Fandoms'
      case TagType.Relationship: return 'Relationships'
      case TagType.Character: return 'Characters'
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

/** The user (and pseud, if present) a `/users/:id/pseuds/:pseud` link points at, or null for any other link. */
export function authorFromURL(href: string): { userId: string, pseud?: string } | null {
  const parts = new URL(href).pathname.split('/').filter(Boolean)
  if (parts[0] !== 'users' || !parts[1])
    return null
  return { userId: parts[1], pseud: parts[2] === 'pseuds' ? parts[3] : undefined }
}

/**
 * The `:id` of a `/works/:id` or `/series/:id` link, ignoring any trailing path
 * and the `/collections/:name` a collection's listing puts in front of its
 * titles; undefined for any other link. A relative link is read against `base`.
 */
export function entityIdFromURL(href: string, kind: 'works' | 'series', base?: string): string | undefined {
  try {
    return new URL(href, base).pathname.match(new RegExp(`^(?:/collections/[^/]+)?/${kind}/(\\d+)(?:/|$)`))?.[1]
  }
  catch {
    return undefined
  }
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

/** One side of AO3's Completion Status filter. "All works" is spelled `null` wherever it can be picked. */
export type Completion = 'complete' | 'incomplete'

export const COMPLETION_LABELS: Readonly<Record<Completion, string>> = {
  complete: 'Completed works only',
  incomplete: 'Incomplete works only',
}

/** One side of AO3's Crossovers filter. "Include crossovers" is spelled `null` wherever it can be picked. */
export type Crossovers = 'exclude' | 'only'

export const CROSSOVER_LABELS: Readonly<Record<Crossovers, string>> = {
  exclude: 'No crossovers',
  only: 'Crossovers only',
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
  /**
   * Match through a change of formatting. A work's text is broken into a fresh
   * text node wherever its markup changes, and by default a rule matches within
   * one of those — so `, Love...` never fires against
   * `…I can,<em> Love….</em>`, where the comma and the word are in different
   * nodes. With this set, the rule is matched against the sentence as it reads.
   *
   * Off by default, and per-rule rather than global, because of what a match
   * across a seam has to do on the way out: the replacement is written wholly
   * into the node the match *started* in, taking that node's formatting, and the
   * rest of the match is deleted from the nodes after it. The example above
   * comes out as `…I can, honey<em>.</em>` — the replacement no longer italic,
   * and an orphaned italic full stop left behind. A fair trade for the rule you
   * are deliberately fixing; not something to spring on rules written months ago.
   */
  acrossFormatting?: boolean
  /**
   * Kept in the list but inert. Somewhere to park a rule the reader wants back
   * later — or one of several variants of the same replacement — instead of
   * deleting it, which is otherwise the only way to stop it applying and takes
   * its wording with it.
   */
  disabled?: boolean
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

/** Whether a rule can match anything at all — it has something to find, and is on. */
export function textReplacementActive(rule: TextReplacement): boolean {
  return !!rule.find && !rule.disabled
}

/**
 * The matcher a rule applies. `\b` keys off `\w`, so flanking lookarounds give
 * whole-word matches that work even when `find` starts or ends with punctuation.
 */
function matcherFor(rule: TextReplacement): RegExp {
  const body = escapeRegExp(rule.find)
  const pattern = rule.wholeWord ? `(?<!\\w)${body}(?!\\w)` : body
  return new RegExp(pattern, rule.caseSensitive ? 'g' : 'gi')
}

/** What one match of `rule` is replaced by — mirroring a leading capital if asked. */
function replacementFor(rule: TextReplacement, match: string): string {
  if (rule.matchCasing && rule.replace && !rule.caseSensitive && startsUppercase(match))
    return rule.replace.charAt(0).toUpperCase() + rule.replace.slice(1)
  return rule.replace
}

/** Apply a single replacement rule to a string, returning the new string. */
export function applyTextReplacement(text: string, rule: TextReplacement): string {
  if (!textReplacementActive(rule))
    return text

  // The simplest case — case-sensitive, anywhere — needs no regex.
  if (rule.caseSensitive && !rule.wholeWord) {
    if (!text.includes(rule.find))
      return text
    return text.split(rule.find).join(rule.replace)
  }

  return text.replace(matcherFor(rule), match => replacementFor(rule, match))
}

/**
 * One run of the rewritten text: either a stretch of the source, or what a rule
 * put in its place.
 *
 * {@link TextSpan.rule} indexes the rules array handed to
 * {@link replaceTextSegments} — which is why the whole list is passed even
 * though the inert entries are skipped, so the index still names the rule as the
 * reader's own settings hold it. {@link TextSpan.segment} indexes the segments,
 * and says where the run has to be written back to.
 */
export interface TextSpan {
  text: string
  /**
   * The source segment this run belongs to. For a replacement, the segment its
   * match *started* in — a match that ran on into the next segment leaves that
   * one with only the text after it. The replacement has to go somewhere, and
   * where the match started is the one place the reader pointed at.
   */
  segment: number
  /** Index of the rule that produced this run, or `null` for untouched source text. */
  rule: number | null
  /**
   * For a replacement, the source text it stands in for — what the reader would
   * have seen without any rules. Traced back through earlier rules, so a word two
   * rules rewrote in turn still reports the word the author wrote rather than
   * the one the first rule left behind. Absent on untouched source text.
   *
   * When a later rule rewrites only part of an earlier replacement, the piece it
   * leaves behind and the new run both report that earlier replacement's whole
   * source: neither can say which of its characters became which.
   */
  original?: string
}

/**
 * Apply every rule, in order, to text that arrives in pieces — and report the
 * result as the runs it is made of, each knowing which piece it belongs to.
 *
 * The pieces are the work's text nodes, in reading order, and the seams between
 * them are where its formatting changes: `…I can,` `‑ Love….` `‑ Alright?` is one
 * sentence in three segments because two of the words are italic. The rules are
 * matched against the whole of it rather than against each piece, so a rule can
 * be written the way the sentence reads — but a match that spans a seam is only
 * kept* for a rule that asked for it, with {@link TextReplacement.acrossFormatting}.
 * Everything else behaves as though each segment stood alone, which is what the
 * rules a reader already has were written against.
 *
 * Seams *inside* one segment — left by an earlier rule's replacement — are not
 * formatting, and are never in the way: later rules read straight through them,
 * exactly as they would have if the earlier rule had rewritten a plain string.
 */
export function replaceTextSegments(segments: string[], rules: TextReplacement[]): TextSpan[] {
  let spans: TextSpan[] = segments
    .map((text, segment) => ({ text, segment, rule: null }))
    .filter(span => span.text !== '')

  for (const [index, rule] of rules.entries()) {
    if (textReplacementActive(rule))
      spans = applyRuleToSpans(spans, rule, index)
  }

  return spans
}

/** One rule's pass over the runs so far. Returns `spans` untouched if nothing matched. */
function applyRuleToSpans(spans: TextSpan[], rule: TextReplacement, index: number): TextSpan[] {
  const flat = spans.map(span => span.text).join('')
  if (!flat)
    return spans

  // Which run each character of `flat` came from — how a match is traced back to
  // the segment (and so the text node) it started and ended in.
  const owner: number[] = []
  spans.forEach((span, at) => {
    for (let i = 0; i < span.text.length; i++)
      owner.push(at)
  })
  const segmentAt = (offset: number): number => spans[owner[offset]!]!.segment

  const out: TextSpan[] = []
  let at = 0
  let matched = false

  for (const match of flat.matchAll(matcherFor(rule))) {
    const start = match.index
    const end = start + match[0].length
    if (!rule.acrossFormatting && segmentAt(start) !== segmentAt(end - 1))
      continue

    keepSource(out, spans, flat, owner, at, start)
    out.push({
      text: replacementFor(rule, match[0]),
      segment: segmentAt(start),
      rule: index,
      original: originalOf(spans, flat, owner, start, end),
    })
    at = end
    matched = true
  }

  if (!matched)
    return spans

  keepSource(out, spans, flat, owner, at, flat.length)
  return out.filter(span => span.text !== '')
}

/**
 * Copy `flat[from, to)` into `out` as runs, cut wherever it crosses from one
 * existing run into the next so each piece keeps the segment and rule it already
 * had.
 */
function keepSource(out: TextSpan[], spans: TextSpan[], flat: string, owner: number[], from: number, to: number): void {
  let cut = from
  while (cut < to) {
    const which = owner[cut]!
    let next = cut + 1
    while (next < to && owner[next] === which)
      next++
    const source = spans[which]!
    const piece: TextSpan = { text: flat.slice(cut, next), segment: source.segment, rule: source.rule }
    if (source.original !== undefined)
      piece.original = source.original
    out.push(piece)
    cut = next
  }
}

/**
 * The source text behind `flat[from, to)`: untouched runs give the characters
 * the range covers, and each earlier replacement it touches gives its own
 * source, once, however much of it the range covers.
 */
function originalOf(spans: TextSpan[], flat: string, owner: number[], from: number, to: number): string {
  let text = ''
  let last = -1
  for (let i = from; i < to; i++) {
    const which = owner[i]!
    const source = spans[which]!
    if (source.original === undefined)
      text += flat[i]
    else if (which !== last)
      text += source.original
    last = which
  }
  return text
}

/** Apply every rule, in order, to a string (later rules see earlier results). */
export function applyTextReplacements(text: string, rules: TextReplacement[]): string {
  return replaceTextSegments([text], rules).map(span => span.text).join('')
}
