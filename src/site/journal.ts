import type { MarkConfig, MarkId, WorkMarks } from '#common'
import type { ChangeExport, ChangeOp } from '#content_script/siteExport/changeOps.js'
import type { MarkWrite } from '#content_script/workMarks.js'

import { markRoot, markTracksProgress, READ_MARK, saveAs } from '#common'
import { CHANGE_SCHEMA_VERSION, changeFileName, changeOpFor, newOpId } from '#content_script/siteExport/changeOps.js'
import { observeMarkWrites } from '#content_script/workMarks.js'

import { JOURNAL_STORE, recordExport, siteDatabase } from './shim.ts'

/**
 * What the reader did in this file, kept so it can be given back.
 *
 * An export is read where the extension isn't, so marking one is only half an
 * act — the other half happens when the extension sees it again. Between the two
 * sits this: an **append-only journal** in the `journal` store of the one
 * `ao3e-site` database ({@link file://./shim.ts}), written as the reader marks
 * and read back when they export it.
 *
 * **One journal, shared by every export.** Every local file lives on one `file:`
 * origin, so a re-export — which lands under a new name — finds what the last
 * one left. That is what you want: ops are keyed by work, not by list, and an
 * ingest wants one file to apply rather than one per library.
 *
 * **It is a buffer, not a store of record.** Nothing can be asked about when
 * browser storage goes away, and a `file:` origin will not even promise to keep
 * it — `persist()` is refused there, measured on the device this was written
 * for. So the one honest mitigation is to say how much is riding on it and make
 * exporting the obvious next thing, which is why {@link Journal.pending} exists
 * and is shown where it can't be missed.
 *
 * **Where storage isn't writable there is no journal at all.** {@link start}
 * returns null, the caller turns the mark controls off with it, and nothing is
 * recorded — because a mark that silently fails to save is worse than a mark
 * that was never offered. That check lives here and in the shim rather than
 * being sprinkled through the view as `if (readOnly)`.
 */

/** How much the reader still holds only here, and how old the oldest of it is. */
export interface Pending {
  count: number
  /** Epoch ms of the oldest unexported op, or null when there are none. */
  oldestAt: number | null
}

/** What one press of "Export changes" turned out to be. */
export interface Written {
  ops: number
  /** What the file was saved as, or '' when there was nothing to save. */
  fileName: string
}

export interface Journal {
  /** Ops made since the last export. Recomputed as each one is appended. */
  readonly pending: Pending
  /** Called after each append, so the count on screen follows the marking. */
  onChange: (fn: () => void) => void
  /** Hand everything recorded here to the reader as a file. See {@link save}. */
  save: () => Promise<Written>
}

export interface JournalContext {
  /** The export's list, which decides whether a "done" mark is also an AO3 act. */
  sourceId: string
  /** From the origin's stored meta: what the pending count is measured against. */
  lastExportedAt: number | null
  /**
   * The reader's mark table, for reading what a written mark *means*. Only its
   * configuration is read — which marks alias `read`, which one tracks progress
   * — and an export has no way to change that, so the table as loaded stands.
   */
  marks: WorkMarks
  /** Told what could not be written, so the page can stop claiming it was. */
  onError: (error: unknown) => void
}

/** The one list AO3 itself holds, and so the only one a mark can take a work off. */
const MARKED_FOR_LATER = 'marked-for-later'

/**
 * Open the journal and start recording, or return null where this origin keeps
 * nothing.
 *
 * The ops already there are counted on the way in rather than loaded: only the
 * count and the oldest timestamp are ever shown, and a library marked across
 * months has no business holding every op it ever made in memory to say "12".
 */
export async function start(ctx: JournalContext): Promise<Journal | null> {
  const db = siteDatabase()
  if (!db)
    return null

  let pending: Pending
  try {
    pending = await countPending(db, ctx.lastExportedAt)
  }
  catch (error) {
    ctx.onError(error)
    return null
  }

  const listeners = new Set<() => void>()
  /** Appends are chained, so ops land in the order the reader made them. */
  let writes: Promise<void> = Promise.resolve()

  observeMarkWrites((write) => {
    const op = opFor(write, ctx)
    pending = { count: pending.count + 1, oldestAt: pending.oldestAt ?? op.at }
    for (const listener of listeners)
      listener()
    // A failed append is reported, not retried: the mark itself is already in
    // storage, and the honest thing to do about a journal that stopped taking
    // ops is to say so rather than to guess when it might start again.
    writes = writes.then(() => append(db, op), () => append(db, op)).catch(ctx.onError)
  })

  /**
   * Write the journal out as the file the extension takes back.
   *
   * **Everything in it, not only what is new.** The alternative — sending the
   * ops made since the last export — would make each file the only copy of the
   * afternoon it covers, on a device where a download is as easy to lose as a
   * browser is to clear. Ops are tiny, the ingest skips by id any it has already
   * applied, and re-exporting is the reader's whole recovery from a file they
   * mislaid. So the count resets and the store does not.
   *
   * Outstanding appends are waited for first, so a mark made a second ago is in
   * this file rather than in the next one.
   */
  const save = async (): Promise<Written> => {
    await writes.catch(() => {})
    const ops = await readOps(db)
    if (!ops.length)
      return { ops: 0, fileName: '' }

    const exportedAt = Date.now()
    const file: ChangeExport = { v: CHANGE_SCHEMA_VERSION, sourceId: ctx.sourceId, exportedAt, ops }
    const fileName = changeFileName(ctx.sourceId, new Date(exportedAt))
    saveAs(new Blob([JSON.stringify(file)], { type: 'application/json' }), fileName)

    await recordExport(exportedAt)
    pending = { count: 0, oldestAt: null }
    for (const listener of listeners)
      listener()
    return { ops: ops.length, fileName }
  }

  return {
    get pending() {
      return pending
    },
    onChange: fn => void listeners.add(fn),
    save,
  }
}

/** Every op ever recorded here, oldest first — the order an ingest replays in. */
function readOps(db: IDBDatabase): Promise<ChangeOp[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(JOURNAL_STORE, 'readonly')
    const request = tx.objectStore(JOURNAL_STORE).index('at').getAll()
    tx.oncomplete = () => resolve(request.result as ChangeOp[])
    tx.onerror = () => reject(tx.error ?? new Error('the record of your changes could not be read'))
  })
}

/**
 * What one mark write means, here.
 *
 * The one thing this file knows that {@link changeOpFor} can't is whether the
 * work was on a list the archive holds. Every mark in the read group means "done
 * with this", and on a live page that also takes the work off Marked for Later —
 * the single piece of mark behaviour that is AO3's rather than ours. An export
 * of *that list* is the one place we can say a work was on it without asking:
 * it was, on the day the file was made. The progress mark is the exception it
 * always is, sitting in the read group to say precisely that the reader is not
 * done.
 */
function opFor(write: MarkWrite, ctx: JournalContext): ChangeOp {
  const table: Record<MarkId, MarkConfig> = ctx.marks.marks
  return changeOpFor(write, {
    id: newOpId(),
    at: Date.now(),
    finishesRead: write.on
      && markRoot(table, write.markId) === READ_MARK
      && !markTracksProgress(table, write.markId),
    listedForLater: ctx.sourceId === MARKED_FOR_LATER,
  })
}

function append(db: IDBDatabase, op: ChangeOp): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(JOURNAL_STORE, 'readwrite')
    tx.objectStore(JOURNAL_STORE).put(op)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('the change could not be recorded'))
    tx.onabort = () => reject(tx.error ?? new Error('storage refused to record the change'))
  })
}

/**
 * Count what hasn't been exported, over the `at` index the store was created
 * with — a range on an index rather than a walk over every op ever made.
 *
 * The oldest is the first key in that same range, from a cursor that is opened
 * and never advanced. Both come out of one transaction, so they cannot disagree
 * about what was in the store when they were asked.
 *
 * `lastExportedAt` is exclusive: an op made in the same millisecond as an export
 * counts as unexported, because the alternative is losing it.
 */
function countPending(db: IDBDatabase, lastExportedAt: number | null): Promise<Pending> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(JOURNAL_STORE, 'readonly')
    const index = tx.objectStore(JOURNAL_STORE).index('at')
    const range = lastExportedAt === null ? undefined : IDBKeyRange.lowerBound(lastExportedAt, true)
    const counted = index.count(range)
    const cursor = index.openKeyCursor(range)
    let oldestAt: number | null = null
    cursor.onsuccess = () => {
      const key = cursor.result?.key
      oldestAt = typeof key === 'number' ? key : null
    }
    tx.oncomplete = () => resolve({ count: counted.result, oldestAt })
    tx.onerror = () => reject(tx.error ?? new Error('the record of your changes could not be read'))
  })
}
