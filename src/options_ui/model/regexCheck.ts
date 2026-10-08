/**
 * Running a rule's regex pattern where it can be stopped. A pattern that
 * backtracks catastrophically can't be interrupted on the page's own thread, so
 * the rule editor runs every pattern in a worker and ends the worker once the
 * pattern has run past its time budget. What the worker computes is
 * {@link matchSpans}; when to hand it a job, time it and stop it is
 * {@link runnerStep}, which takes the runner's state and returns the next.
 */

/** The flags a rule's regex runs under, which the engine names when it refuses a pattern. */
const RULE_REGEX_FLAGS = 'i'

/**
 * Why the engine refuses a pattern. V8 starts its message by repeating the
 * pattern ("Invalid regular expression: /(/i: Unterminated group"), and
 * SpiderMonkey's starts in lower case ("unterminated parenthetical").
 */
function refusal(pattern: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const preamble = `Invalid regular expression: /${pattern}/${RULE_REGEX_FLAGS}: `
  const reason = message.startsWith(preamble) ? message.slice(preamble.length) : message
  return reason.charAt(0).toUpperCase() + reason.slice(1)
}

/** The pattern compiled as a rule compiles it, or the engine's reason for refusing it. */
export function compilePattern(pattern: string): RegExp | string {
  try {
    return new RegExp(pattern, RULE_REGEX_FLAGS)
  }
  catch (error) {
    return refusal(pattern, error)
  }
}

/** Where a pattern's first match lies in a name: its start and its end. */
export type Span = readonly [start: number, end: number]

/**
 * Each subject's first match, the pattern compiled as a rule compiles it: two
 * numbers a subject, its start and its end, or -1 and -1 for none. A pattern
 * the engine refuses matches nothing, as a live rule's does.
 */
export function matchSpans(pattern: string, subjects: readonly string[]): Int32Array {
  const spans = new Int32Array(subjects.length * 2).fill(-1)
  const regex = compilePattern(pattern)
  if (typeof regex === 'string')
    return spans
  subjects.forEach((subject, i) => {
    const match = regex.exec(subject)
    if (match) {
      spans[2 * i] = match.index
      spans[2 * i + 1] = match.index + match[0].length
    }
  })
  return spans
}

/** A pattern to run over names, and time. */
export interface RegexJob {
  pattern: string
  subjects: readonly string[]
}

/**
 * Whether two jobs run the same pattern over the same names. The names are
 * known by their list, which is made again only when they change, so a list
 * equal to another but made apart is another job.
 */
export function sameJob(a: RegexJob | null, b: RegexJob | null): boolean {
  return a === b || (!!a && !!b && a.pattern === b.pattern && a.subjects === b.subjects)
}

/** How a job ended: each subject's match, or stopped for running past the budget. */
export type RegexEnd
  = | { kind: 'done', job: RegexJob, matches: ReadonlyMap<string, Span | null> }
    | { kind: 'slow', job: RegexJob }

/** A job that ran to the end, with each subject's match from the worker's {@link matchSpans}. */
export function ended(job: RegexJob, spans: Int32Array): RegexEnd {
  const matches = new Map<string, Span | null>()
  job.subjects.forEach((subject, i) => {
    const start = spans[2 * i]!
    matches.set(subject, start === -1 ? null : [start, spans[2 * i + 1]!])
  })
  return { kind: 'done', job, matches }
}

/**
 * Where the check of a pattern stands: nothing to run; under way, beside how
 * the last job ended; or ended.
 */
export type RegexRun = { kind: 'idle' } | { kind: 'running', last: RegexEnd | null } | RegexEnd

export const IDLE_RUN: RegexRun = { kind: 'idle' }

/**
 * The run of `job` (`'loading'` while the names it runs over load), given how
 * the latest job ended.
 */
export function runOf(job: RegexJob | 'loading' | null, last: RegexEnd | null): RegexRun {
  if (job === null)
    return IDLE_RUN
  if (job !== 'loading' && last && sameJob(last.job, job))
    return last
  return { kind: 'running', last }
}

interface Posted {
  id: number
  job: RegexJob
}

/**
 * The runner: the job the worker has, the newest job waiting for it to be
 * free, and the job whose end is wanted (the newest asked for).
 */
export interface RunnerState {
  running: Posted | null
  waiting: Posted | null
  wanted: number | null
}

export const RUNNER_IDLE: RunnerState = { running: null, waiting: null, wanted: null }

/**
 * What the runner is told: a job to run; that nothing is wanted any more; and,
 * from the worker, that it began a job or finished one, or failed; and from
 * the job's timer, that its budget ran out.
 */
export type RunnerEvent
  = | { kind: 'run', id: number, job: RegexJob }
    | { kind: 'cancel' }
    | { kind: 'started', id: number }
    | { kind: 'done', id: number, spans: Int32Array }
    | { kind: 'timeout', id: number }
    | { kind: 'error' }

/**
 * What the runner does: hand the worker a job; time the job the worker began
 * (or, for `null`, stop timing); stop the worker, so the next job goes to a new
 * one; and say how the wanted job ended (`null`: nothing is wanted).
 */
export type RunnerEffect
  = | { kind: 'post', id: number, job: RegexJob }
    | { kind: 'time', id: number | null }
    | { kind: 'stop' }
    | { kind: 'end', end: RegexEnd | null }

/**
 * The runner's next state and what it does, given an event. A job asked for
 * while another runs waits for it, in place of any already waiting: the worker
 * can't be stopped short of ending it, and a job that will finish in a moment
 * isn't worth a new worker. The one running then ends unseen, unless it runs
 * past the budget, when it is stopped as any other. A job is timed from when
 * the worker says it began it, so a worker slow to start takes nothing from
 * its budget.
 */
export function runnerStep(state: RunnerState, event: RunnerEvent): { state: RunnerState, effects: RunnerEffect[] } {
  switch (event.kind) {
    case 'run': {
      const posted = { id: event.id, job: event.job }
      if (state.running)
        return { state: { ...state, waiting: posted, wanted: posted.id }, effects: [] }
      return { state: { running: posted, waiting: null, wanted: posted.id }, effects: [{ kind: 'post', ...posted }] }
    }
    case 'cancel':
      return { state: { ...state, waiting: null, wanted: null }, effects: [{ kind: 'end', end: null }] }
    case 'started':
      return { state, effects: event.id === state.running?.id ? [{ kind: 'time', id: event.id }] : [] }
    case 'done':
    case 'timeout':
    case 'error': {
      const running = state.running
      if (!running || ('id' in event && event.id !== running.id))
        return { state, effects: [] }
      const finished = event.kind === 'done'
      const effects: RunnerEffect[] = [finished ? { kind: 'time', id: null } : { kind: 'stop' }]
      if (running.id === state.wanted)
        effects.push({ kind: 'end', end: finished ? ended(running.job, event.spans) : { kind: 'slow', job: running.job } })
      if (state.waiting)
        effects.push({ kind: 'post', ...state.waiting })
      return { state: { running: state.waiting, waiting: null, wanted: state.wanted }, effects }
    }
  }
}
