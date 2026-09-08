import type { MarkWrite } from '#content_script/workMarks.js'

/**
 * What the reader did inside an export, as data.
 *
 * An export is read where the extension isn't, so the marking done there has to
 * travel back as something rather than as a state to diff. That something is an
 * **append-only list of ops**: each one names a work and one change made to it,
 * timestamped. Merging is a union with last-write-wins per `(workId, markId)` by
 * `at` — mark writes are idempotent and order-independent, so there is no CRDT
 * here and no need for one.
 *
 * Pure — plain functions over plain data, no `#common`, no `browser`, no DOM —
 * for the same reason {@link file://./payload.ts} is: this is the shape both
 * ends of the round trip agree on, and both ends should be checkable headlessly.
 * The store the ops live in belongs to the exported page, and so does the
 * knowledge of what a given write *means* there.
 */

/**
 * The change-file schema. One of four separate numbers in this feature —
 * distinct from `SNAPSHOT_VERSION`, `WORK_TEXT_VERSION` and
 * `SITE_SCHEMA_VERSION` ({@link file://./payload.ts}) — and bumped when the
 * shape of an op, or of the file carrying them, changes.
 */
export const CHANGE_SCHEMA_VERSION = 1

/**
 * What one op asks the extension to do on the way back in.
 *
 * `setMark` and `setProgress` are local: they replay through the writers that
 * made them ({@link file://./../workMarks.ts}), so a re-import changes nothing.
 * `markAsRead` is a `setMark` with a second half the archive has to do — every
 * mark in the read group takes a work off the reader's Marked for Later list,
 * and that pairing is AO3's rather than ours, so only AO3 can honour it.
 */
export type ChangeOpKind = 'setMark' | 'setProgress' | 'markAsRead'

/** The chapter/date a progress op carries, as it travels. */
export interface ChangeProgress {
  chapter: number
  waitUntil?: number
}

export interface ChangeOpPayload {
  markId: string
  /** Whether the mark was set or cleared. Always true on a progress op. */
  on: boolean
  /**
   * Set when the write was a *disposition* rather than a specific choice — what
   * AO3's own buttons mean. It replays through `applyMarkGroup`, which leaves a
   * finer mark in the same group standing where a plain `setMark` would replace
   * it. Absent is the common case and the narrower one.
   */
  group?: true
  /** Only on `setProgress`. */
  progress?: ChangeProgress
}

export interface ChangeOp {
  /** Unique per op, and the idempotency key: an applied id is never applied twice. */
  id: string
  /** Epoch ms. The merge key, and what the unexported count is measured against. */
  at: number
  workId: string
  op: ChangeOpKind
  payload: ChangeOpPayload
}

/** The file an export hands back, and the file the options page takes in. */
export interface ChangeExport {
  v: number
  /** Which list was being read — for the report, not for the merge. */
  sourceId: string
  exportedAt: number
  ops: ChangeOp[]
}

/**
 * Turn one accepted mark write into the op that records it.
 *
 * Two facts come from the caller because this module has no mark table to read
 * them from. `finishesRead` is whether the write leaves the work *done with* at
 * the read-group level — set, in the read group, and not the progress mark,
 * which sits in that group meaning the opposite. `listedForLater` is whether the
 * list being read is one AO3 itself holds. Only both together make an op the
 * archive has to hear about; anywhere else there is no reason to believe the
 * work was ever on the reader's list, so the op doesn't claim it was.
 */
export function changeOpFor(
  write: MarkWrite,
  ctx: { id: string, at: number, finishesRead: boolean, listedForLater: boolean },
): ChangeOp {
  const payload: ChangeOpPayload = { markId: write.markId, on: write.on }
  if (write.via === 'group')
    payload.group = true
  if (write.via === 'progress' && write.progress) {
    payload.progress = write.progress.waitUntil === undefined
      ? { chapter: write.progress.chapter }
      : { chapter: write.progress.chapter, waitUntil: write.progress.waitUntil }
  }

  const op: ChangeOpKind = write.via === 'progress'
    ? 'setProgress'
    : ctx.finishesRead && ctx.listedForLater ? 'markAsRead' : 'setMark'

  return { id: ctx.id, at: ctx.at, workId: write.workId, op, payload }
}

/**
 * An id for a new op. `randomUUID` where it is there — it wants a secure
 * context, which a page opened from disk is not guaranteed to be — and a
 * timestamped random string otherwise. Uniqueness is all that is asked of it:
 * the id is only ever compared for equality, by an ingest deciding whether it
 * has applied this op before.
 */
export function newOpId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID()
    }
    catch {
      // A browser that has it but won't run it here falls through.
    }
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * `ao3e-changes-marked-for-later-2026-09-07_14-51-02.json` — the list it came
 * from, then when it was written.
 *
 * The list is in the name for the reader's sake rather than the merge's: ops are
 * keyed by work, and one journal serves every export a reader opens, so two
 * files from two libraries are still one pile of changes to the ingest. What the
 * name has to do is let a reader with several of these in a folder tell which
 * afternoon is which.
 */
export function changeFileName(sourceId: string, when: Date): string {
  const iso = when.toISOString()
  const time = `${iso.slice(0, 10)}_${iso.slice(11, 19).replace(/:/g, '-')}`
  const slug = sourceId.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).toLowerCase()
  return `ao3e-changes-${slug || 'export'}-${time}.json`
}

/**
 * Read a change file, keeping the ops that are still legible.
 *
 * The envelope is checked strictly — a file that isn't one of ours, or is from a
 * schema this build doesn't know, is refused whole, because guessing at it would
 * be worse than saying so. The ops inside are checked one at a time and the
 * unreadable ones are counted rather than thrown, since one corrupt op is no
 * reason to drop an afternoon's marking on the floor; the count is reported
 * beside the rest of the run.
 */
export function parseChangeExport(text: string): { file: ChangeExport, unreadable: number } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    throw new SyntaxError('That file isn\'t readable as JSON.')
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.ops) || typeof parsed.sourceId !== 'string')
    throw new TypeError('That doesn\'t look like a file of changes from an exported site.')
  if (typeof parsed.v !== 'number' || parsed.v > CHANGE_SCHEMA_VERSION)
    throw new TypeError(`That file was written by a newer version of the extension (format ${String(parsed.v)}). Update, then import it again.`)

  const ops = parsed.ops.filter(isChangeOp)
  return {
    file: {
      v: parsed.v,
      sourceId: parsed.sourceId,
      exportedAt: typeof parsed.exportedAt === 'number' ? parsed.exportedAt : 0,
      ops,
    },
    unreadable: parsed.ops.length - ops.length,
  }
}

const OP_KINDS: ReadonlySet<string> = new Set<ChangeOpKind>(['setMark', 'setProgress', 'markAsRead'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether one entry of a change file is an op at all.
 *
 * Only the fields the replay reads, and only that they are the right kind of
 * thing: an op from a future schema with extra fields on it is still an op this
 * one can apply, and refusing it would make every added field a breaking change.
 */
function isChangeOp(value: unknown): value is ChangeOp {
  if (!isRecord(value))
    return false
  const { id, at, workId, op, payload } = value
  if (typeof id !== 'string' || !id || typeof workId !== 'string' || !workId)
    return false
  if (typeof at !== 'number' || !Number.isFinite(at) || typeof op !== 'string' || !OP_KINDS.has(op))
    return false
  if (!isRecord(payload) || typeof payload.markId !== 'string' || !payload.markId || typeof payload.on !== 'boolean')
    return false
  if (payload.progress !== undefined) {
    const progress = payload.progress
    if (!isRecord(progress) || typeof progress.chapter !== 'number' || !Number.isFinite(progress.chapter))
      return false
    if (progress.waitUntil !== undefined && typeof progress.waitUntil !== 'number')
      return false
  }
  return true
}
