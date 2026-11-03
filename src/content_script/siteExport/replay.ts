// Deep into `src/common` rather than through `#common`: the barrel reaches
// `browser` at import time, and this module is meant to be checkable with
// nothing under it, the way the rest of this directory is. `workMarks.ts` has no
// imports of its own, so the pair loads bare.
import type { MarkConfig, MarkId } from '../../common/workMarks.ts'
import type { ChangeOp } from './changeOps.ts'

import { markIsLocal, markTracksProgress, readWorkIdsIn, setMark, setMarkGroup, setMarkProgress } from '../../common/workMarks.ts'

/**
 * Replay what a reader did inside an export back onto their mark table.
 *
 * The other half of {@link file://./changeOps.ts}: that module says what a mark
 * made in an exported file *becomes*, this one says what becomes of it on the
 * way home. Pure, and for the same reason — the decidable parts of the round
 * trip (what order ops land in, what a second import of the same file does, what
 * cannot be applied and why) should be checkable without a browser.
 *
 * Three rules, and they are the whole merge:
 *
 * - **Order is `at`.** Ops are sorted by the moment they were made and applied
 *   in that order, so the last thing the reader said about a work is the thing
 *   that stands. That is the whole of last-write-wins here — the mark writers
 *   are idempotent and order-independent within one work, so nothing else is
 *   needed and there is no CRDT.
 * - **An op is applied once, ever.** {@link ReplayContext.applied} is the ledger
 *   of op ids the extension has already honoured, so importing the same file
 *   twice changes nothing — and, more to the point, a *newer* file that still
 *   carries an old op can't undo a change the reader has since made by hand.
 * - **What can't be applied is reported, never guessed at.** A mark the reader
 *   has deleted since, a progress payload for a mark that no longer tracks
 *   progress, a work AO3 has already taken off the list: each is skipped with a
 *   reason a reader can act on.
 *
 * What AO3 is asked to do is weighed after the marks, against the table they
 * leave: one request per work, and only for a work still marked read. The
 * requests an earlier import could not make come in as
 * {@link ReplayContext.owed} and are weighed the same way, so a work unmarked
 * since — in the file or by hand — stays on Marked for Later.
 *
 * Nothing here writes anything. The next table comes back as a value and the
 * archive-side acts come back as a list; {@link file://./importChanges.ts} is
 * what commits them.
 */

/**
 * Why a work marked read here isn't asked off Marked for Later: a scrape since
 * the mark no longer lists it.
 */
export const OFF_THE_LIST = 'marked here, but it is no longer on your Marked for Later list'

/**
 * Why a work read in an export isn't asked off Marked for Later after all: by
 * the time AO3 could be asked, it no longer carries a mark that says it is read
 * — unmarked later in the same file, or by hand since.
 */
export const NO_LONGER_READ = 'no longer marked read here, so it stays on your Marked for Later list'

/** One op that could not be applied, and what to tell the reader about it. */
export interface ReplaySkip {
  workId: string
  reason: string
}

/** A work the archive has to be told about, and the op asking for it. */
export interface ArchiveAct {
  workId: string
  opId: string
  /** When that op was made, for weighing against a scrape of the list. */
  at: number
}

export interface ReplayContext {
  /** The reader's mark table as it stands. Never mutated. */
  marks: Record<MarkId, MarkConfig>
  /** Op ids whose mark is already in the table — the idempotency ledger. */
  applied: ReadonlySet<string>
  /** Requests to AO3 that earlier imports applied the marks for but could not make. */
  owed?: readonly ArchiveAct[]
  /**
   * The reader's Marked for Later list as last scraped, when there is one worth
   * reading, along with when it was scraped.
   *
   * Used for exactly one judgement: whether a `markAsRead` op still has anything
   * for AO3 to do. A work missing from the index normally means "unknown" rather
   * than "not saved" — but a scrape that happened *after* the op was made and
   * doesn't list the work is evidence the archive already agrees, so the request
   * is skipped rather than spent. An index older than the op says nothing, and
   * the act goes ahead.
   */
  listed?: { ids: ReadonlySet<string>, updatedAt: number } | null
}

export interface ReplayResult {
  /** The table to store. Identity-equal to the one passed in when nothing moved. */
  marks: Record<MarkId, MarkConfig>
  /** Op ids honoured by this run, in the order they were applied. */
  applied: string[]
  /** Ops the ledger had seen before. */
  duplicates: number
  skipped: ReplaySkip[]
  /** What the archive still has to be told: one act per work, new or owed. */
  archive: ArchiveAct[]
}

export function replayChanges(ops: ChangeOp[], ctx: ReplayContext): ReplayResult {
  const result: ReplayResult = {
    marks: ctx.marks,
    applied: [],
    duplicates: 0,
    skipped: [],
    archive: [],
  }

  // A copy: the caller's array is the file it read, and sorting it under them
  // would quietly reorder what they go on to report.
  const ordered = [...ops].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const asked = new Map<string, ArchiveAct>()
  const ask = (act: ArchiveAct): void => {
    if ((asked.get(act.workId)?.at ?? -Infinity) <= act.at)
      asked.set(act.workId, act)
  }
  ctx.owed?.forEach(ask)

  for (const op of ordered) {
    if (ctx.applied.has(op.id)) {
      result.duplicates++
      continue
    }

    const skip = unapplicable(result.marks, op)
    if (skip) {
      result.skipped.push({ workId: op.workId, reason: skip })
      continue
    }

    result.marks = apply(result.marks, op)
    result.applied.push(op.id)
    if (op.op === 'markAsRead' && op.payload.on)
      ask({ workId: op.workId, opId: op.id, at: op.at })
  }

  // The local half is done either way; only the archive's half can be spent on
  // nothing, so only it is weighed against the table and what the list last said.
  const read = asked.size ? readWorkIdsIn(result.marks) : new Set<string>()
  for (const act of asked.values()) {
    if (!read.has(act.workId))
      result.skipped.push({ workId: act.workId, reason: NO_LONGER_READ })
    else if (alreadyOffTheList(ctx, act))
      result.skipped.push({ workId: act.workId, reason: OFF_THE_LIST })
    else
      result.archive.push(act)
  }

  return result
}

/**
 * Why this op can't be honoured, or null when it can.
 *
 * Everything here is a mark table that has moved on since the export was made —
 * which is ordinary, since the table is the reader's and an export is a
 * photograph of it. What matters is that the run says so per work rather than
 * writing something that looks like the op but isn't.
 */
function unapplicable(marks: Record<MarkId, MarkConfig>, op: ChangeOp): string | null {
  const { markId } = op.payload
  if (!marks[markId])
    return `the “${markId}” mark no longer exists here`
  if (!markIsLocal(marks, markId))
    return `“${label(marks, markId)}” doesn't keep its own list of works here`
  if (op.op === 'setProgress') {
    if (!op.payload.progress)
      return `“${label(marks, markId)}” came without the chapter it was meant to record`
    if (!markTracksProgress(marks, markId))
      return `“${label(marks, markId)}” no longer tracks where you got to`
  }
  return null
}

/**
 * The op, through the writer that made it.
 *
 * `group` is the disposition flag {@link file://./changeOps.ts} sets on a write
 * that came from a button meaning "done with this" rather than from a choice of
 * mark — replayed through {@link setMarkGroup}, it leaves a finer mark in the
 * same group standing, which is exactly what it did when the reader pressed it.
 */
function apply(marks: Record<MarkId, MarkConfig>, op: ChangeOp): Record<MarkId, MarkConfig> {
  const { markId, on, group, progress } = op.payload
  if (op.op === 'setProgress' && progress)
    return setMarkProgress(marks, op.workId, markId, progress)
  return group
    ? setMarkGroup(marks, op.workId, markId, on)
    : setMark(marks, op.workId, markId, on)
}

/** See {@link ReplayContext.listed} — evidence, not the absence of evidence. */
function alreadyOffTheList(ctx: ReplayContext, act: ArchiveAct): boolean {
  const listed = ctx.listed
  return !!listed && listed.updatedAt > act.at && !listed.ids.has(act.workId)
}

function label(marks: Record<MarkId, MarkConfig>, markId: MarkId): string {
  return marks[markId]?.label || markId
}
