/**
 * The query language of both the search view's boxes — the one over titles and
 * tags and the one that searches inside works — and the matching it asks for.
 *
 * As on AO3: words, "quoted phrases", `OR` (or `||`), `NOT` and parentheses.
 * Words side by side must all appear. `OR` binds tighter than that, so
 * `fluff harry OR draco` asks for fluff and either name; `NOT` tighter still,
 * taking the one word, phrase or group after it. The operators count only in
 * capitals: in lower case they are words, and AO3's own warnings hold a "not".
 * A `-` directly before a term is the same as `NOT`; later in a word, on its own
 * or inside quotes it is just text.
 * Every word and phrase matches anywhere in the text, inside words too, except
 * a single word in quotes, which matches only as a whole word: `"school"` finds
 * "school" and "after-school", never "preschool".
 *
 * Both boxes search as the reader types, so every string is a query: an
 * unclosed quote or parenthesis runs to the end, and an operator with nothing
 * to work on is skipped.
 *
 * Pure — no imports at all — so it loads under a plain `node --test`.
 */

export interface Term {
  kind: 'term'
  /** Folded, with any run of spaces in a phrase made one. */
  text: string
  /** Matches only where no word runs on past either end of it. */
  wholeWord?: true
}

/** A query, read. Null stands for a query with nothing to look for, which every text answers. */
export type TextQuery
  = | Term
    | { kind: 'not', operand: TextQuery }
    | { kind: 'and' | 'or', operands: TextQuery[] }

type Token = Term | { kind: 'or' | 'not' | 'open' | 'close' }

const SINGLE_QUOTES = /[‘’‚‛′ʼ]/g
const DOUBLE_QUOTES = /[“”„‟″]/g

/**
 * A quoted phrase (to the end, if the quote is never closed), `||`, a
 * parenthesis, a `-` with a term straight after it, or a word: a run up to the
 * next space, quote, parenthesis or `||`.
 */
const QUERY_TOKEN = /"([^"]*)"?|(\|\|)|([()])|(-(?=\S))|((?:[^\s"()|]|\|(?!\|))+)/g

/**
 * A character that carries a word on past a match. Scripts written without spaces
 * are left out, since there every letter touches the next and a word in them
 * would otherwise never stand whole.
 */
const WORD_CHAR = String.raw`(?![\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}])[\p{L}\p{N}\p{M}]`
const ENDS_IN_WORD = new RegExp(`${WORD_CHAR}$`, 'u')
const STARTS_IN_WORD = new RegExp(`^${WORD_CHAR}`, 'u')

/**
 * Text as it is matched: lowercased, with curly quotes straightened, so a query
 * typed `don't` finds a work that prints `don’t`. Never changes the length (bar
 * the odd character whose lowercase form is longer), which is what lets a match
 * found in folded text be read back out of the original.
 */
export function foldText(text: string): string {
  return text.toLowerCase().replace(SINGLE_QUOTES, '\'').replace(DOUBLE_QUOTES, '"')
}

/** Curly quotes delimit a phrase too, since a phone keyboard turns every typed quote into one. */
function tokenize(query: string): Token[] {
  const tokens: Token[] = []
  for (const [, phrase, or, paren, minus, word] of query.replace(DOUBLE_QUOTES, '"').matchAll(QUERY_TOKEN)) {
    if (or || word === 'OR') {
      tokens.push({ kind: 'or' })
    }
    else if (minus || word === 'NOT') {
      tokens.push({ kind: 'not' })
    }
    else if (paren) {
      tokens.push({ kind: paren === '(' ? 'open' : 'close' })
    }
    else if (word !== '-') {
      const text = foldText(phrase ?? word ?? '').replace(/\s+/g, ' ').trim()
      if (text)
        tokens.push(phrase !== undefined && !text.includes(' ') ? { kind: 'term', text, wholeWord: true } : { kind: 'term', text })
    }
  }
  return tokens
}

function negate(operand: TextQuery): TextQuery {
  return operand.kind === 'not' ? operand.operand : { kind: 'not', operand }
}

/** `operands` joined by `kind`, with any already joined the same way opened up and repeats dropped. */
function join(kind: 'and' | 'or', operands: TextQuery[]): TextQuery | null {
  const joined: TextQuery[] = []
  const seen = new Set<string>()
  for (const operand of operands.flatMap(o => (o.kind === 'and' || o.kind === 'or') && o.kind === kind ? o.operands : [o])) {
    const key = queryKey(operand)
    if (!seen.has(key)) {
      seen.add(key)
      joined.push(operand)
    }
  }
  return joined.length > 1 ? { kind, operands: joined } : joined[0] ?? null
}

/** What a search box's text asks for, in the language the module comment describes. */
export function parseTextQuery(query: string): TextQuery | null {
  const tokens = tokenize(query)
  let at = 0

  /** Words side by side, up to a closing parenthesis or the end. */
  function all(): TextQuery | null {
    const operands: TextQuery[] = []
    while (at < tokens.length && tokens[at]!.kind !== 'close') {
      const operand = any()
      if (operand)
        operands.push(operand)
    }
    return join('and', operands)
  }

  /** Choices joined by `OR`. */
  function any(): TextQuery | null {
    const operands: TextQuery[] = []
    const first = one()
    if (first)
      operands.push(first)
    while (tokens[at]?.kind === 'or') {
      at++
      const next = one()
      if (next)
        operands.push(next)
    }
    return join('or', operands)
  }

  /** A word, a phrase, a group, or any of them after `NOT`. Takes at least one token, unless at a closing parenthesis or the end. */
  function one(): TextQuery | null {
    const token = tokens[at]
    if (!token || token.kind === 'close')
      return null
    at++
    switch (token.kind) {
      case 'term':
        return token
      case 'or':
        return one()
      case 'not': {
        const operand = one()
        return operand && negate(operand)
      }
      case 'open': {
        const group = all()
        if (tokens[at]?.kind === 'close')
          at++
        return group
      }
    }
  }

  const operands: TextQuery[] = []
  while (at < tokens.length) {
    const operand = all()
    if (operand)
      operands.push(operand)
    // Past a closing parenthesis with nothing open.
    at++
  }
  return join('and', operands)
}

/** Whether one word runs on across a position in folded text. Two code units hold any one character. */
function wordRunsAcross(folded: string, at: number): boolean {
  return ENDS_IN_WORD.test(folded.slice(Math.max(0, at - 2), at)) && STARTS_IN_WORD.test(folded.slice(at, at + 2))
}

/** Where a word or phrase first matches in folded text, or -1. */
export function termIndex(term: Term, folded: string): number {
  let at = folded.indexOf(term.text)
  if (term.wholeWord) {
    while (at !== -1 && (wordRunsAcross(folded, at) || wordRunsAcross(folded, at + term.text.length)))
      at = folded.indexOf(term.text, at + 1)
  }
  return at
}

/** Whether folded text answers the query. */
export function queryMatches(query: TextQuery | null, folded: string): boolean {
  if (!query)
    return true
  switch (query.kind) {
    case 'term': return termIndex(query, folded) !== -1
    case 'not': return !queryMatches(query.operand, folded)
    case 'and': return query.operands.every(operand => queryMatches(operand, folded))
    case 'or': return query.operands.some(operand => queryMatches(operand, folded))
  }
}

/** The words and phrases a query looks for, as opposed to those it excludes: every one outside a `NOT`, once each, in order. */
export function queryTerms(query: TextQuery | null): Term[] {
  if (!query || query.kind === 'not')
    return []
  if (query.kind === 'term')
    return [query]
  const terms = new Map(query.operands.flatMap(operand => queryTerms(operand)).map(term => [queryKey(term), term]))
  return [...terms.values()]
}

/** A query written out one way only, so two that ask the same thing in different spacing, case or spelling compare equal. */
export function queryKey(query: TextQuery | null): string {
  if (!query)
    return ''
  switch (query.kind) {
    case 'term': return `${query.wholeWord ? 'WHOLE ' : ''}"${query.text}"`
    case 'not': return `NOT ${queryKey(query.operand)}`
    case 'and': return `(${query.operands.map(operand => queryKey(operand)).join(' ')})`
    case 'or': return `(${query.operands.map(operand => queryKey(operand)).join(' OR ')})`
  }
}
