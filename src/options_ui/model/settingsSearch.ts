/**
 * The settings search: which rows a query keeps, and their text with the hits
 * marked. A query is whitespace-separated terms, every one of which must appear
 * somewhere in a row's title or description, ignoring case and accents.
 */

/** One settings row as the search sees it: where it sits, and what it says. */
export interface SettingsRow {
  /** The titles of the category and sub-section holding it. */
  category: string | null
  subsection: string | null
  title: string
  subtitle: string
}

/** Lowercase and strip accents, so "précis" is found by typing "precis". */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

export function searchTerms(query: string): string[] {
  return normalize(query).split(/\s+/).filter(Boolean)
}

/** Whether every term appears in `text`. No terms matches everything. */
export function textMatches(text: string, terms: readonly string[]): boolean {
  const haystack = normalize(text)
  return terms.every(term => haystack.includes(term))
}

/** No terms matches everything. */
export function entryMatches(entry: Pick<SettingsRow, 'title' | 'subtitle'>, terms: readonly string[]): boolean {
  return textMatches(`${entry.title} ${entry.subtitle}`, terms)
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[char]!))
}

/**
 * `text` normalized one code point at a time, with the span of `text` each
 * normalized unit came from. Normalizing can change the length — a letter
 * written with a separate combining accent loses the accent — so a hit's
 * position in the normalized copy is not its position in the text.
 */
function folded(text: string): { hay: string, from: number[], to: number[] } {
  let hay = ''
  const from: number[] = []
  const to: number[] = []
  let at = 0
  for (const char of text) {
    const unit = normalize(char)
    const end = at + char.length
    if (unit) {
      hay += unit
      for (let i = 0; i < unit.length; i++) {
        from.push(at)
        to.push(end)
      }
    }
    else {
      // A character that normalizes to nothing stays with the one before it,
      // so a mark never parts an accent from its letter.
      for (let i = to.length - 1; i >= 0 && to[i] === at; i--)
        to[i] = end
    }
    at = end
  }
  return { hay, from, to }
}

/**
 * `text` as HTML, with every hit of a term wrapped in `<mark>`. The text is
 * escaped around and inside the marks, so the marks are the only tags that
 * can come out of it and the result is safe to hand to `v-html`.
 */
export function highlight(text: string, terms: readonly string[]): string {
  return markSpans(text, hits(text, terms))
}

/** Where each term is found in `text`, as `[start, end)` spans of it. */
function hits(text: string, terms: readonly string[]): Array<[number, number]> {
  if (!terms.length)
    return []
  const { hay, from, to } = folded(text)
  const spans: Array<[number, number]> = []
  for (const term of terms.filter(Boolean)) {
    for (let at = hay.indexOf(term); at !== -1; at = hay.indexOf(term, at + term.length))
      spans.push([from[at]!, to[at + term.length - 1]!])
  }
  return spans
}

/**
 * {@link highlight}, with `strong`'s phrases drawn bold: the first of each,
 * found in turn from where the last ended, wrapped in `<strong>`. A hit can run
 * into a bold phrase or out of it; the marks are drawn inside the bold.
 */
export function highlightWithStrong(text: string, terms: readonly string[], strong: readonly string[]): string {
  const bold: Array<[number, number]> = []
  let after = 0
  for (const phrase of strong) {
    const at = text.indexOf(phrase, after)
    if (at === -1)
      continue
    bold.push([at, at + phrase.length])
    after = at + phrase.length
  }
  const marks = hits(text, terms)
  let out = ''
  let at = 0
  for (const [start, end] of bold) {
    out += markSpans(text.slice(at, start), within(marks, at, start))
    out += `<strong>${markSpans(text.slice(start, end), within(marks, start, end))}</strong>`
    at = end
  }
  return out + markSpans(text.slice(at), within(marks, at, text.length))
}

/** The parts of `spans` between `start` and `end`, counted from `start`. */
function within(spans: readonly (readonly [number, number])[], start: number, end: number): Array<[number, number]> {
  return spans
    .map(([from, to]): [number, number] => [Math.max(from, start) - start, Math.min(to, end) - start])
    .filter(([from, to]) => from < to)
}

/**
 * `text` as HTML, with each span of it, `[start, end)` in UTF-16 units,
 * wrapped in `<mark>`; spans that overlap or touch make one mark. Escaped as
 * {@link highlight} is, so it too is safe to hand to `v-html`.
 */
export function markSpans(text: string, spans: readonly (readonly [number, number])[]): string {
  const merged: Array<[number, number]> = []
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1)
    if (last && start <= last[1])
      last[1] = Math.max(last[1], end)
    else
      merged.push([start, end])
  }

  let out = ''
  let at = 0
  for (const [start, end] of merged) {
    out += `${escapeHtml(text.slice(at, start))}<mark>${escapeHtml(text.slice(start, end))}</mark>`
    at = end
  }
  return out + escapeHtml(text.slice(at))
}
