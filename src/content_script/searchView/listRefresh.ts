import type { WaitReason } from '../archiveFetch.ts'

import { claimLive } from '../../common/claim.ts'
import { waitLine } from '../archiveFetch.ts'

/**
 * One refresh of a stored list at a time, whichever page runs it.
 *
 * A stored list can be refreshed from the page it is the view of, behind the
 * view, and from the options page, as a step of an offline-copy job. Left to
 * themselves, two pages would read the same listing against a rate limit they
 * share, and neither could say what the other was doing. So the page that
 * refreshes says so in a {@link ListRefresh} claim, and keeps its progress there;
 * any other page that would refresh the list follows that claim instead
 * ({@link followState}), shows how far it has got, and may ask for it to be
 * cancelled ({@link RefreshCancel}). The claim is renewed while the refresh runs;
 * one left unrenewed for {@link REFRESH_CLAIM_TTL_MS} is a page that went away
 * mid-refresh, and holds nobody.
 *
 * Only the lists {@link sharesRefresh} names take part; every other refresh runs
 * on its own.
 *
 * This is the decidable half, pure, so it loads under a plain `node --test`; the
 * storage half is {@link file://./refreshClaim.ts}.
 */

/** Who holds a refresh: an AO3 page, behind its search view, or the options page's job. */
export type RefreshHolder = 'page' | 'options'

/**
 * How a refresh ended:
 *
 * - `written` — the list was read and stored;
 * - `blocked` — AO3 kept refusing, and nothing was stored;
 * - `refused` — what came back was not the list (signed out, or empty over a
 *   list that has works), so nothing was stored;
 * - `failed` — it threw;
 * - `cancelled` — the reader stopped it, from whichever page;
 * - `dropped` — the page running it moved on (closed, navigated, re-ran) without
 *   the reader asking. Nobody decided against the refresh, so a page that was
 *   following it takes it over.
 */
export type RefreshOutcome = 'written' | 'blocked' | 'refused' | 'failed' | 'cancelled' | 'dropped'

/** A refresh of one stored list, as its holder last wrote it. Written only by the holder. */
export interface ListRefresh {
  /** This claim: its page run and when it began. A {@link RefreshCancel} names it. */
  id: string
  /** The page run holding it: a token of its own, made when it loaded. */
  by: string
  holder: RefreshHolder
  startedAt: number
  /** Epoch ms the claim was made or last written; 0 once it is released. */
  at: number
  /** Listing pages loaded, and to load: 0 until the count is known. */
  done: number
  total: number
  /** The pause in requests being sat out: the epoch ms it runs to, or 0 for none. */
  waitUntil: number
  waitReason: WaitReason | null
  outcome: RefreshOutcome | null
  /** Epoch ms it was released; 0 while it runs. */
  endedAt: number
}

/** Another page asking the holder of claim {@link ListRefresh.id} to stop. */
export interface RefreshCancel {
  id: string
  at: number
}

/**
 * How long a claim holds without being renewed.
 *
 * Longer than a page's timers can be held back: a browser runs a page's timers
 * at most once a minute once the page has been hidden a while, and a tab left
 * refreshing in the background is the case this exists for. A page that closes
 * releases its claim as it goes, so this only bounds the case where it can't.
 */
export const REFRESH_CLAIM_TTL_MS = 150_000

/** How often a holder renews its claim when nothing else has written it: well inside {@link REFRESH_CLAIM_TTL_MS}. */
export const REFRESH_CLAIM_RENEW_MS = 30_000

/** The sources whose stored list shares its refresh between pages. */
const SHARED_SOURCES: ReadonlySet<string> = new Set(['marked-for-later'])

/** Whether a stored list of source `sourceId` shares its refresh between pages. */
export function sharesRefresh(sourceId: string): boolean {
  return SHARED_SOURCES.has(sourceId)
}

/** A new claim, by page run `by`, at `now`. */
export function claimRefresh(by: string, holder: RefreshHolder, now: number): ListRefresh {
  return { id: `${by}:${now}`, by, holder, startedAt: now, at: now, done: 0, total: 0, waitUntil: 0, waitReason: null, outcome: null, endedAt: 0 }
}

/** Whether `stored` is a refresh still under way. */
function running(stored: ListRefresh | null, now: number): stored is ListRefresh {
  return !!stored && stored.outcome === null && claimLive(stored.at, now, REFRESH_CLAIM_TTL_MS)
}

/**
 * What page run `self` should do about refreshing a list whose stored claim is
 * `stored`: `follow` another page run's refresh under way, else `hold` — claim
 * it and refresh.
 */
export function refreshStep(stored: ListRefresh | null, self: string, now: number): 'hold' | 'follow' {
  return running(stored, now) && stored.by !== self ? 'follow' : 'hold'
}

/**
 * Whether `claim`, just written, is the claim the store holds. Two pages that
 * claim at once both read back the last write, so exactly one of them holds it
 * and the other follows.
 */
export function holds(stored: ListRefresh | null, claim: ListRefresh): boolean {
  return stored?.id === claim.id
}

/**
 * Whether `other`, just written, takes the refresh over from `claim`, which
 * this page holds: it is another claim still running, made later. Two pages
 * that claimed at once and each read back its own both hold; ranking by when
 * they began, and by id between two of the same millisecond, has the same one
 * give way whichever hears the other first.
 */
export function outranks(other: ListRefresh, claim: ListRefresh): boolean {
  if (other.id === claim.id || other.outcome !== null)
    return false
  return other.startedAt !== claim.startedAt ? other.startedAt > claim.startedAt : other.id > claim.id
}

/** `claim`, having loaded `done` of `total` listing pages. */
export function withProgress(claim: ListRefresh, done: number, total: number, now: number): ListRefresh {
  return { ...claim, done, total, at: now }
}

/** `claim`, sitting out a pause in requests until `until` (0: the pause is over). */
export function withPause(claim: ListRefresh, until: number, reason: WaitReason, now: number): ListRefresh {
  return { ...claim, waitUntil: until, waitReason: until ? reason : null, at: now }
}

/** `claim`, renewed. */
export function renewed(claim: ListRefresh, now: number): ListRefresh {
  return { ...claim, at: now }
}

/** `claim`, over. */
export function released(claim: ListRefresh, outcome: RefreshOutcome, now: number): ListRefresh {
  return { ...claim, at: 0, waitUntil: 0, waitReason: null, outcome, endedAt: now }
}

/** Whether `cancel` asks for `claim` to stop, rather than for an earlier claim. */
export function cancels(cancel: RefreshCancel | null, claim: ListRefresh): boolean {
  return !!cancel && cancel.id === claim.id
}

/**
 * Where a refresh another page is running stands, for a page run that began
 * waiting on it at `since`:
 *
 * - `following` — still under way;
 * - `landed` — stored since `since`, so the list is in the store to be read;
 * - `ended` — stopped since `since` without storing it, and how;
 * - `free` — nobody else is refreshing it: there is no claim, it lapsed, its page
 *   dropped it, or it ended before this page run began waiting, and so says
 *   nothing this page run doesn't already know.
 */
export type FollowState
  = | { kind: 'following', claim: ListRefresh }
    | { kind: 'landed', endedAt: number }
    | { kind: 'ended', outcome: RefreshOutcome }
    | { kind: 'free' }

export function followState(stored: ListRefresh | null, self: string, since: number, now: number): FollowState {
  if (!stored || stored.by === self)
    return { kind: 'free' }
  if (stored.outcome === null)
    return running(stored, now) ? { kind: 'following', claim: stored } : { kind: 'free' }
  if (stored.endedAt < since || stored.outcome === 'dropped')
    return { kind: 'free' }
  return stored.outcome === 'written' ? { kind: 'landed', endedAt: stored.endedAt } : { kind: 'ended', outcome: stored.outcome }
}

/** How long until `stored`, unrenewed, lapses: 0 for one already lapsed or released. */
export function lapseIn(stored: ListRefresh, now: number): number {
  return running(stored, now) ? Math.max(0, stored.at + REFRESH_CLAIM_TTL_MS - now) : 0
}

/**
 * What a search view's *Updating…* note says of `claim`, to page run `self`:
 * where the refresh runs, then the pause it is sitting out, counting down, or
 * else the pages it has loaded.
 */
export function updatingNote(claim: ListRefresh, self: string, now: number): string {
  const head = claim.by === self
    ? 'Updating…'
    : claim.holder === 'options' ? 'Updating from the options page…' : 'Updating in another tab…'
  const detail = (claim.waitReason && waitLine(claim.waitUntil, claim.waitReason, now))
    ?? (claim.total ? `Loaded ${claim.done} of ${claim.total} ${claim.total === 1 ? 'page' : 'pages'}` : null)
  return detail ? `${head} ${detail}` : head
}
