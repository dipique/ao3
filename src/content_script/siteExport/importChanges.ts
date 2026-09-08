import { cache, options, packIds, unpackIds } from '#common'
import { submitMark } from '#content_script/markForLater.js'

import type { ArchiveAct, ReplaySkip } from './replay.ts'

import { parseChangeExport } from './changeOps.ts'
import { replayChanges } from './replay.ts'

/**
 * Take a file of changes made inside a site export and put them back.
 *
 * The impure half of the round trip — {@link file://./replay.ts} decides what
 * each op means and this commits it, the same split
 * {@link file://./exportSite.ts} and {@link file://./payload.ts} keep on the way
 * out. What it touches: the mark table (one write, not one per op), the ledger
 * of applied op ids, the Marked for Later index, and — for the one op with a
 * half only the archive can do — AO3 itself.
 *
 * **The file is the queue.** An op is written into the ledger once everything it
 * asked for has happened, so a `markAsRead` whose request to AO3 failed, or that
 * the reader chose not to send, is left out of it: importing the same file again
 * once they are signed back in picks up exactly those and nothing else. The
 * local half re-applies as a no-op, which is what makes that safe.
 *
 * **Nothing is merged silently.** Every op lands in one of five buckets —
 * applied, already applied, unreadable, skipped, or refused by the archive — and
 * the report carries the last two per work, because those are the ones a reader
 * may want to do something about.
 */

/**
 * Op ids kept in the ledger. Ids are 36 bytes and a year of heavy marking is
 * some thousands of them, so the cap is generous; what it protects against is a
 * cache row growing without limit forever. Trimming loses only the promise that
 * a *very* old file re-imported changes nothing — and re-applying an old op is a
 * no-op against a table that already has it.
 */
const LEDGER_LIMIT = 20_000

/**
 * How many mark requests may fail in a row before the rest are left for another
 * day. A signed-out reader would otherwise send AO3 one doomed request per work
 * they read on holiday, and the file they still have is a better place for those
 * ops than a log of failures.
 */
const ARCHIVE_GIVE_UP = 3

export interface ChangeImportReport {
  /** Which list the reader was in when they made these. */
  sourceId: string
  exportedAt: number
  /** Ops in the file, readable or not. */
  total: number
  applied: number
  /** Ops this extension had already honoured — a second import of one file. */
  duplicates: number
  /** Entries that were not ops at all. */
  unreadable: number
  skipped: ReplaySkip[]
  /** Works taken off Marked for Later on AO3. */
  toldArchive: number
  /** Works AO3 could not be told about; their ops stay owed. */
  archiveFailed: ReplaySkip[]
  /** Works AO3 was deliberately not told about, at the reader's choice. */
  archiveHeld: number
}

export interface ImportChangesOptions {
  /**
   * Whether to carry out the half of a `markAsRead` that only AO3 can do.
   *
   * Off is offered because it is the one part of an import that reaches outside
   * this device and changes something on the reader's account. Held ops are not
   * ledgered, so choosing it defers them rather than dropping them.
   */
  tellArchive: boolean
}

export async function importChanges(text: string, opts: ImportChangesOptions): Promise<ChangeImportReport> {
  const { file, unreadable } = parseChangeExport(text)

  const [workMarks, user, stored] = await Promise.all([
    options.get('workMarks'),
    options.get('user'),
    cache.get(['appliedChangeOps', 'markedForLater']),
  ])

  // The index is kept per account — someone else's ids would be nonsense here —
  // so it is read only where this device knows whose it is and agrees.
  const index = stored.markedForLater
  const mine = !!index.userId && index.userId === (user.userId ?? '').toLowerCase()
  const listedIds = mine ? unpackIds(index.ids) : null

  const result = replayChanges(file.ops, {
    marks: workMarks.marks,
    applied: new Set(stored.appliedChangeOps),
    listed: listedIds && index.updatedAt ? { ids: listedIds, updatedAt: index.updatedAt } : null,
  })

  const archive = opts.tellArchive
    ? await tellArchive(result.archive)
    : { sent: [], failed: [], held: result.archive } satisfies ArchiveOutcome

  // The table first: it is what the reader will look at, and it is the half that
  // is true whatever the archive said.
  if (result.marks !== workMarks.marks)
    await options.set({ workMarks: { ...workMarks, marks: result.marks } })

  // A work AO3 has just been told about is off that list, so the index that
  // draws the saved indicator should stop claiming it is on it. `updatedAt` is
  // left where it was on purpose — this is a correction to a scrape, not a new
  // one, and dating it now would make the rest of the index look fresher than it
  // is (which is a judgement {@link file://./replay.ts} goes on to make).
  if (listedIds && archive.sent.length) {
    for (const act of archive.sent)
      listedIds.delete(act.workId)
    await cache.set({ markedForLater: { ...index, ids: packIds(listedIds) } })
  }

  // An op is only written down as done once both its halves are — see the note
  // on the file being the queue, above.
  const owed = new Set([...archive.failed.map(entry => entry.act.opId), ...archive.held.map(act => act.opId)])
  const learned = result.applied.filter(id => !owed.has(id))
  if (learned.length)
    await cache.set({ appliedChangeOps: [...stored.appliedChangeOps, ...learned].slice(-LEDGER_LIMIT) })

  return {
    sourceId: file.sourceId,
    exportedAt: file.exportedAt,
    total: file.ops.length + unreadable,
    applied: result.applied.length,
    duplicates: result.duplicates,
    unreadable,
    skipped: result.skipped,
    toldArchive: archive.sent.length,
    archiveFailed: archive.failed.map(entry => ({ workId: entry.act.workId, reason: entry.reason })),
    archiveHeld: archive.held.length,
  }
}

interface ArchiveOutcome {
  sent: ArchiveAct[]
  failed: { act: ArchiveAct, reason: string }[]
  /** Acts never attempted — held back by the reader, or after a run of failures. */
  held: ArchiveAct[]
}

/**
 * Take each work off the reader's Marked for Later list on AO3, one at a time.
 *
 * Sequential rather than pooled: this is a handful of requests at the end of an
 * import, not a bulk fetch, and a queue of one is the politest shape there is.
 * A run of failures stops it — see {@link ARCHIVE_GIVE_UP}.
 */
async function tellArchive(acts: ArchiveAct[]): Promise<ArchiveOutcome> {
  const sent: ArchiveAct[] = []
  const failed: ArchiveOutcome['failed'] = []
  let consecutive = 0

  for (const [position, act] of acts.entries()) {
    try {
      await submitMark(act.workId, false)
      sent.push(act)
      consecutive = 0
    }
    catch (error) {
      failed.push({ act, reason: error instanceof Error ? error.message : String(error) })
      if (++consecutive >= ARCHIVE_GIVE_UP)
        return { sent, failed, held: acts.slice(position + 1) }
    }
  }

  return { sent, failed, held: [] }
}
