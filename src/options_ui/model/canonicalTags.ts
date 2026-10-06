import type { RuleTarget } from '../../common/data.ts'
import type { FandomCache } from '../../common/fandomCache.ts'
import type { ArchivePause } from '../../content_script/archiveFetch.ts'
import type { RuleDraft } from './ruleEditor.ts'
import type { SuggestRequest, SuggestState } from './tagSuggestions.ts'

import { isTagTarget, TagType } from '../../common/data.ts'
import { compilePattern, suggestSource } from './ruleEditor.ts'
import { markSpans } from './settingsSearch.ts'
import { MIN_TERM, suggestRequest, whenDue } from './tagSuggestions.ts'

/**
 * The rule editor's preview of the canonical tags a Regex pattern matches.
 * AO3 has no regex search, and only fandoms ship as a list, so the preview
 * filters the names known here: the bundled fandoms (lower case, as the index
 * keeps them), the tags learned while browsing, and the archive's fixed
 * rating, warning and category names. Each press of the preview also asks
 * AO3's autocomplete about the pattern's longest literal runs, a few at most,
 * and filters its answers through the pattern too.
 *
 * Asking AO3 reuses the suggestions' {@link SuggestState}: what a press asks
 * is kept until the editor closes, and a refusal, a breather or a failure
 * stops the press rather than waiting.
 */

/**
 * A quantifier, by its least count: `?` and `*` let the atom before them match
 * nothing, `+` and `{n,…}` repeat it. A lazy `?` after it changes nothing here.
 */
const QUANTIFIER = /^(?:([*?])|(\+)|\{(\d+)(?:,\d*)?\})\??/

/** A group's opening after its `(`: non-capturing, a lookaround, a name, or flags. */
const GROUP_HEAD = /^\?(?:<?[=!]|<[^>]*>|[a-z-]*:)/i

/**
 * The text a pattern matches as written: its longest literal runs of two or
 * more characters, at most `max`, longest first. A run ends at anything that
 * isn't a character matched as itself, and leaves out a character a quantifier
 * lets match nothing; a negative lookaround's text, which must not be there,
 * is no run. Each run is trimmed, its spaces collapsed, and a run given again
 * in another case is given once.
 */
export function literalRuns(pattern: string, max: number): string[] {
  const runs: string[] = []
  let run = ''
  let at = 0

  const end = () => {
    runs.push(run)
    run = ''
  }

  /** Steps past the quantifier at `at`, if any, and gives its least count. */
  const quantifier = (): number | null => {
    const found = QUANTIFIER.exec(pattern.slice(at))
    if (!found)
      return null
    at += found[0].length
    return found[1] ? 0 : found[2] ? 1 : Number(found[3])
  }

  /** A character matched as itself. A repeated one ends a run and starts the next. */
  const literal = (char: string) => {
    const least = quantifier()
    if (least === 0)
      return end()
    run += char
    if (least !== null) {
      end()
      run = char
    }
  }

  /** Anything else: a class, any character, an assertion, a group's edge. */
  const other = () => {
    end()
    quantifier()
  }

  /** Steps past a bracketed class, from just inside its `[`. */
  const skipClass = () => {
    while (at < pattern.length) {
      const char = pattern[at++]
      if (char === '\\')
        at++
      else if (char === ']')
        return
    }
  }

  /** Steps past a group, from just inside its `(`. */
  const skipGroup = () => {
    for (let depth = 1; at < pattern.length && depth;) {
      const char = pattern[at++]
      if (char === '\\')
        at++
      else if (char === '[')
        skipClass()
      else if (char === '(')
        depth++
      else if (char === ')')
        depth--
    }
  }

  const group = () => {
    end()
    const head = GROUP_HEAD.exec(pattern.slice(at))
    if (head?.[0].endsWith('!')) {
      skipGroup()
      quantifier()
    }
    else if (head) {
      at += head[0].length
    }
  }

  const escape = () => {
    const char = pattern[at++]
    if (char === undefined)
      return end()
    const code = char === 'x' ? /^[\da-f]{2}/i.exec(pattern.slice(at)) : char === 'u' ? /^[\da-f]{4}/i.exec(pattern.slice(at)) : null
    if (code) {
      at += code[0].length
      return literal(String.fromCharCode(Number.parseInt(code[0], 16)))
    }
    const braced = (char === 'k' && pattern[at] === '<') || ((char === 'p' || char === 'P') && pattern[at] === '{')
    if (braced) {
      const close = pattern.indexOf(char === 'k' ? '>' : '}', at)
      at = close === -1 ? pattern.length : close + 1
      return other()
    }
    if (char === 'c' && /[a-z]/i.test(pattern[at] ?? ''))
      at++
    if (/[\dbBcdDfnrsStvwW]/.test(char))
      return other()
    literal(char)
  }

  while (at < pattern.length) {
    const char = pattern[at++]!
    switch (char) {
      case '\\':
        escape()
        break
      case '[':
        skipClass()
        other()
        break
      case '(':
        group()
        break
      case ')':
      case '.':
        other()
        break
      case '|':
      case '^':
      case '$':
      case '*':
      case '+':
      case '?':
        end()
        break
      default:
        literal(char)
    }
  }
  end()

  const seen = new Set<string>()
  return runs
    .map(text => text.trim().replace(/\s+/g, ' '))
    .filter((text) => {
      const key = text.toLowerCase()
      if ([...text].length < MIN_TERM || seen.has(key))
        return false
      seen.add(key)
      return true
    })
    .sort((a, b) => [...b].length - [...a].length)
    .slice(0, max)
}

/** Where a known name comes from. */
export type TagOrigin = 'bundled' | 'learned' | 'fixed' | 'ao3'

export interface PoolTag {
  name: string
  from: TagOrigin
}

/** A name the pattern matches, and as HTML with its match marked. */
export interface CanonicalMatch extends PoolTag {
  /** Escaped, and its only tags are the `<mark>`s. */
  html: string
}

export type CanonicalMatches = { shown: CanonicalMatch[], total: number, poolSize: number } | { invalid: string }

/**
 * The names in `pool` the pattern matches, as a live rule matches them
 * (ignoring case), A to Z, at most `cap` of them, each with its match marked;
 * or the engine's reason for refusing the pattern. A name known from several
 * places counts once, in a spelling of its own rather than the bundled list's
 * lower case.
 */
export function canonicalMatches(pattern: string, pool: readonly PoolTag[], cap: number): CanonicalMatches {
  const regex = compilePattern(pattern)
  if (typeof regex === 'string')
    return { invalid: regex }

  const known = new Map<string, PoolTag>()
  for (const tag of pool) {
    const key = tag.name.toLowerCase()
    const had = known.get(key)
    if (!had || (had.from === 'bundled' && tag.from !== 'bundled'))
      known.set(key, tag)
  }

  const matched: { key: string, tag: PoolTag, match: RegExpExecArray }[] = []
  for (const [key, tag] of known) {
    const match = regex.exec(tag.name)
    if (match)
      matched.push({ key, tag, match })
  }
  matched.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  return {
    shown: matched.slice(0, cap).map(({ tag, match }) => ({
      ...tag,
      html: markSpans(tag.name, match[0] ? [[match.index, match.index + match[0].length]] : []),
    })),
    total: matched.length,
    poolSize: known.size,
  }
}

/** The names known here, loaded for a press: the bundled fandoms and what browsing has learned. */
export interface KnownTags {
  /** The bundled fandoms' names, in the lower case the index keeps them in. */
  bundled: readonly string[]
  learned: FandomCache
}

/** Which kinds of learned tag each target's pool holds. */
const LEARNED: Partial<Record<RuleTarget, readonly (keyof FandomCache)[]>> = {
  tag: ['fandoms', 'characters', 'relationships'],
  [TagType.Fandom]: ['fandoms'],
  [TagType.Character]: ['characters'],
  [TagType.Relationship]: ['relationships'],
}

/** Whether a target's pool holds the bundled fandoms, which are only worth loading for one that does. */
export function usesBundledFandoms(target: RuleTarget): boolean {
  return target === 'tag' || target === TagType.Fandom
}

function fixedNames(target: RuleTarget): readonly string[] {
  const source = suggestSource(target)
  return source.kind === 'fixed' ? source.names : []
}

/**
 * The names known here for a target: a fandom's are the bundled fandoms and
 * those learned while browsing; a character's or a relationship's, those
 * learned; a rating's, a warning's or a category's, the archive's fixed names;
 * any tag's, all of them. Additional tags have none.
 */
export function canonicalPool(target: RuleTarget, known: KnownTags): PoolTag[] {
  const fixed = target === 'tag' ? TagType.values().flatMap(fixedNames) : fixedNames(target)
  return [
    ...usesBundledFandoms(target) ? known.bundled.map(name => ({ name, from: 'bundled' as const })) : [],
    ...(LEARNED[target] ?? []).flatMap(kind => Object.values(known.learned[kind]).map(tag => ({ name: tag.name, from: 'learned' as const }))),
    ...fixed.map(name => ({ name, from: 'fixed' as const })),
  ]
}

/** Whether the preview is offered: in Regex mode, for any kind of tag. */
export function offersCanonical(draft: Pick<RuleDraft, 'target' | 'matcher'>): boolean {
  return draft.matcher === 'regex' && isTagTarget(draft.target)
}

/** The most AO3 is asked on one press. */
export const MAX_ASKS = 3

/** One question a press asks AO3: a literal run of the pattern, as written, and the request asking about it. */
export interface CanonicalAsk {
  run: string
  request: SuggestRequest
}

/**
 * What a press asks AO3: its autocomplete for the target's kind, about each of
 * the pattern's longest literal runs ({@link literalRuns}), as AO3's widget
 * asks. Nothing for a target with fixed names or none, or for a pattern the
 * engine refuses.
 */
export function canonicalAsks(target: RuleTarget, pattern: string): CanonicalAsk[] {
  const source = suggestSource(target)
  if (source.kind !== 'ao3' || typeof compilePattern(pattern) === 'string')
    return []
  return literalRuns(pattern, MAX_ASKS).flatMap((run) => {
    const request = suggestRequest(source, 'exact', run)
    return request ? [{ run, request }] : []
  })
}

/** A press: the answers had are kept, and whatever stopped the last press's asking is forgotten. */
export function withPress(state: SuggestState): SuggestState {
  return { ...state, asking: null, skipped: null, pausedUntil: 0, failed: false }
}

/**
 * The next of a press's asks to send, in turn, given the archive's pause: none
 * once every one is answered, and none for the rest of the press once a
 * refusal, a breather or a failure has stopped it. An answer already had is
 * not asked again.
 */
export function nextAsk(state: SuggestState, asks: readonly CanonicalAsk[], pause: ArchivePause | null): { state: SuggestState, send: SuggestRequest | null } {
  const ask = asks.find(({ request }) => !Object.hasOwn(state.answers, request.path))
  if (!ask || state.failed || state.pausedUntil || state.skipped)
    return { state, send: null }
  const due = whenDue(state, ask.request, pause)
  return { state: due.state, send: due.send ? ask.request : null }
}

/** The most names the preview shows. */
export const CANONICAL_CAP = 50

/**
 * What the preview shows: a head line counting the matches among the names
 * known and naming AO3's part, the names, a line when there are more than it
 * shows or none, and a note on AO3.
 */
export interface CanonicalPreview {
  head: string | null
  sources: string | null
  rows: readonly CanonicalMatch[]
  more: string | null
  empty: string | null
  note: string | null
}

const BLANK: CanonicalPreview = { head: null, sources: null, rows: [], more: null, empty: null, note: null }

const NOUNS: Record<'tag' | TagType, string> = {
  tag: 'tags',
  [TagType.Rating]: 'Ratings',
  [TagType.ArchiveWarning]: 'Archive Warnings',
  [TagType.Category]: 'Categories',
  [TagType.Fandom]: 'Fandoms',
  [TagType.Relationship]: 'Relationships',
  [TagType.Character]: 'Characters',
  [TagType.Freeform]: 'Additional Tags',
}

/** Why AO3's part is missing. */
const NOTES = {
  refused: 'AO3 asked us to slow down',
  failed: 'AO3’s suggestions are unavailable',
  paced: 'Requests to AO3 are pausing for a moment',
} as const

/** What a note adds while there are names known here to show. */
const LOCAL_ONLY = ' — showing known tags only'

const ASKING = 'Asking AO3…'

function askNote(state: SuggestState, asks: readonly CanonicalAsk[], local: boolean): string | null {
  const paths = asks.map(({ request }) => request.path)
  if (!paths.length)
    return null
  const why = state.pausedUntil
    ? NOTES.refused
    : state.failed
      ? NOTES.failed
      : state.skipped !== null && paths.includes(state.skipped) ? NOTES.paced : null
  if (why)
    return local ? `${why}${LOCAL_ONLY}` : why
  return state.asking !== null && paths.includes(state.asking) ? ASKING : null
}

const count = (n: number) => n.toLocaleString('en')

/**
 * The preview of the canonical tags `pattern` matches, from the names known
 * here for the target (`local`, null while they load) and AO3's answers to the
 * last press's `asks`. Under a refusal, offline, or due a breather, the names
 * known here show with a note; a target with none shows only the note.
 */
export function canonicalPreview(input: { target: RuleTarget, pattern: string, local: readonly PoolTag[] | null, asks: readonly CanonicalAsk[], state: SuggestState }): CanonicalPreview {
  const { target, pattern, local, asks, state } = input
  if (!local)
    return { ...BLANK, head: 'Loading the known tags…' }
  if (!pattern.trim())
    return { ...BLANK, head: 'No pattern yet' }

  const answered = asks.filter(({ request }) => Object.hasOwn(state.answers, request.path))
  const ao3 = answered.flatMap(({ request }) => state.answers[request.path]!.map(name => ({ name, from: 'ao3' as const })))
  const found = canonicalMatches(pattern, [...local, ...ao3], CANONICAL_CAP)
  if ('invalid' in found)
    return { ...BLANK, head: 'Fix the pattern to see matches' }

  const noun = isTagTarget(target) ? NOUNS[target] : NOUNS.tag
  const note = askNote(state, asks, local.length > 0)
  if (!found.poolSize && !answered.length)
    return { ...BLANK, note, empty: note ? null : `No known canonical ${noun}, and nothing in the pattern to ask AO3 for.` }

  return {
    head: `${count(found.total)} of ${count(found.poolSize)} known canonical ${noun}`,
    sources: answered.length
      ? `${local.length ? 'plus' : 'from'} AO3’s suggestions for ${answered.map(({ run }) => `“${run}”`).join(', ')}`
      : null,
    rows: found.shown,
    more: found.total > found.shown.length ? `The first ${found.shown.length} are shown.` : null,
    empty: found.total ? null : 'No canonical tags match this pattern.',
    note,
  }
}
