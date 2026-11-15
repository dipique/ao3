import type { ArchiveRefusal, WaitReason } from '#content_script/archiveFetch.js'

import { ARCHIVE_UNAVAILABLE, cache, options, packIds, unpackIds } from '#common'
import { askWithRetry, onArchiveWait, WAIT_BUDGET } from '#content_script/archiveFetch.js'
import { archiveAnswers, MarkRequestError, NOT_SIGNED_IN, submitMark, submitMarkViaTab } from '#content_script/markForLater.js'

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
 * of applied op ids, the requests still owed to AO3, the Marked for Later index,
 * and — for the one op with a half only the archive can do — AO3 itself.
 *
 * **The two halves are recorded apart.** An op goes into the ledger as soon as
 * its mark is in the table, so no later import applies it again over a change
 * made by hand since. A `markAsRead` whose request to AO3 failed, or that the
 * reader chose not to send, is kept as an act owed instead, and every import
 * after it tries again — for each work the table still has marked read by then.
 *
 * **The local half goes down before AO3 is asked anything.** The table, the
 * ledger, and every request AO3 is about to be sent — recorded as owed — are
 * written first, and each work leaves the owed list as AO3 takes it. Telling
 * the archive can run for many minutes, and neither a mark the reader makes in
 * the meantime nor a page closed halfway through may cost them what the file
 * held.
 *
 * **Being asked to slow down is waited out.** Each request goes through the
 * pause every request to AO3 shares ({@link file://./../archiveFetch.ts}), so a
 * 429 is sat out and the same work asked again, with the page counting the
 * wait down ({@link ImportChangesOptions.onProgress}); only a refusal that
 * outlasts {@link REFUSAL_PATIENCE} stops the run, leaving the rest owed.
 *
 * **The reader can stop it** ({@link ImportChangesOptions.signal}). A request
 * already out is let finish, since AO3 may have done it, and counted for what
 * it came to; a wait is cut short, nothing after is asked, and the rest stay
 * owed exactly as a run AO3 stopped leaves them.
 *
 * **Nothing is merged silently.** Every op lands in one of five buckets —
 * applied, already applied, unreadable, skipped, or refused by the archive — and
 * the report carries the last two per work, because those are the ones a reader
 * may want to do something about.
 *
 * **The archive half has a second way to happen.** A POST from this page carries
 * no `Origin` and no `Referer`, which AO3 was measured to accept but is under no
 * obligation to go on accepting. Where it is turned down, one of the reader's
 * open AO3 tabs is asked to make the request instead
 * ({@link file://./../markForLater.ts}), and the run stays with the tab once one
 * has worked. It is a fallback and not the path: a tab is something the reader
 * has to have open, and asking for one when nothing needs it would make an
 * import fussier than it is.
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

/**
 * How long one work's request may spend waiting out AO3's 429s before the rest
 * of the run is left owed.
 *
 * Per work rather than per run: each work that gets through shows AO3 taking
 * requests again, so a long import refused now and then carries on for as long
 * as it makes progress, and only a refusal that outlasts this ends it. The
 * budget of a run a reader is watching, since they are: the page counts every
 * wait down.
 */
export const REFUSAL_PATIENCE = WAIT_BUDGET.interactive

/**
 * How far an import has got, as the page draws it: applying the file's marks,
 * then telling AO3 about the works marked read, one at a time.
 */
export interface ChangeImportProgress {
  step: 'applying' | 'archive'
  /** Works AO3 has been asked about and given an answer for, taken or not. */
  done: number
  /** Works AO3 is to be asked about in this run. */
  total: number
  /** While the requests sit out a pause: when it ends, in epoch ms by the pacing's clock. */
  waitingUntil: number | null
  /** And which kind of pause it is. */
  waitReason: WaitReason | null
}

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
  /**
   * How many of those AO3 would only take from one of its own pages.
   *
   * Zero on a healthy import, and worth saying when it isn't: it is the only
   * sign the reader gets that this round trip now depends on their having an AO3
   * tab open, and so on why the next import might refuse without one.
   */
  viaTab: number
  /** Works AO3 could not be told about; their requests stay owed. */
  archiveFailed: ReplaySkip[]
  /** Works AO3 was not told about — at the reader's choice, or because the run stopped first; their requests stay owed. */
  archiveHeld: number
  /** Whether the run stopped because AO3 was still asking us to wait after {@link REFUSAL_PATIENCE}. */
  rateLimited: boolean
  /** Whether the reader stopped the run before AO3 had been asked about every work. */
  stopped: boolean
}

export interface ImportChangesOptions {
  /**
   * Whether to carry out the half of a `markAsRead` that only AO3 can do.
   *
   * Off is offered because it is the one part of an import that reaches outside
   * this device and changes something on the reader's account. Held requests
   * are kept as owed, so choosing it defers them rather than dropping them.
   */
  tellArchive: boolean
  /** Hears how far the import has got: as it starts, after every work AO3 is asked about, and as each pause begins and ends. */
  onProgress?: (progress: ChangeImportProgress) => void
  /** The reader's Stop: once it aborts, AO3 is asked about nothing more. */
  signal?: AbortSignal
}

export async function importChanges(text: string, opts: ImportChangesOptions): Promise<ChangeImportReport> {
  opts.onProgress?.({ step: 'applying', done: 0, total: 0, waitingUntil: null, waitReason: null })
  const { file, unreadable } = parseChangeExport(text)

  const [workMarks, user, stored] = await Promise.all([
    options.get('workMarks'),
    options.get('user'),
    cache.get(['appliedChangeOps', 'owedArchiveActs', 'markedForLater']),
  ])

  // The index is kept per account — someone else's ids would be nonsense here —
  // so it is read only where this device knows whose it is and agrees.
  const index = stored.markedForLater
  const mine = !!index.userId && index.userId === (user.userId ?? '').toLowerCase()
  const listedIds = mine ? unpackIds(index.ids) : null

  const result = replayChanges(file.ops, {
    marks: workMarks.marks,
    applied: new Set(stored.appliedChangeOps),
    owed: stored.owedArchiveActs,
    listed: listedIds && index.updatedAt ? { ids: listedIds, updatedAt: index.updatedAt } : null,
  })

  // The table first: it is what the reader will look at, and it is the half that
  // is true whatever the archive said.
  if (result.marks !== workMarks.marks)
    await options.set({ workMarks: { ...workMarks, marks: result.marks } })
  if (result.applied.length)
    await cache.set({ appliedChangeOps: [...stored.appliedChangeOps, ...result.applied].slice(-LEDGER_LIMIT) })
  if (!sameActs(result.archive, stored.owedArchiveActs))
    await cache.set({ owedArchiveActs: result.archive })

  const archive = opts.tellArchive && result.archive.length
    ? await tellArchive(result.archive, {
        onProgress: opts.onProgress,
        onOwed: owed => cache.set({ owedArchiveActs: owed }),
        signal: opts.signal,
      })
    : { sent: [], failed: [], held: result.archive, viaTab: 0, cutShort: null } satisfies ArchiveOutcome

  // A work AO3 has just been told about is off that list, so the index that
  // draws the saved indicator should stop claiming it is on it. `updatedAt` is
  // left where it was on purpose — this is a correction to a scrape, not a new
  // one, and dating it now would make the rest of the index look fresher than it
  // is (which is a judgement {@link file://./replay.ts} goes on to make).
  //
  // Read again rather than taken from the copy the replay weighed: telling AO3
  // can outlast that copy, and a scrape that landed meanwhile is the newer word
  // on every work but these.
  if (mine && archive.sent.length) {
    const latest = (await cache.get(['markedForLater'])).markedForLater
    if (latest.userId === index.userId) {
      const ids = unpackIds(latest.ids)
      for (const act of archive.sent)
        ids.delete(act.workId)
      await cache.set({ markedForLater: { ...latest, ids: packIds(ids) } })
    }
  }

  return {
    sourceId: file.sourceId,
    exportedAt: file.exportedAt,
    total: file.ops.length + unreadable,
    applied: result.applied.length,
    duplicates: result.duplicates,
    unreadable,
    skipped: result.skipped,
    toldArchive: archive.sent.length,
    viaTab: archive.viaTab,
    archiveFailed: archive.failed.map(entry => ({ workId: entry.act.workId, reason: entry.reason })),
    archiveHeld: archive.held.length,
    rateLimited: archive.cutShort === 'refused',
    stopped: archive.cutShort === 'reader',
  }
}

/** Whether two lists of acts are the same requests in the same order: an owed list that needs no rewriting. */
function sameActs(a: readonly ArchiveAct[], b: readonly ArchiveAct[]): boolean {
  return a.length === b.length && a.every((act, i) => act.opId === b[i]!.opId && act.workId === b[i]!.workId)
}

interface ArchiveOutcome {
  sent: ArchiveAct[]
  failed: { act: ArchiveAct, reason: string }[]
  /** Acts never attempted — held back by the reader, or left once the run stopped. */
  held: ArchiveAct[]
  /** How many of {@link sent} an AO3 tab had to make the request for. */
  viaTab: number
  /**
   * What ended the run before every work was asked about: AO3 still refusing
   * after {@link REFUSAL_PATIENCE}, or the reader's Stop. Null otherwise — a
   * run of failures is told by its failures.
   */
  cutShort: 'refused' | 'reader' | null
}

interface TellArchiveHooks {
  onProgress?: (progress: ChangeImportProgress) => void
  /** Records what is still owed, each time a work leaves the list of what is. */
  onOwed: (owed: ArchiveAct[]) => Promise<void>
  signal?: AbortSignal
}

/** What asking for one work came to: whether an AO3 tab made the request, or the error it ended in. */
type Attempt = { viaTab: boolean } | { error: unknown }

/** The 429 an attempt ended in, and what it said about waiting; null for any other answer. */
function refusalOf(attempt: Attempt): ArchiveRefusal | null {
  return 'error' in attempt && attempt.error instanceof MarkRequestError && attempt.error.status === 429
    ? { retryAfter: attempt.error.retryAfter }
    : null
}

/**
 * Take each work off the reader's Marked for Later list on AO3, one at a time.
 *
 * Sequential rather than pooled, and paced like any bulk run of requests to
 * AO3: a queue of one is the politest shape there is. A 429 is waited out and
 * the same work asked again; one that outlasts {@link REFUSAL_PATIENCE} stops
 * the run, and so does a run of failures — see {@link ARCHIVE_GIVE_UP} — and
 * the reader's Stop, which is heard between works and during any wait.
 *
 * The run *learns*: once an AO3 tab has done what this page could not, every
 * work after it goes the same way. The direct request having been refused once
 * is enough to know it will be refused again, and re-proving that per work would
 * double the requests AO3 sees for no benefit to anyone.
 */
async function tellArchive(acts: ArchiveAct[], hooks: TellArchiveHooks): Promise<ArchiveOutcome> {
  const sent: ArchiveAct[] = []
  const failed: ArchiveOutcome['failed'] = []
  let consecutive = 0
  let viaTab = 0
  /** Set once a tab has succeeded where this page was refused. */
  let delegating = false

  let progress: ChangeImportProgress = { step: 'archive', done: 0, total: acts.length, waitingUntil: null, waitReason: null }
  const report = (next: Partial<ChangeImportProgress>): void => {
    progress = { ...progress, ...next }
    hooks.onProgress?.(progress)
  }
  const stop = (position: number, cutShort: ArchiveOutcome['cutShort']): ArchiveOutcome => ({ sent, failed, held: acts.slice(position), viaTab, cutShort })
  const { signal } = hooks

  report({})
  const unwatch = onArchiveWait((until, reason) => report({ waitingUntil: until || null, waitReason: until ? reason : null }))
  try {
    for (const [position, act] of acts.entries()) {
      if (signal?.aborted)
        return stop(position, 'reader')
      let attempt: Attempt
      try {
        attempt = await askWithRetry<Attempt>(
          () => takeOffList(act.workId, delegating).then(byTab => ({ viaTab: byTab }), (error: unknown) => ({ error })),
          refusalOf,
          signal,
          REFUSAL_PATIENCE,
        )
      }
      catch (error) {
        if (signal?.aborted)
          return stop(position, 'reader')
        throw error
      }
      if (refusalOf(attempt))
        return stop(position, signal?.aborted ? 'reader' : 'refused')

      if ('error' in attempt) {
        failed.push({ act, reason: attempt.error instanceof Error ? attempt.error.message : String(attempt.error) })
        report({ done: position + 1 })
        if (++consecutive >= ARCHIVE_GIVE_UP)
          return stop(position + 1, null)
        continue
      }

      if (attempt.viaTab) {
        delegating = true
        viaTab++
      }
      sent.push(act)
      consecutive = 0
      await hooks.onOwed([...failed.map(entry => entry.act), ...acts.slice(position + 1)])
      report({ done: position + 1 })
    }
    return stop(acts.length, null)
  }
  finally {
    unwatch()
  }
}

/**
 * One work off the list, and whether an AO3 tab is what did it.
 *
 * Throws what the reader is told, so the message on the way out has to be one
 * they can act on — which is why {@link file://./../markForLater.ts} words its
 * "no tab" cases as instructions rather than as diagnoses.
 */
async function takeOffList(workId: string, delegating: boolean): Promise<boolean> {
  if (delegating) {
    await submitMarkViaTab(workId, false)
    return true
  }
  try {
    await submitMark(workId, false)
    return false
  }
  catch (error) {
    if (!worthDelegating(error))
      throw error
    if (!(error instanceof MarkRequestError) && !await archiveAnswers())
      throw new Error(ARCHIVE_UNAVAILABLE)
    await submitMarkViaTab(workId, false)
    return true
  }
}

/**
 * Whether a failed request is the kind a different origin could get past.
 *
 * Two answers are the archive talking about the *request rate* or about itself
 * rather than about who asked — a 429 and a 5xx — and re-asking through a tab
 * would only be the same request again from a machine AO3 has already told to
 * wait. Everything else is worth one more try from a page that is genuinely on
 * AO3: a refusal it can explain (403, 422) because the POST arrived without an
 * `Origin`, and a request that never got an answer at all, which is what an
 * extension origin losing its privilege would look like from in here — unless
 * AO3 is answering nobody, which {@link takeOffList} asks before it delegates.
 *
 * The third is {@link NOT_SIGNED_IN}, and it is not worth delegating either:
 * every AO3 tab in this browser shares the session that isn't there, so asking
 * one would spend a tab to be told the same thing.
 */
function worthDelegating(error: unknown): boolean {
  if (error instanceof MarkRequestError)
    return error.status !== 429 && error.status !== NOT_SIGNED_IN && error.status < 500
  return true
}
