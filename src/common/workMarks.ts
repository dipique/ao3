/**
 * Per-work marks — a purely local record of what you've done with a work (read
 * it, loved it, bounced off it), independent of anything AO3 stores.
 *
 * The point of `read` is to break the marked-for-later loop: once a work is
 * marked read it can be collapsed out of every listing, so you stop re-adding a
 * work you already finished but don't remember. The finer dispositions
 * (`favorite`, `good`, `boring`, `bad`, `gross`) are the same decision said more
 * precisely — they declare themselves read via {@link MarkConfig.triggerAlias},
 * which is what makes them hide, unsave, and appear in menus exactly as `read`
 * does without any of that being written per-mark. A work can carry several of
 * them at once, because they aren't competing answers to one question: a work
 * can be hot *and* feelsy *and* a favourite. What it can't carry alongside them
 * is a mark that stands alone in the group — see {@link markIsExclusive}.
 *
 * ## Why the ids are packed
 *
 * These live in {@link Options} (so they ride along with backups/restore and the
 * sync engine) — but `storage.sync` has a hard 100 KB quota for *all* settings
 * combined, and a read list only ever grows. A naive `string[]` of eight-digit
 * ids costs ~11 bytes each before compression; delta-encoding the sorted ids in
 * base 36 costs ~4, because consecutive ids in a sorted list differ by far less
 * than their absolute value. On a 5 000-work list that's ~55 KB → ~20 KB before
 * the sync codec's own deflate pass ({@link file://./syncCodec.ts}) runs on top.
 *
 * The format is a comma-separated list of base-36 deltas against the previous
 * id, starting from 0 — so `"1a,2,5"` is 46, 48, 53. Ids are stored sorted and
 * de-duplicated, which also makes the packed string canonical: the same set
 * always produces the same string, so the sync engine's hash-based change
 * detection doesn't see a write that changed nothing.
 *
 * Everything here is pure (no browser APIs, no imports) so it can be unit-tested
 * headlessly with `node --test`.
 */

/** A mark's id — the key it lives under in {@link WorkMarks.marks}. */
export type MarkId = string

/**
 * One mark: what it looks like, how it behaves, and (for the marks that hold
 * their own ids) which works carry it.
 */
export interface MarkConfig {
  /**
   * Icon key. Resolved against a static registry per context — see
   * `content_script/markIcons.tsx` and the options UI's `MARK_ICON_CLASSES` —
   * because both ends need the icon to exist at build time.
   */
  icon: string
  /** Display noun, e.g. "Read", "Favorite". Menus read "Mark as <label>". */
  label: string
  /** Indicator colour (any CSS colour). Falls back to the muted default in CSS. */
  color?: string
  /**
   * Where this mark sits in menus, indicators and the options list — lowest
   * first. A mark without one falls back to its position in the table, so a
   * table written before the order was editable still reads in the order it was
   * stored, and a mark synced in from a newer build lands where it was put.
   *
   * Stored rather than implied by key order because key order doesn't survive
   * the round trip: the sync codec canonicalizes options key-sorted before
   * hashing them ({@link file://./syncCodec.ts}), so a change that only moved
   * keys around would hash identically to the old table and never sync.
   */
  order?: number
  /**
   * Treat this mark as `triggerAlias` for UI and trigger purposes: it shows up
   * wherever that mark's action does, inherits its {@link hideSearchResult}, and
   * setting it takes the work off Marked for Later exactly as that mark would.
   * Marks aliasing the same root stack: a work can carry any number of them at
   * once. What it can't do is carry one alongside a mark that stands alone in
   * the group — the root itself, or a {@link tracksProgress} mark. See
   * {@link markIsExclusive} for why, and {@link markClears} for the rule.
   *
   * A {@link tracksProgress} mark is the one exception to the unsaving half: an
   * ongoing work is the disposition that *isn't* "done with it", so it stays on
   * (and is added to) Marked for Later. It still takes its place in the group,
   * so choosing `read` clears it and vice versa.
   */
  triggerAlias?: MarkId
  /**
   * Collapse works carrying this mark out of listings (the normal hide/reason
   * UI). When unset, the trigger-alias root's value applies — read it through
   * {@link markHidesResults} rather than directly.
   */
  hideSearchResult?: boolean
  /**
   * Packed set of work ids carrying this mark (see {@link packIds}). Absent
   * means the mark holds no ids of its own — `saved` is only here to configure
   * how Marked for Later is drawn, since that list lives on AO3, not with us.
   */
  items?: string
  /**
   * This mark carries per-work progress in {@link MarkConfig.progress}, which
   * changes what it means: the work isn't finished, it's *paused*, so whether it
   * hides is decided per work from the blurb's chapter count rather than by
   * carrying the mark at all (see {@link file://./workProgress.ts}).
   */
  tracksProgress?: boolean
  /**
   * Packed per-work progress, parallel to {@link items}. See {@link packProgress}.
   * An entry whose work isn't in `items` is ignored on read and dropped on write.
   */
  progress?: string
}

/** The `workMarks` option: the feature switch plus the mark table. */
export interface WorkMarks {
  /** Track marks and offer them in the work context menu. */
  enabled: boolean
  /** Every mark, keyed by id. {@link MarkConfig.order} is menu/indicator order. */
  marks: Record<MarkId, MarkConfig>
}

/**
 * The mark whose group means "done with this work". The one piece of behaviour
 * that isn't data: setting any mark in this group also takes the work off your
 * AO3 Marked for Later list, because that pairing is AO3's, not ours.
 */
export const READ_MARK: MarkId = 'read'

/** The mark that mirrors AO3's own Marked for Later state (no ids of its own). */
export const SAVED_MARK: MarkId = 'saved'

/**
 * The marks a fresh install gets. `read` is the root disposition; the nine below
 * it are the same disposition said more precisely, so they alias it. `continue`
 * aliases it too, but inverts it — the work isn't done, it's waiting — and so
 * carries progress. `saved` carries no ids: it only says how the Marked for
 * Later state is drawn.
 *
 * **This list's order is menu and indicator order** — each mark is stamped with
 * its position here as {@link MarkConfig.order}, so this is a presentation
 * decision as much as a data one: `read` first, then its finer readings running
 * worst to best, then `continue`, which is the one that isn't a verdict at all.
 * `saved` is drawn from AO3's own list rather than ours, and the menu gives it
 * its own section regardless.
 *
 * `feelsy` and `fluff` sit near the top of that run because they're the two that
 * say what a work *was* rather than how good it was — the ones you reach for
 * when picking something to read by mood.
 *
 * Only the starting order, though: the reader can rearrange the verdicts from
 * the options page (see {@link moveMark}), and everything that draws them reads
 * the stored order rather than this one.
 */
export function createDefaultMarks(): Record<MarkId, MarkConfig> {
  return numbered({
    read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: false, items: '' },
    no: { icon: 'no', label: 'No', color: '#991b1b', triggerAlias: READ_MARK, items: '' },
    bad: { icon: 'bad', label: 'Bad', color: '#b45309', triggerAlias: READ_MARK, items: '' },
    boring: { icon: 'boring', label: 'Boring', color: '#8a8a8a', triggerAlias: READ_MARK, items: '' },
    gross: { icon: 'gross', label: 'Gross', color: '#4d7c0f', triggerAlias: READ_MARK, items: '' },
    good: { icon: 'good', label: 'Good', color: '#2f8f4e', triggerAlias: READ_MARK, items: '' },
    hot: { icon: 'hot', label: 'Hot', color: '#d0342c', triggerAlias: READ_MARK, items: '' },
    feelsy: { icon: 'feelsy', label: 'Feelsy', color: '#0891b2', triggerAlias: READ_MARK, items: '' },
    fluff: { icon: 'fluff', label: 'Fluff', color: '#a78bfa', triggerAlias: READ_MARK, items: '' },
    favorite: { icon: 'favorite', label: 'Favorite', color: '#c2185b', triggerAlias: READ_MARK, items: '' },
    continue: {
      icon: 'continue',
      label: 'Ongoing',
      color: '#0369a1',
      triggerAlias: READ_MARK,
      tracksProgress: true,
      hideSearchResult: true,
      items: '',
      progress: '',
    },
    saved: { icon: 'saved', label: 'Marked for later', color: '#2f8f4e' },
  })
}

/**
 * Stamp each mark's {@link MarkConfig.order} from its position, so the table we
 * ship is already canonical — nothing has to fall back on key order to read it,
 * and a reorder is a change to the same field rather than to the table's shape.
 */
function numbered(marks: Record<MarkId, MarkConfig>): Record<MarkId, MarkConfig> {
  for (const [index, id] of Object.keys(marks).entries())
    marks[id]!.order = index
  return marks
}

// ---------------------------------------------------------------------------
// Reading the mark table. All pure lookups over the stored map, so the content
// script can call them per blurb without touching storage.
// ---------------------------------------------------------------------------

/**
 * Every mark id, in the order they're shown — {@link MarkConfig.order} lowest
 * first, ties (and marks without one) settled by where they sit in the table.
 *
 * Everything else here derives its order from this one function, so a table
 * that predates the field, or one hand-edited into a state where two marks
 * claim the same slot, still reads in a stable, sensible order rather than
 * shuffling between renders.
 */
export function markIds(marks: Record<MarkId, MarkConfig>): MarkId[] {
  return Object.keys(marks)
    .map((id, index) => ({ id, index, at: orderOf(marks[id], index) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(entry => entry.id)
}

/** One mark's sort position: its stored order, or its place in the table. */
function orderOf(config: MarkConfig | undefined, index: number): number {
  const order = config?.order
  return typeof order === 'number' && Number.isFinite(order) ? order : index
}

/** Whether a mark holds its own set of work ids (as opposed to `saved`, which doesn't). */
export function markIsLocal(marks: Record<MarkId, MarkConfig>, id: MarkId): boolean {
  return typeof marks[id]?.items === 'string'
}

/** The ids of every mark that holds its own work-id set, in table order. */
export function localMarkIds(marks: Record<MarkId, MarkConfig>): MarkId[] {
  return markIds(marks).filter(id => markIsLocal(marks, id))
}

/**
 * The mark a mark behaves as: its {@link MarkConfig.triggerAlias}, or itself.
 * One level only — an alias pointing at another alias resolves to the alias it
 * names, not further, so a malformed table can't loop.
 */
export function markRoot(marks: Record<MarkId, MarkConfig>, id: MarkId): MarkId {
  const alias = marks[id]?.triggerAlias
  return alias && alias !== id && marks[alias] ? alias : id
}

/**
 * Every mark that behaves as `id` does — the group's root plus each mark
 * aliasing it, in table order. Which of them can sit on one work together is
 * {@link markClears}.
 */
export function markGroup(marks: Record<MarkId, MarkConfig>, id: MarkId): MarkId[] {
  const root = markRoot(marks, id)
  return markIds(marks).filter(other => markRoot(marks, other) === root)
}

/**
 * Whether this mark stands alone in its trigger group: setting it clears every
 * other member, and setting any other member clears it.
 *
 * Two marks are that way, and for the same reason — each is a statement the
 * finer readings contradict rather than refine:
 *
 * - the group's **root**. Plain `read` is what you mark a work you have no
 *   finer opinion about, so it says nothing that "hot" doesn't already say
 *   better, and a work listed as both is carrying a verdict and its own absence.
 * - a {@link MarkConfig.tracksProgress} mark. `continue` is the one member that
 *   says you're *not* done, which no verdict can be true alongside.
 *
 * Everything between them stacks freely: those are things a work *was*, and a
 * work can be several of them at once.
 */
export function markIsExclusive(marks: Record<MarkId, MarkConfig>, id: MarkId): boolean {
  return markRoot(marks, id) === id || markTracksProgress(marks, id)
}

/**
 * Whether setting `id` on a work takes `other` off it — same group, not the same
 * mark, and at least one of the two {@link markIsExclusive}.
 *
 * The single place that rule is written. Marks are set both in the stored table
 * ({@link setMark}) and in the content script's in-memory mirror of it, which
 * updates indicators without waiting for the storage round-trip; the two reading
 * one predicate is what keeps them from drifting into disagreeing about what a
 * click just did.
 */
export function markClears(marks: Record<MarkId, MarkConfig>, id: MarkId, other: MarkId): boolean {
  if (other === id || markRoot(marks, other) !== markRoot(marks, id))
    return false
  return markIsExclusive(marks, id) || markIsExclusive(marks, other)
}

/** Whether works carrying this mark are collapsed out of listings (inherited from the group root). */
export function markHidesResults(marks: Record<MarkId, MarkConfig>, id: MarkId): boolean {
  const own = marks[id]?.hideSearchResult
  if (own !== undefined)
    return own
  const root = markRoot(marks, id)
  return root === id ? false : !!marks[root]?.hideSearchResult
}

/** Whether this mark carries per-work progress (see {@link MarkConfig.tracksProgress}). */
export function markTracksProgress(marks: Record<MarkId, MarkConfig>, id: MarkId): boolean {
  return !!marks[id]?.tracksProgress
}

/**
 * Whether this mark's place in the order is the reader's to choose. A mark that
 * tracks progress is not: "ongoing" isn't a verdict on a work the way the rest
 * of the group is — it's the one that says you're *not* done — so it stays at
 * the end of the run rather than being shuffled in among the readings, both in
 * the options list and in the menu it builds.
 *
 * A mark holding no ids of its own (`saved`) isn't in the run at all; its menu
 * row is drawn from AO3's list, in its own section.
 */
export function markIsReorderable(marks: Record<MarkId, MarkConfig>, id: MarkId): boolean {
  return markIsLocal(marks, id) && !markTracksProgress(marks, id)
}

/** The marks the reader can rearrange, in table order. */
export function reorderableMarkIds(marks: Record<MarkId, MarkConfig>): MarkId[] {
  return markIds(marks).filter(id => markIsReorderable(marks, id))
}

/**
 * Move one mark `delta` places through the reorderable run, returning a new
 * table — or the original (identity-equal) when the move would leave the run,
 * so a redundant `options.set` can be skipped.
 *
 * The whole table is renumbered from the result, pinned marks last, which is
 * what keeps {@link markIsReorderable} an invariant rather than a suggestion:
 * however far a verdict is pushed down, it can't cross the ongoing mark,
 * because the ongoing mark is always given a slot after every verdict.
 */
export function moveMark(
  marks: Record<MarkId, MarkConfig>,
  id: MarkId,
  delta: number,
): Record<MarkId, MarkConfig> {
  const movable = reorderableMarkIds(marks)
  const from = movable.indexOf(id)
  const to = from + delta
  if (from === -1 || to < 0 || to >= movable.length)
    return marks

  movable.splice(from, 1)
  movable.splice(to, 0, id)
  return renumbered(marks, movable)
}

/**
 * Renumber a table into canonical form: the order it already reads as, but with
 * every mark holding an explicit slot, no two marks claiming the same one, and
 * the pinned marks after the verdicts. Returns the original (identity-equal)
 * when it already is — which a table straight from {@link createDefaultMarks}
 * always is.
 *
 * Used where a table arrives from somewhere that didn't have to keep it tidy:
 * the migration that tops an existing install's marks up with newly shipped
 * ones, which merges two orderings and can leave a slot claimed twice.
 */
export function normalizeMarkOrder(marks: Record<MarkId, MarkConfig>): Record<MarkId, MarkConfig> {
  return renumbered(marks, reorderableMarkIds(marks))
}

/**
 * Rewrite the table with the reorderable marks in the order given and the
 * pinned ones (the progress mark, then `saved`) after them, keeping their own
 * relative order. Keys are rebuilt in the new order as well as stamped with it:
 * the field is what's read, but a device on a build that predates it falls back
 * to key order, and this way it agrees.
 */
function renumbered(
  marks: Record<MarkId, MarkConfig>,
  movable: MarkId[],
): Record<MarkId, MarkConfig> {
  const sequence = [...movable, ...markIds(marks).filter(id => !markIsReorderable(marks, id))]
  if (sequence.every((id, index) => marks[id]?.order === index))
    return marks

  const next: Record<MarkId, MarkConfig> = {}
  for (const [index, id] of sequence.entries())
    next[id] = { ...marks[id]!, order: index }
  return next
}

/**
 * The ids of every mark carrying per-work progress, in table order. Everything
 * that acts on progress derives its mark from here rather than naming one —
 * a table synced from a device predating the mark simply won't have one, and
 * every path must degrade to "the feature is off" rather than break.
 */
export function progressMarkIds(marks: Record<MarkId, MarkConfig>): MarkId[] {
  return localMarkIds(marks).filter(id => markTracksProgress(marks, id))
}

/** The work ids carrying one mark. Empty for a mark that holds no ids. */
export function markItems(marks: Record<MarkId, MarkConfig>, id: MarkId): Set<string> {
  return unpackIds(marks[id]?.items ?? '')
}

/**
 * One mark's per-work progress, keyed by work id. Entries whose work doesn't
 * carry the mark are dropped: `items` is the authority on membership, so an
 * orphaned payload (a table hand-edited, or half-written by an older version)
 * is data nothing vouches for.
 */
export function markProgress(marks: Record<MarkId, MarkConfig>, id: MarkId): Map<string, WorkProgress> {
  const entries = unpackProgress(marks[id]?.progress ?? '')
  if (entries.size === 0)
    return entries
  const items = markItems(marks, id)
  for (const workId of [...entries.keys()]) {
    if (!items.has(workId))
      entries.delete(workId)
  }
  return entries
}

/** One work's progress under one mark, or undefined when it doesn't carry it. */
export function progressFor(
  marks: Record<MarkId, MarkConfig>,
  id: MarkId,
  workId: string,
): WorkProgress | undefined {
  if (!workHasMark(marks, id, workId))
    return undefined
  return unpackProgress(marks[id]?.progress ?? '').get(workId)
}

/** Whether one work carries one mark. Prefer {@link markItems} when checking many. */
export function workHasMark(marks: Record<MarkId, MarkConfig>, id: MarkId, workId: string): boolean {
  return hasId(marks[id]?.items ?? '', workId)
}

/**
 * Every work id that some mark hides, mapped to the mark responsible — the
 * first one in table order, since a work can carry several hiding marks at once
 * and the reason line has room for one. Unpacks each hiding mark once, so
 * HideWorks can test a whole listing against one map.
 */
export function hiddenByMarks(marks: Record<MarkId, MarkConfig>): Map<string, MarkId> {
  const out = new Map<string, MarkId>()
  for (const id of localMarkIds(marks)) {
    // A progress mark hides per work, not outright: whether an ongoing work is
    // worth showing depends on the blurb's chapter count, which only the caller
    // holding the DOM can answer. Carrying the mark alone decides nothing.
    if (!markHidesResults(marks, id) || markTracksProgress(marks, id))
      continue
    for (const workId of markItems(marks, id)) {
      if (!out.has(workId))
        out.set(workId, id)
    }
  }
  return out
}

/**
 * Whether *anything* about the marks can collapse a work — the gate every unit
 * that hides must test, rather than `hiddenByMarks(...).size > 0`, which now
 * deliberately excludes progress marks. Without this a reader whose only hiding
 * mark is the ongoing one gets the unit filtered out before it ever runs.
 */
export function marksHideAnything(marks: Record<MarkId, MarkConfig>): boolean {
  if (hiddenByMarks(marks).size > 0)
    return true
  return progressMarkIds(marks).some(
    id => markHidesResults(marks, id) && countIds(marks[id]?.progress ?? '') > 0,
  )
}

// ---------------------------------------------------------------------------
// Writing. Every helper here returns a *new* mark table (or the original,
// unchanged, when nothing moved) so callers can skip a redundant `options.set` —
// every option write wakes the sync engine and the daily-backup check.
// ---------------------------------------------------------------------------

/** Replace one mark's packed id set, leaving the rest of the table alone. */
function withItems(marks: Record<MarkId, MarkConfig>, id: MarkId, items: string): Record<MarkId, MarkConfig> {
  return { ...marks, [id]: { ...marks[id]!, items } }
}

/** Replace one mark's packed progress, leaving the rest of the table alone. */
function withProgressString(marks: Record<MarkId, MarkConfig>, id: MarkId, progress: string): Record<MarkId, MarkConfig> {
  return { ...marks, [id]: { ...marks[id]!, progress } }
}

/**
 * Take one work's progress payload out of a mark. Called wherever the work
 * leaves the mark's id set — both places {@link setMark} clears an id — because
 * a payload that outlives its membership is an entry nothing ever reaches again
 * but that still costs sync quota forever.
 *
 * A no-op (identity-equal) for a mark that holds no progress at all, which is
 * every mark but the ongoing one.
 */
function dropProgress(marks: Record<MarkId, MarkConfig>, id: MarkId, workId: string): Record<MarkId, MarkConfig> {
  const packed = marks[id]?.progress
  if (typeof packed !== 'string')
    return marks
  const next = withProgress(packed, workId, null)
  return next === packed ? marks : withProgressString(marks, id, next)
}

/**
 * Set or clear one mark on one work. Setting a mark clears the marks in its
 * trigger group that can't stand beside it ({@link markClears}) — so marking a
 * work `favorite` takes it out of plain `read` and out of `continue`, but leaves
 * `hot` exactly where it is.
 *
 * Returns the original table (identity-equal) when nothing changed.
 */
export function setMark(
  marks: Record<MarkId, MarkConfig>,
  workId: string,
  id: MarkId,
  on: boolean,
): Record<MarkId, MarkConfig> {
  if (!markIsLocal(marks, id))
    return marks

  let next = marks
  const items = withId(next[id]!.items!, workId, on)
  if (items !== next[id]!.items)
    next = withItems(next, id, items)
  if (!on)
    next = dropProgress(next, id, workId)

  if (on) {
    for (const other of markGroup(marks, id)) {
      if (!markIsLocal(next, other) || !markClears(marks, id, other))
        continue
      const cleared = withId(next[other]!.items!, workId, false)
      if (cleared !== next[other]!.items)
        next = withItems(next, other, cleared)
      next = dropProgress(next, other, workId)
    }
  }

  return next
}

/**
 * Record where a reader has got to in one work, under a mark that tracks
 * progress. Membership and payload move together — marking a work ongoing *is*
 * saying which chapter you stopped at, and splitting that into two writes would
 * leave a window where the table says one and not the other.
 *
 * Returns the original table (identity-equal) only when neither half moved. The
 * payload counts: editing just the chapter number on an already-marked work
 * leaves `items` untouched, and the content script's `commit()` short-circuits
 * on identity, so ignoring `progress` here would silently drop that write.
 */
export function setMarkProgress(
  marks: Record<MarkId, MarkConfig>,
  workId: string,
  id: MarkId,
  entry: WorkProgress,
): Record<MarkId, MarkConfig> {
  if (!markIsLocal(marks, id) || !markTracksProgress(marks, id))
    return marks

  // Membership first: this also clears the rest of the trigger group (and their
  // progress), so the work can't be ongoing and read at once.
  let next = setMark(marks, workId, id, true)

  // Rebuild from the *pruned* map rather than patching the stored string, so an
  // orphaned entry is dropped by the next write rather than carried forever.
  const entries = markProgress(next, id)
  entries.set(workId, entry)
  const progress = packProgress(entries)
  if (progress !== (next[id]!.progress ?? ''))
    next = withProgressString(next, id, progress)

  return next
}

/**
 * Set or clear a work's disposition at the group level — what AO3's own "Mark as
 * Read" / "Mark for Later" buttons mean, as opposed to a specific choice from
 * our menu.
 *
 * Turning it *on* is a no-op when the work already carries any mark in the group:
 * pressing AO3's Mark as Read on a work you'd already called `gross` must not
 * quietly downgrade it to plain `read`. Turning it *off* clears the whole group,
 * since any of them meant "done with it".
 *
 * A {@link MarkConfig.tracksProgress} mark is exempt from both halves, because
 * it is the one member of the group that doesn't mean "done with it":
 *
 * - it doesn't *block* the promotion, so AO3's "Mark as Read" on an ongoing work
 *   does what it says and settles the work as read;
 * - it isn't *cleared* by turning the group off, because that's what AO3's own
 *   "Mark for Later" button means — back on the to-read pile — and an ongoing
 *   work already is one. Without this exemption, pressing that button would run
 *   through CaptureMarkButtons and erase the mark and its progress.
 */
export function setMarkGroup(
  marks: Record<MarkId, MarkConfig>,
  workId: string,
  id: MarkId,
  on: boolean,
): Record<MarkId, MarkConfig> {
  const group = markGroup(marks, id)
  const carried = group.filter(other => workHasMark(marks, other, workId))

  if (on) {
    const blocking = carried.filter(other => !markTracksProgress(marks, other))
    return blocking.length > 0 ? marks : setMark(marks, workId, markRoot(marks, id), true)
  }

  let next = marks
  for (const other of carried) {
    if (markTracksProgress(marks, other))
      continue
    next = setMark(next, workId, other, false)
  }
  return next
}

/** Which marks a work carries, in table order. */
export function marksForWork(marks: Record<MarkId, MarkConfig>, workId: string): MarkId[] {
  return localMarkIds(marks).filter(id => workHasMark(marks, id, workId))
}

// ---------------------------------------------------------------------------
// The packed id codec.
// ---------------------------------------------------------------------------

const SEPARATOR = ','
const RADIX = 36

/**
 * Pack work ids into the compact delta form. Input may be in any order and may
 * contain duplicates or junk; the result is sorted, de-duplicated, and canonical.
 * Non-numeric and negative values are dropped rather than throwing — a corrupt
 * entry should cost one id, not the whole list.
 */
export function packIds(ids: Iterable<string | number>): string {
  const seen = new Set<number>()
  for (const raw of ids) {
    // Digits-only, not `Number(raw)`: that coerces '', ' ' and null to 0, which
    // would silently invent a work id 0 out of an empty entry.
    const n = typeof raw === 'number' ? raw : (/^\d+$/.test(raw) ? Number(raw) : Number.NaN)
    if (Number.isSafeInteger(n) && n >= 0)
      seen.add(n)
  }
  if (seen.size === 0)
    return ''

  const sorted = [...seen].sort((a, b) => a - b)
  let prev = 0
  const parts = sorted.map((n) => {
    const delta = n - prev
    prev = n
    return delta.toString(RADIX)
  })
  return parts.join(SEPARATOR)
}

/**
 * Unpack a delta-encoded id string back into a set of id strings (matching the
 * string ids the rest of the extension parses out of `/works/:id` links).
 *
 * A malformed chunk stops the walk: every later id is relative to it, so
 * continuing would fabricate wrong ids. Returning the prefix we could read
 * degrades gracefully — some marks go missing, none are invented.
 */
export function unpackIds(packed: string): Set<string> {
  const out = new Set<string>()
  if (!packed)
    return out

  let prev = 0
  for (const part of packed.split(SEPARATOR)) {
    const delta = Number.parseInt(part, RADIX)
    if (!Number.isFinite(delta) || delta < 0)
      break
    prev += delta
    out.add(String(prev))
  }
  return out
}

/**
 * How many ids a packed string holds, without building the set. Cheap enough to
 * call from a render (the options page shows it as a count).
 */
export function countIds(packed: string): number {
  return packed ? packed.split(SEPARATOR).length : 0
}

/** Whether a packed set contains an id. Prefer {@link unpackIds} when checking many. */
export function hasId(packed: string, id: string): boolean {
  return unpackIds(packed).has(id)
}

/**
 * Add or remove one id, returning the new packed string. Returns the *original*
 * string (identity-equal) when nothing changed, so callers can skip a redundant
 * `options.set` — which matters here because every option write wakes the sync
 * engine and the daily-backup check.
 */
export function withId(packed: string, id: string, present: boolean): string {
  const ids = unpackIds(packed)
  if (ids.has(id) === present)
    return packed
  if (present)
    ids.add(id)
  else
    ids.delete(id)
  return packIds(ids)
}

// ---------------------------------------------------------------------------
// The packed progress codec. Same discipline as the id codec above — sorted,
// delta-encoded, canonical — because these ride in the same synced option, and
// a string that varies for an unchanged map would make the sync engine's
// hash-based change detection see a write on every save.
//
// Entries are comma-separated and their fields colon-separated, all base 36:
//
//     <idDelta>:<chapter>[:<waitUntilEpochDays>]
//
// The trailing field is omitted rather than left empty when there's no date, so
// there is exactly one spelling of every map.
// ---------------------------------------------------------------------------

const FIELD_SEPARATOR = ':'

/** Where a reader has got to in one still-being-written work. */
export interface WorkProgress {
  /** Last chapter finished. 0 means "marked, but nothing read yet". */
  chapter: number
  /**
   * Don't surface the work again before this day, in **days since the epoch**
   * rather than a timestamp — the decision is a calendar one, and a timestamp
   * would move it across a date boundary for anyone east or west of where it
   * was set. Absent means "as soon as there's something new".
   */
  waitUntil?: number
}

/** A non-negative safe integer, or null for anything else (blank, NaN, negative). */
function wholeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Pack per-work progress into the compact delta form. Input may be in any order;
 * the result is sorted by work id and canonical. Junk degrades rather than
 * throws: an unusable id drops its entry, an unusable chapter reads as 0, and an
 * unusable `waitUntil` is simply left out.
 */
export function packProgress(entries: Iterable<readonly [string | number, WorkProgress]>): string {
  const seen = new Map<number, WorkProgress>()
  for (const [raw, entry] of entries) {
    // Digits-only, for the same reason packIds is: Number('') is 0, which would
    // invent progress on a work id 0.
    const n = typeof raw === 'number' ? raw : (/^\d+$/.test(raw) ? Number(raw) : Number.NaN)
    if (!Number.isSafeInteger(n) || n < 0)
      continue
    const chapter = wholeNumber(entry?.chapter) ?? 0
    const waitUntil = wholeNumber(entry?.waitUntil)
    seen.set(n, waitUntil === null ? { chapter } : { chapter, waitUntil })
  }
  if (seen.size === 0)
    return ''

  let prev = 0
  const parts = [...seen.keys()].sort((a, b) => a - b).map((n) => {
    const { chapter, waitUntil } = seen.get(n)!
    const delta = n - prev
    prev = n
    const fields = [delta.toString(RADIX), chapter.toString(RADIX)]
    if (waitUntil !== undefined)
      fields.push(waitUntil.toString(RADIX))
    return fields.join(FIELD_SEPARATOR)
  })
  return parts.join(SEPARATOR)
}

/**
 * Unpack progress back into a `workId -> {@link WorkProgress}` map.
 *
 * A malformed id delta or chapter stops the walk, exactly as {@link unpackIds}
 * does and for the same reason: every later id is relative to this one. A
 * malformed *date* only costs that one date, since nothing downstream depends
 * on it.
 */
export function unpackProgress(packed: string): Map<string, WorkProgress> {
  const out = new Map<string, WorkProgress>()
  if (!packed)
    return out

  let prev = 0
  for (const part of packed.split(SEPARATOR)) {
    const [deltaRaw, chapterRaw, waitRaw] = part.split(FIELD_SEPARATOR)
    const delta = Number.parseInt(deltaRaw ?? '', RADIX)
    const chapter = Number.parseInt(chapterRaw ?? '', RADIX)
    if (!Number.isFinite(delta) || delta < 0 || !Number.isFinite(chapter) || chapter < 0)
      break
    prev += delta
    const waitUntil = waitRaw === undefined ? Number.NaN : Number.parseInt(waitRaw, RADIX)
    out.set(String(prev), Number.isFinite(waitUntil) && waitUntil >= 0 ? { chapter, waitUntil } : { chapter })
  }
  return out
}

/**
 * How many progress entries a packed string holds, without building the map.
 * The entry separator is shared with {@link countIds}, so this is the same split.
 */
export function countProgress(packed: string): number {
  return countIds(packed)
}

/**
 * Set or remove one work's progress, returning the new packed string — or
 * the *original* string (identity-equal) when nothing moved, so a redundant
 * `options.set` can be skipped. A `waitUntil` that has already passed is never
 * pruned here: the hint text says when it was, so dropping it would lose the
 * only record of a date the reader deliberately set.
 */
export function withProgress(packed: string, workId: string, entry: WorkProgress | null): string {
  const entries = unpackProgress(packed)
  const current = entries.get(workId)

  if (entry === null) {
    if (current === undefined)
      return packed
    entries.delete(workId)
    return packProgress(entries)
  }

  const chapter = wholeNumber(entry.chapter) ?? 0
  const waitUntil = wholeNumber(entry.waitUntil) ?? undefined
  if (current && current.chapter === chapter && current.waitUntil === waitUntil)
    return packed

  entries.set(workId, waitUntil === undefined ? { chapter } : { chapter, waitUntil })
  return packProgress(entries)
}
