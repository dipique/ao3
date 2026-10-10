import type { WaitReason } from '../../content_script/archiveFetch.ts'
import type { ExportJobError, ExportJobPhase, JobStatus } from '../../content_script/siteExport/job.ts'
import type { Severity } from './severity.ts'

import { countdown, WAIT_WORDS } from '../../content_script/archiveFetch.ts'
import { sentence } from './phrases.ts'

/**
 * The site export's job, as the options page shows it: which list it is on,
 * what it is doing, how far it has got, and why it stopped. The runner reports
 * facts (running or not, a deadline, the steps left); this turns them into the
 * one state a reader sees, and says why the job keeps any other control off.
 */

/**
 * What the job is doing, as a reader would put it. `waiting` is a running job
 * sitting out a pause in requests to AO3; `stopped` left steps to continue, or
 * an error; `finished` ran out of things to do.
 */
export type JobState = 'idle' | 'running' | 'waiting' | 'stopped' | 'finished'

export interface JobView {
  /** The stored list the job is on, or null with no job. */
  key: string | null
  /** That list's name. */
  name: string
  /** The step it is on, or null once there are none left. */
  phase: ExportJobPhase | null
  /** The job in a phrase, "Caching Marked for Later": what its progress bar is called. */
  label: string
  state: JobState
  /** While waiting: whether AO3 refused us, or we are pacing ourselves. */
  wait?: WaitReason
  /** While waiting: the time the pause has left. */
  countdown?: string
  done: number
  total: number
  /** What the job line says. */
  line: string
  /** The line's severity; none while running, which is drawn in the brand colour. */
  severity?: Severity
  /** Why it stopped short, when something stopped it. */
  error?: string
  /** What didn't stop it, but is worth saying. */
  warnings: string[]
  /** The works it couldn't fetch that it kept, and how many more it counted. */
  failures: { shown: ExportJobError[], more: number }
}

/**
 * What each phase is called when it names a job that is doing it. A
 * Download's last stage is said as downloading, as the button that started it
 * says.
 */
const PHASE_WORDS: Readonly<Record<ExportJobPhase, string>> = { refreshing: 'refreshing', caching: 'caching', exporting: 'downloading' }

/** What the job is doing, in the word that names it: its phase, or "working" for a phase not yet known. */
export function jobVerb(view: Pick<JobView, 'phase'>): string {
  return view.phase ? PHASE_WORDS[view.phase] : 'working'
}

/** The job, from the runner's status. `names` gives a stored list's name by its key, or `''`; `now` drives the countdown. */
export function jobView(status: JobStatus, names: (key: string) => string, now: number): JobView {
  const { job } = status
  if (!job)
    return { key: null, name: '', phase: null, label: '', state: 'idle', done: 0, total: 0, line: '', warnings: [], failures: { shown: [], more: 0 } }

  const name = names(job.cacheKey) || job.descriptor?.label || job.cacheKey
  const phase = job.steps[0] ?? null
  const view: JobView = {
    key: job.cacheKey,
    name,
    phase,
    label: sentence(`${jobVerb({ phase })} ${name}`),
    state: 'running',
    done: job.done,
    total: job.total,
    line: status.message || 'Working…',
    warnings: status.warnings,
    failures: { shown: job.errors, more: Math.max(0, job.errorCount - job.errors.length) },
  }
  if (status.error)
    view.error = status.error

  if (status.running) {
    const left = (status.waitingUntil ?? 0) - now
    if (left > 0 && status.waitReason) {
      view.state = 'waiting'
      view.wait = status.waitReason
      view.countdown = countdown(left)
      view.line = WAIT_WORDS[status.waitReason]
      view.severity = status.waitReason === 'refused' ? 'warning' : 'neutral'
    }
    return view
  }

  if (job.steps.length || status.error) {
    view.state = 'stopped'
    view.line = 'Stopped'
    view.severity = status.error ? 'destructive' : 'neutral'
  }
  else {
    view.state = 'finished'
    view.line = 'Finished'
    view.severity = 'success'
  }
  return view
}

/** Whether the job is running now, sitting out a pause included. */
export function isRunning(view: JobView): boolean {
  return view.state === 'running' || view.state === 'waiting'
}

/**
 * What a list is stored as, for the functions below: one stored list's key, or
 * the keys of every copy at a saved list's address. One search stored in
 * several sort orders is one list, and a job on any of its copies is its own.
 */
export type ListKeys = string | readonly string[]

/** Whether the job is on the list `keys` names. */
export function jobIsOn(view: JobView, keys: ListKeys): boolean {
  return view.key !== null && (typeof keys === 'string' ? keys === view.key : keys.includes(view.key))
}

/**
 * Why a running job keeps one list's offline actions (refresh, cache,
 * download) off, or null: there is one job at a time, so every other list
 * names the list that holds it and what it is doing, and the list it is on is
 * busy itself. Worded to follow the control's name after a dash.
 */
export function offReason(view: JobView, keys: ListKeys): string | null {
  if (!isRunning(view))
    return null
  const verb = jobVerb(view)
  return jobIsOn(view, keys)
    ? `off while this list is ${verb}`
    : `off for now: one job at a time, and ${view.name} is ${verb}`
}

/** What a list offers in place of its own offline actions while its job runs, Stop, or is stopped, Continue or Discard. */
export type JobActions = 'offline' | 'stop' | 'resume'

/**
 * The job as one list's offline controls see it: which of them the list
 * shows, why its actions are off, and whether the job's line is its own. A
 * finished job leaves its line, and the actions come back.
 */
export function listJob(view: JobView, keys: ListKeys): { actions: JobActions, off: string | null, here: boolean } {
  const mine = jobIsOn(view, keys)
  const actions: JobActions = mine && isRunning(view) ? 'stop' : mine && view.state === 'stopped' ? 'resume' : 'offline'
  return { actions, off: actions === 'offline' ? offReason(view, keys) : null, here: mine && view.state !== 'idle' }
}

/** Why removing a list's copies is off, or null: only its own job, which is reading and writing one of them, stops it. */
export function removeOff(view: JobView, keys: ListKeys): string | null {
  return jobIsOn(view, keys) ? offReason(view, keys) : null
}

/** Why deleting cached work text is off, or null: a running job is writing it. */
export function cachedTextOff(view: JobView): string | null {
  return isRunning(view) ? `off while ${view.name} is ${jobVerb(view)}` : null
}

/**
 * The running job, for the header of the saved lists, every one of whose
 * offline actions it turns off: whose it is, and what it is doing. Null while
 * none runs.
 */
export function busyNotice(view: JobView): string | null {
  return isRunning(view) ? `One job at a time — ${view.name} is ${jobVerb(view)}` : null
}

/** The running job, for the rail: how far it has got, and what it is. Null while none runs. */
export function railJob(view: JobView): { text: string, title: string } | null {
  if (!isRunning(view))
    return null
  return {
    text: view.total ? `${view.done.toLocaleString()}/${view.total.toLocaleString()}` : '',
    title: `A job is running: ${jobVerb(view)} ${view.name}`,
  }
}
