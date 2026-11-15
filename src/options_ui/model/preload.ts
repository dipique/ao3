import type { ListRead } from '../../common/trackedReads.ts'
import type { JobView } from './jobView.ts'

import { MAX_REQUEST_ATTEMPTS } from '../../common/trackedReads.ts'
import { isRunning, JOB_LINE } from './jobView.ts'
import { sentence, titlesInWords } from './phrases.ts'

/**
 * Pre-load, as the options page shows it: This review's line sums the run up,
 * and each tracked list's row under Saved lists says how its own read is going
 * in the line a refresh draws there — the page it is on, a pause in requests,
 * a failed try and the next, or why it was given up on.
 */

/** Every tracked list's read, by id, as the reader last said. */
export type Reads = Readonly<Record<string, ListRead>>

/** A count and the noun it counts. */
function counted(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

/** The page being read: the one after those read, out of how many the list has once its first page says. */
export function readingLine(read: ListRead): string {
  return `Reading page ${read.page + 1}${read.of ? ` of ${read.of}` : ''}…`
}

/** What went wrong with a request, for a reader: AO3's status where it gave one, else the error less the address it asked. */
function trouble(error: string | undefined): string {
  if (!error)
    return ''
  const status = /\bstatus (\d{3})\b/i.exec(error)?.[1]
  return status ? `AO3 answered with error ${status}` : error.replace(/:?\s*https?:\/\/\S+/g, '').trim()
}

/** A try of a page that failed, and what went wrong; without a countdown to say when, that it is tried again. */
export function retryLine(read: ListRead, counting: boolean): string {
  const why = trouble(read.error)
  const failed = `Page ${read.page + 1} didn’t load (try ${read.attempt ?? 1} of ${MAX_REQUEST_ATTEMPTS})${why ? `: ${why}` : ''}`
  return counting ? failed : `${failed} — trying again…`
}

/** A list partway read, while a list read less far goes first. */
export function waitingTurnLine(read: ListRead): string {
  const pages = read.of ? `${read.page} of ${counted(read.of, 'page', 'pages')}` : counted(read.page, 'page', 'pages')
  return `${pages} read · waiting its turn`
}

/** What a row says of a list given up on, over the reason. */
export const FAILED_LINE = 'Couldn’t read this list'

/** Why a list was given up on. */
export function readFailure(read: ListRead): string {
  switch (read.failure) {
    case 'signed-out':
      return 'AO3 answered as though you were signed out, so nothing was kept. Sign in to AO3, then pre-load again.'
    case 'not-archive':
      return 'Its address isn’t a page on AO3, so it can’t be read.'
    default: {
      const why = trouble(read.error)
      return `All ${MAX_REQUEST_ATTEMPTS} tries failed${why ? ` (${why})` : ''}. The next Pre-load tries it again.`
    }
  }
}

/**
 * What the row of a list being pre-loaded draws under it, as a refresh's line,
 * or null with nothing to say: before the list is reached, once it is read to
 * its end, and, once the run stops, for all but a list given up on, which says
 * why until the job is put away.
 */
export function listReadView(read: ListRead | undefined, job: JobView): JobView | null {
  if (!read || job.state === 'idle')
    return null
  const base: JobView = {
    key: job.key,
    name: read.name,
    phase: 'refreshing',
    label: sentence(`reading ${read.name}`),
    state: 'running',
    done: read.page,
    total: read.of,
    line: '',
    warnings: [],
    failures: { shown: [], more: 0 },
  }
  if (read.phase === 'failed')
    return { ...base, state: 'stopped', severity: 'destructive', line: FAILED_LINE, error: readFailure(read) }
  if (!isRunning(job))
    return null
  const counting = job.state === 'waiting' && job.countdown ? { wait: job.wait, countdown: job.countdown } : null
  if (read.phase === 'reading') {
    return counting
      ? { ...base, ...counting, state: 'waiting', line: job.line, severity: job.severity }
      : { ...base, line: readingLine(read) }
  }
  if (read.phase === 'retrying')
    return { ...base, ...counting, severity: 'warning', line: retryLine(read, !!counting) }
  if (read.phase === 'queued' && read.page)
    return { ...base, severity: 'neutral', line: waitingTurnLine(read) }
  return null
}

/** Where Pre-load is, for This review's line. */
export type PreloadState = 'running' | 'paused' | 'stopped' | 'finished'

/**
 * This review's line for Pre-load: while it runs, the list being read or
 * retried; stopped, how far it got; finished, how many lists were read. Each
 * says how many failed, when any did.
 */
export function preloadLine(reads: Reads, state: PreloadState): string {
  const all = Object.values(reads)
  const read = all.filter(one => one.phase === 'done').length
  const failed = all.filter(one => one.phase === 'failed').length
  const failures = failed ? ` · ${failed.toLocaleString()} failed` : ''
  const lists = counted(all.length, 'list', 'lists')
  if (state === 'running') {
    const current = all.find(one => one.phase === 'reading' || one.phase === 'retrying')
    const doing = current ? `${current.phase === 'retrying' ? 'Retrying' : 'Reading'} “${current.name}”` : 'Reading your tracked lists'
    return `${doing}${failures}`
  }
  if (state === 'finished')
    return `${failed ? `Read ${read.toLocaleString()} of ${lists}` : `Read all ${lists}`}${failures}`
  return `${state === 'paused' ? JOB_LINE.paused : JOB_LINE.stopped} · ${read.toLocaleString()} of ${lists} read${failures}`
}

/** The lists given up on, by name, and where to look for why; null with none. */
export function failedNote(reads: Reads): string | null {
  const failed = Object.values(reads).filter(one => one.phase === 'failed').map(one => one.name)
  if (!failed.length)
    return null
  return `Couldn’t read ${titlesInWords(failed)}. ${failed.length === 1 ? 'Its row' : 'Their rows'} under Saved lists ${failed.length === 1 ? 'says' : 'say'} why.`
}

/** The job as the page shows it, with Pre-load's lines while the job is Pre-load (`reads`, as the reader last said). */
export function withReads(view: JobView, reads: Reads | null | undefined): JobView {
  if (!reads || view.state === 'idle')
    return view
  const note = failedNote(reads)
  const next: JobView = { ...view, warnings: note ? [note, ...view.warnings] : view.warnings }
  if (view.state === 'running') {
    next.line = preloadLine(reads, 'running')
  }
  else if (view.state === 'stopped') {
    next.line = preloadLine(reads, view.error ? 'stopped' : 'paused')
  }
  else if (view.state === 'finished') {
    next.line = preloadLine(reads, 'finished')
    next.severity = note ? 'warning' : 'success'
  }
  return next
}
