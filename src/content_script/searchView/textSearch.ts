/**
 * Searching inside works' own text — the half of the search view's work-text
 * search that decides anything: what a stored work's searchable text is, what a
 * query asks for, which works answer it, and the excerpt that shows why.
 *
 * Pure — no `#common`, no `browser`, no DOM, no imports at all — so it loads
 * under a plain `node --test`. Where the text comes from is the host's business,
 * handed in as a {@link WorkTextSource}: an exported file unpacks its own
 * compressed copies, and the extension reads its work-text cache.
 *
 * The text is far too big to match on every keystroke the way the view's own
 * search box matches titles and tags, so a search is a pass over the works, in
 * batches, that can be abandoned part way. What it reads is kept, folded, for
 * the next query: refining a search is the common case, and the second pass
 * should cost nothing but the matching.
 */

/** Where a searcher gets the stored markup of each work. */
export interface WorkTextSource {
  /** Whether a work has a stored copy at all. A work without one is never asked for. */
  has: (workId: string) => boolean
  /**
   * The stored markup of each of `workIds`. A work whose copy can't be read is
   * simply absent from the result; a rejection fails the whole search.
   */
  load: (workIds: string[]) => Promise<{ [workId: string]: string }>
  /** Works asked of {@link load} at once. */
  batchSize?: number
  /**
   * Characters of folded text kept between searches. Past it, a search still
   * reads every work, but loads the ones that didn't fit afresh each time.
   */
  budgetChars?: number
}

export interface TextSearchResult {
  /** The works whose text holds every term. */
  hits: Set<string>
  /** Works whose text was read and matched against. */
  searched: number
  /** Works asked about that had no text to search: never stored, or unreadable. */
  unavailable: number
}

export interface TextSearchOptions {
  signal?: AbortSignal
  /** Called before the first work is read and after every batch, over the works with a stored copy. */
  onProgress?: (done: number, total: number) => void
}

/** The stretch of a work's text around a match, for drawing with the match marked. */
export interface TextSnippet {
  before: string
  match: string
  after: string
  /** Whether text was cut off before {@link before}. */
  clippedStart: boolean
  /** Whether text was cut off after {@link after}. */
  clippedEnd: boolean
}

export interface WorkTextSearcher {
  has: (workId: string) => boolean
  search: (workIds: readonly string[], query: string, opts?: TextSearchOptions) => Promise<TextSearchResult>
  /** Where the query first matches one work's text; null when it doesn't, or the work has no text. */
  snippet: (workId: string, query: string) => Promise<TextSnippet | null>
}

const DEFAULT_BATCH_SIZE = 25

/**
 * Enough for a few hundred novel-length works, as one copy of each in memory —
 * which is what an iPad holding an exported library has to be able to afford.
 */
const DEFAULT_BUDGET_CHARS = 32_000_000

/** How long a search may hold the page before letting it paint. */
const SLICE_MS = 12

/** Characters either side of a match in a {@link TextSnippet}. */
const SNIPPET_RADIUS = 90

/** A tag, where a `>` inside a quoted attribute value doesn't end it. */
const TAG = /<(?:[^>"]|"[^"]*")*>/g

/**
 * Tags that end a run of words. Every other tag is dropped without a trace, so
 * `<em>em</em>phasis` stays one word; these leave a space, so one paragraph's
 * last word doesn't run into the next one's first.
 */
const BLOCK_TAG = /<\/?(?:address|article|aside|blockquote|br|center|dd|details|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)\b(?:[^>"]|"[^"]*")*>/gi

const COMMENT = /<!--[\s\S]*?-->/g

/**
 * Where the work itself starts in a stored copy. What comes before it is the
 * meta block — tags and stats, which the view's own search box already covers,
 * and whose "Words:" and "Kudos:" would otherwise match in every work.
 */
const WORKSKIN = /<div(?:\s[^>]*?)?\sid="workskin"/

const ENTITY = /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi

/**
 * The named entities a serialized DOM writes into text: it escapes `&`, `<`,
 * `>` and the non-breaking space and nothing else, and the quotes are here for
 * markup that came from somewhere less tidy. Anything unknown is left as it was.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '\'',
  nbsp: ' ',
}

const SINGLE_QUOTES = /[‘’‚‛′ʼ]/g
const DOUBLE_QUOTES = /[“”„‟″]/g

/** A quoted phrase (to the end, if the quote is never closed), or a bare word. */
const QUERY_TOKEN = /"([^"]*)"?|([^\s"]+)/g

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (entity, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined)
      return NAMED_ENTITIES[name.toLowerCase()] ?? entity
    const code = dec !== undefined ? Number(dec) : Number.parseInt(hex!, 16)
    return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : entity
  })
}

/**
 * A stored work's text as a reader sees it: the work from its title down, with
 * the markup gone, the entities decoded and every run of whitespace one space.
 * Case is kept — this is also what a {@link TextSnippet} is cut from.
 */
export function workTextOf(html: string): string {
  const start = html.search(WORKSKIN)
  const work = start === -1 ? html : html.slice(start)
  const text = work.replace(COMMENT, ' ').replace(BLOCK_TAG, ' ').replace(TAG, '')
  return decodeEntities(text).replace(/\s+/g, ' ').trim()
}

/**
 * Text as it is matched: lowercased, with curly quotes straightened, so a query
 * typed `don't` finds a work that prints `don’t`. Never changes the length (bar
 * the odd character whose lowercase form is longer), which is what lets a match
 * found in folded text be read back out of the original.
 */
export function foldText(text: string): string {
  return text.toLowerCase().replace(SINGLE_QUOTES, '\'').replace(DOUBLE_QUOTES, '"')
}

/**
 * A query's terms, folded: each word on its own, and each quoted run as one
 * phrase. Curly quotes delimit a phrase too, since a phone keyboard turns every
 * typed quote into one. A term given twice is kept once.
 */
export function parseTextQuery(query: string): string[] {
  const terms: string[] = []
  for (const [, phrase, word] of foldText(query).matchAll(QUERY_TOKEN)) {
    const term = (phrase ?? word ?? '').replace(/\s+/g, ' ').trim()
    if (term && !terms.includes(term))
      terms.push(term)
  }
  return terms
}

/** Whether folded text holds every term — anywhere, inside words too, as the view's own search box matches. */
export function textMatches(folded: string, terms: readonly string[]): boolean {
  return terms.every(term => folded.includes(term))
}

/**
 * The text around the earliest place any term matches, roughly `radius`
 * characters either side and cut back to whole words. Null when no term matches.
 */
export function textSnippet(plain: string, terms: readonly string[], radius: number = SNIPPET_RADIUS): TextSnippet | null {
  const folded = foldText(plain)
  // Read back out of the original unless folding moved things, in which case the
  // folded text is the only one the positions are true of.
  const source = folded.length === plain.length ? plain : folded
  let at = -1
  let length = 0
  for (const term of terms) {
    const found = folded.indexOf(term)
    if (found !== -1 && (at === -1 || found < at)) {
      at = found
      length = term.length
    }
  }
  if (at === -1)
    return null

  let start = Math.max(0, at - radius)
  if (start > 0 && source[start - 1] !== ' ') {
    const space = source.indexOf(' ', start)
    if (space !== -1 && space < at)
      start = space + 1
  }
  const matchEnd = at + length
  let end = Math.min(source.length, matchEnd + radius)
  if (end < source.length && source[end] !== ' ') {
    const space = source.lastIndexOf(' ', end)
    if (space > matchEnd)
      end = space
  }
  return {
    before: source.slice(start, at),
    match: source.slice(at, matchEnd),
    after: source.slice(matchEnd, end),
    clippedStart: start > 0,
    clippedEnd: end < source.length,
  }
}

function yieldToPage(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

export function createWorkTextSearcher(source: WorkTextSource): WorkTextSearcher {
  const batchSize = Math.max(1, source.batchSize ?? DEFAULT_BATCH_SIZE)
  const budget = source.budgetChars ?? DEFAULT_BUDGET_CHARS
  /** Folded text of the works read so far, while it fits the budget. */
  const folded = new Map<string, string>()
  let foldedChars = 0
  /** Snippets for the latest query only; a new query starts the map over. */
  let snippetTerms = ''
  let snippets = new Map<string, Promise<TextSnippet | null>>()

  function remember(workId: string, text: string): void {
    if (foldedChars + text.length > budget)
      return
    folded.set(workId, text)
    foldedChars += text.length
  }

  async function search(workIds: readonly string[], query: string, opts: TextSearchOptions = {}): Promise<TextSearchResult> {
    const { signal, onProgress } = opts
    signal?.throwIfAborted()
    const terms = parseTextQuery(query)
    const ids = [...new Set(workIds)]
    const searchable = ids.filter(id => source.has(id))
    const hits = new Set<string>()
    let searched = 0
    onProgress?.(0, searchable.length)

    let sliceStart = Date.now()
    for (let at = 0; at < searchable.length; at += batchSize) {
      signal?.throwIfAborted()
      const batch = searchable.slice(at, at + batchSize)
      const missing = batch.filter(id => !folded.has(id))
      const loaded = missing.length ? await source.load(missing) : {}
      for (const id of batch) {
        let text = folded.get(id)
        if (text === undefined) {
          const html = loaded[id]
          if (typeof html !== 'string')
            continue
          text = foldText(workTextOf(html))
          remember(id, text)
        }
        searched++
        if (textMatches(text, terms))
          hits.add(id)
      }
      onProgress?.(Math.min(at + batchSize, searchable.length), searchable.length)
      if (Date.now() - sliceStart > SLICE_MS) {
        await yieldToPage()
        sliceStart = Date.now()
      }
    }
    signal?.throwIfAborted()
    return { hits, searched, unavailable: ids.length - searched }
  }

  function snippet(workId: string, query: string): Promise<TextSnippet | null> {
    const terms = parseTextQuery(query)
    if (!terms.length || !source.has(workId))
      return Promise.resolve(null)
    const key = terms.join('\u0000')
    if (key !== snippetTerms) {
      snippetTerms = key
      snippets = new Map()
    }
    let found = snippets.get(workId)
    if (!found) {
      // An excerpt is decoration; a copy that won't load just goes without one.
      found = source.load([workId]).then(
        (loaded) => {
          const html = loaded[workId]
          return typeof html === 'string' ? textSnippet(workTextOf(html), terms) : null
        },
        () => null,
      )
      snippets.set(workId, found)
    }
    return found
  }

  return { has: source.has, search, snippet }
}

/** What a work-text search is doing, for {@link describeTextSearch} to put in words. */
export type TextSearchPhase
  = | { kind: 'idle', searchable: number, total: number }
    | { kind: 'searching', done: number, total: number }
    | { kind: 'done', hits: number, searched: number, unavailable: number }
    | { kind: 'failed', message: string }

const NOTHING_TO_SEARCH = 'No work here has saved text to search'

function works(n: number): string {
  return `${n} ${n === 1 ? 'work' : 'works'}`
}

/** The line under the work-text search box. */
export function describeTextSearch(phase: TextSearchPhase): string {
  switch (phase.kind) {
    case 'idle': {
      const { searchable, total } = phase
      if (searchable === 0)
        return NOTHING_TO_SEARCH
      if (searchable < total)
        return `Searches the ${searchable} of ${works(total)} with saved text`
      return total === 1 ? 'Searches the saved text of the work' : `Searches the saved text of all ${works(total)}`
    }
    case 'searching':
      return `Searching… ${phase.done} of ${phase.total}`
    case 'done': {
      const { hits, searched, unavailable } = phase
      if (searched === 0)
        return NOTHING_TO_SEARCH
      const found = hits > 0
        ? `Found in ${hits} of ${works(searched)}`
        : searched === 1 ? 'Not found in the work' : `Not found in any of ${works(searched)}`
      if (unavailable === 0)
        return found
      return `${found} · ${works(unavailable)} without saved text ${unavailable === 1 ? 'was' : 'were'} not searched`
    }
    case 'failed':
      return `Couldn't search the text: ${phase.message}`
  }
}
