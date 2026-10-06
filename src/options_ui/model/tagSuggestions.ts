import type { Rule } from '../../common/data.ts'
import type { ArchivePause } from '../../content_script/archiveFetch.ts'
import type { SuggestSource } from './ruleEditor.ts'

import { highlight, searchTerms, textMatches } from './settingsSearch.ts'

/**
 * Suggestions for a rule's value: when the rule editor asks AO3's tag
 * autocomplete, what it keeps of the answers, and what the box under the value
 * field shows. The editor holds a {@link SuggestState} from opening to
 * closing; each function here takes it and returns the next.
 *
 * A suggestion is only worth having while the reader types, so a request that
 * would have to wait for the archive is never kept to send later. Under a
 * refusal nothing is sent and suggestions pause until it ends; a request due a
 * breather between sets is skipped.
 */

/** One question to AO3's autocomplete: its endpoint, the term as sent, and the path that asks it, which names it. */
export interface SuggestRequest {
  endpoint: string
  term: string
  path: string
}

/** The fewest characters worth asking about: one letter only finds names holding it as a word of its own. */
export const MIN_TERM = 2

/** How long typing must pause before the field's term is asked about. */
export const SUGGEST_DELAY_MS = 300

/**
 * The request an Exact field holding `value` makes of `source`, or null when it
 * makes none: another matcher, a source that isn't AO3's, or fewer than two
 * characters. The term is trimmed and lowercased, as AO3's own widget sends it,
 * so a name however it is typed is one request.
 */
export function suggestRequest(source: SuggestSource, matcher: Rule['matcher'], value: string): SuggestRequest | null {
  if (matcher !== 'exact' || source.kind !== 'ao3')
    return null
  const term = value.trim().replace(/\s+/g, ' ').toLowerCase()
  if ([...term].length < MIN_TERM)
    return null
  return { endpoint: source.endpoint, term, path: `${source.endpoint}?term=${encodeURIComponent(term)}` }
}

/** What the editor knows of AO3's suggestions since it opened. */
export interface SuggestState {
  /** AO3's names for each request answered, by its path. */
  answers: Readonly<Record<string, readonly string[]>>
  /** The request answered last, whose names stand in while the field's own are awaited. */
  latest: SuggestRequest | null
  /** The path of the request on its way, or null. */
  asking: string | null
  /** The path of the request last skipped for a breather, whose answer isn't coming. */
  skipped: string | null
  /** When the refusal being sat out ends, in epoch ms; 0 while there is none. */
  pausedUntil: number
  /** A request failed, so nothing more is asked until the editor opens again. */
  failed: boolean
}

/** The editor just opened: nothing asked, nothing known. */
export const NO_ANSWERS: SuggestState = { answers: {}, latest: null, asking: null, skipped: null, pausedUntil: 0, failed: false }

/**
 * A request is due (the pause in typing has run out, or the canonical-tag
 * preview is asking): whether to send it, given the archive's pause, if any.
 * Nothing is sent for an answer
 * already had or on its way, or after a failure. Under a refusal nothing is
 * sent, and suggestions pause until it ends; a breather skips the request. The
 * archive's word decides, so a pause it no longer holds is over.
 */
export function whenDue(state: SuggestState, request: SuggestRequest | null, pause: ArchivePause | null): { state: SuggestState, send: boolean } {
  if (!request || state.failed || Object.hasOwn(state.answers, request.path) || state.asking === request.path)
    return { state, send: false }
  if (pause?.reason === 'refused')
    return { state: { ...state, pausedUntil: pause.until }, send: false }
  if (pause)
    return { state: { ...state, skipped: request.path }, send: false }
  return { state: { ...state, asking: request.path, skipped: null, pausedUntil: 0 }, send: true }
}

/** AO3 answered: its names are kept until the editor closes, and stand in until the next answer. */
export function withAnswer(state: SuggestState, request: SuggestRequest, names: readonly string[]): SuggestState {
  return {
    ...state,
    answers: { ...state.answers, [request.path]: names },
    latest: request,
    asking: state.asking === request.path ? null : state.asking,
  }
}

/**
 * AO3 refused the request on its way, and `pause` is the archive's pause since:
 * suggestions pause until its refusal ends. A refusal that left none to sit out
 * (a `Retry-After` already past) is a failure, breather or not, since asking
 * again the moment it allows would be the retry loop a refusal forbids.
 */
export function withRefusal(state: SuggestState, pause: ArchivePause | null): SuggestState {
  return pause?.reason === 'refused' ? { ...state, asking: null, pausedUntil: pause.until } : withFailure(state)
}

/** The refusal is over. */
export function withResume(state: SuggestState): SuggestState {
  return { ...state, pausedUntil: 0 }
}

/** The request on its way failed: offline, or an answer that wasn't one. */
export function withFailure(state: SuggestState): SuggestState {
  return { ...state, asking: null, failed: true }
}

/** What the box says instead of names. */
export const SUGGEST_NOTES = {
  paused: 'AO3 asked us to slow down — suggestions are paused',
  unavailable: 'Suggestions unavailable',
} as const

/** A suggestion: the name a pick writes, and as HTML with the words typed marked. */
export interface Suggestion {
  name: string
  /** Escaped, and its only tags are the `<mark>`s. */
  html: string
}

/** What the box under the value field shows: names to pick from, a note, or nothing. */
export type SuggestBox
  = | { kind: 'none' }
    | { kind: 'names', options: readonly Suggestion[] }
    | { kind: keyof typeof SUGGEST_NOTES, text: string }

const NOTHING: SuggestBox = { kind: 'none' }

function marked(names: readonly string[], value: string): SuggestBox {
  if (!names.length)
    return NOTHING
  const terms = searchTerms(value)
  return { kind: 'names', options: names.map(name => ({ name, html: highlight(name, terms) })) }
}

/**
 * The box under an Exact field holding `value`. A source of fixed names offers
 * those holding every word typed, from the first letter, and asks nothing.
 * AO3's offers its answer for the term in the field; while that is awaited,
 * the last answer from the same endpoint, but nothing for a term skipped for
 * a breather, since no answer to it is coming. A refusal or a failure is a
 * note in place of the names, wherever a request would be made.
 */
export function suggestBox(state: SuggestState, source: SuggestSource, matcher: Rule['matcher'], value: string): SuggestBox {
  if (matcher !== 'exact')
    return NOTHING
  if (source.kind === 'fixed') {
    const terms = searchTerms(value)
    return terms.length ? marked(source.names.filter(name => textMatches(name, terms)), value) : NOTHING
  }
  const request = suggestRequest(source, matcher, value)
  if (!request)
    return NOTHING
  if (state.failed)
    return { kind: 'unavailable', text: SUGGEST_NOTES.unavailable }
  if (state.pausedUntil)
    return { kind: 'paused', text: SUGGEST_NOTES.paused }
  const names = Object.hasOwn(state.answers, request.path)
    ? state.answers[request.path]
    : state.skipped !== request.path && state.latest?.endpoint === request.endpoint ? state.answers[state.latest.path] : undefined
  return names ? marked(names, value) : NOTHING
}

/** Where the reader is in the names: whether the list is shown, and the one the arrows are on (-1 for none). */
export interface SuggestCursor {
  shown: boolean
  active: number
}

/** Typing shows the list, with no name chosen. */
export const CURSOR_START: SuggestCursor = { shown: true, active: -1 }

/** A pick, or Escape, closes the list. */
export const CURSOR_CLOSED: SuggestCursor = { shown: false, active: -1 }

/**
 * A key pressed in the value field while it has `count` names to offer: the
 * cursor it leaves and the name it picks, or null when the key isn't the
 * list's, for the field or the dialog to have. The arrows walk the names,
 * round from either end, and open a closed list; Enter picks the name the
 * arrows are on, and Escape closes the list.
 */
export function suggestKey(cursor: SuggestCursor, key: string, count: number): { cursor: SuggestCursor, pick: number | null } | null {
  if (count === 0)
    return null
  switch (key) {
    case 'ArrowDown':
      return { cursor: { shown: true, active: cursor.shown ? (cursor.active + 1) % count : 0 }, pick: null }
    case 'ArrowUp':
      return { cursor: { shown: true, active: cursor.shown && cursor.active > 0 ? cursor.active - 1 : count - 1 }, pick: null }
    case 'Enter':
      return cursor.shown && cursor.active >= 0 && cursor.active < count ? { cursor: CURSOR_CLOSED, pick: cursor.active } : null
    case 'Escape':
      return cursor.shown ? { cursor: CURSOR_CLOSED, pick: null } : null
    default:
      return null
  }
}
