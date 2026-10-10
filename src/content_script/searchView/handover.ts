/**
 * What a global re-run took off the page of a search view, for the re-run's own
 * unit to put back — and what becomes of it when no unit does.
 *
 * Every options change re-runs the page, from whichever tab made it, and a
 * re-run first takes down everything the extension drew: each unit's static
 * `clean()`, then every element it marked. A search view is up for far longer
 * than a re-run takes, so the host hands over what it had instead of losing it:
 *
 * - **A view on screen** is closed, and put back from memory, where the reader
 *   left it, by the unit that opens it again.
 * - **A view still opening** — reading its stored copy, or walking its listing
 *   for the first time, which can take minutes — is not closed at all. Its walk
 *   carries on off the page, and the unit that opens it again takes it back:
 *   its progress returns to the page as it stood, and its view follows when the
 *   walk is done, drawn under the options the re-run brought. Nothing the walk
 *   has fetched is fetched again for it.
 *
 * A unit claims what is its own as it re-runs ({@link onClaim}) and opens it
 * after, sometimes only once it has read something of its own; a claim is an
 * open promised, and the open that arrives takes the opening back
 * ({@link onOpen}). An opening that no unit claimed by the end of the re-run
 * ({@link onRunEnd}), or whose every claim came to nothing ({@link onRelease}) —
 * its feature switched off by the very change that re-ran the page, say — is
 * stopped, and the page goes back to the listing the archive drew. A view no
 * unit claims stays as the re-run left it: closed, its state kept for whatever
 * opens it next.
 *
 * The host keeps the state and does what this decides. `V` and `O` are what it
 * keeps of a view and of an opening, which nothing here looks inside.
 */

/** A view a re-run closed, to be put back where the reader left it. */
export interface ViewHandover<V> {
  readonly kind: 'view'
  readonly cacheKey: string
  readonly view: V
}

/** A view still opening when a re-run took the page down, carrying on off it. */
export interface OpeningHandover<O> {
  readonly kind: 'opening'
  readonly cacheKey: string
  readonly opening: O
  /** Opens promised by the re-run's units and not yet arrived. */
  readonly claims: number
}

/** What a re-run took down, still waiting to be put back. */
export type Handover<V, O> = ViewHandover<V> | OpeningHandover<O>

/** What is on the page as a re-run takes it down: a view on screen, or one still opening, or neither. */
export interface OnPage<V, O> {
  view?: { readonly cacheKey: string, readonly view: V }
  opening?: { readonly cacheKey: string, readonly opening: O }
}

/** The handover left, and an opening it dropped, which the host must stop. */
export interface Stop<V, O> {
  handover: Handover<V, O> | null
  stopped: O | null
}

/** Anything a newer handover replaces: only an opening has a walk to stop. */
function dropped<O>(handover: Handover<unknown, O> | null): O | null {
  return handover?.kind === 'opening' ? handover.opening : null
}

/**
 * A re-run takes the page down. A view on screen, or one on its way there, is
 * handed over. With neither, what an earlier re-run handed over stays, for this
 * one's units to claim: two re-runs can overlap.
 */
export function onSuspend<V, O>(handover: Handover<V, O> | null, page: OnPage<V, O>): Stop<V, O> {
  if (page.view)
    return { handover: { kind: 'view', ...page.view }, stopped: dropped(handover) }
  if (page.opening)
    return { handover: { kind: 'opening', ...page.opening, claims: 0 }, stopped: dropped(handover) }
  return { handover, stopped: null }
}

/**
 * A unit re-running claims what was handed over of its list. A view is taken
 * there and then. An opening stays handed over, one more open promised, until
 * that open arrives.
 */
export function onClaim<V, O>(
  handover: Handover<V, O> | null,
  cacheKey: string,
): { handover: Handover<V, O> | null, claimed: Handover<V, O> | null } {
  if (handover?.cacheKey !== cacheKey)
    return { handover, claimed: null }
  if (handover.kind === 'view')
    return { handover: null, claimed: handover }
  const claimed = { ...handover, claims: handover.claims + 1 }
  return { handover: claimed, claimed }
}

/**
 * What an open of `cacheKey` makes of the handover, `onScreen` being whether a
 * view of that list is already up or on its way. Its own list's opening it
 * takes back (`adopt`); a view already coming has nothing to gain from it
 * (`stay`); anything else starts its own (`start`), and stops another list's
 * opening, since only one view is ever open.
 */
export function onOpen<V, O>(
  handover: Handover<V, O> | null,
  cacheKey: string,
  onScreen: boolean,
): Stop<V, O> & { plan: 'adopt' | 'stay' | 'start', adopted: O | null } {
  if (handover?.kind === 'opening' && handover.cacheKey === cacheKey)
    return { handover: null, plan: 'adopt', adopted: handover.opening, stopped: null }
  if (onScreen)
    return { handover, plan: 'stay', adopted: null, stopped: null }
  const stopped = dropped(handover)
  return { handover: stopped ? null : handover, plan: 'start', adopted: null, stopped }
}

/**
 * An open that claimed `cacheKey`'s opening has settled. Having taken it back,
 * it leaves nothing behind. Having given up on the way, its claim lapses, and
 * with the last claim gone so does the opening.
 */
export function onRelease<V, O>(handover: Handover<V, O> | null, cacheKey: string): Stop<V, O> {
  if (handover?.kind !== 'opening' || handover.cacheKey !== cacheKey)
    return { handover, stopped: null }
  if (handover.claims > 1)
    return { handover: { ...handover, claims: handover.claims - 1 }, stopped: null }
  return { handover: null, stopped: handover.opening }
}

/** The re-run is over, every unit's claim made: an opening none of them claimed is stopped. */
export function onRunEnd<V, O>(handover: Handover<V, O> | null): Stop<V, O> {
  if (handover?.kind === 'opening' && handover.claims === 0)
    return { handover: null, stopped: handover.opening }
  return { handover, stopped: null }
}

/** The view is closed: nothing handed over comes back after that. */
export function onClose<V, O>(handover: Handover<V, O> | null): Stop<V, O> {
  return { handover: null, stopped: dropped(handover) }
}
