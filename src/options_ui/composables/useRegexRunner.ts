import { REGEX_TIME_BUDGET_MS } from '#common'

import type { RegexEnd, RegexJob, RunnerEffect, RunnerEvent } from '../model/regexCheck.ts'

import { RUNNER_IDLE, runnerStep } from '../model/regexCheck.ts'

/**
 * Runs patterns over names in a worker of its own, under the time budget
 * ({@link REGEX_TIME_BUDGET_MS}), for as long as the calling scope lives. What
 * it does when is {@link runnerStep}; this holds the worker and the timer, and
 * does it. `ended` is how the newest job asked for ended, once it has.
 */
export function useRegexRunner() {
  let state = RUNNER_IDLE
  let worker: Worker | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let jobs = 0
  const ended = shallowRef<RegexEnd | null>(null)

  function start(): Worker {
    const started = new Worker(new URL('../regexWorker.ts', import.meta.url))
    started.addEventListener('message', ({ data }: MessageEvent<RunnerEvent>) => dispatch(data))
    started.addEventListener('error', (event) => {
      console.error('[rule editor] The worker testing a pattern failed:', event.message)
      dispatch({ kind: 'error' })
    })
    return started
  }

  function stop() {
    clearTimeout(timer)
    worker?.terminate()
    worker = null
  }

  function apply(effect: RunnerEffect) {
    switch (effect.kind) {
      case 'post':
        worker ??= start()
        worker.postMessage({ id: effect.id, ...effect.job })
        break
      case 'time':
        clearTimeout(timer)
        if (effect.id !== null)
          timer = setTimeout(dispatch, REGEX_TIME_BUDGET_MS, { kind: 'timeout', id: effect.id })
        break
      case 'stop':
        stop()
        break
      case 'end':
        ended.value = effect.end
        break
    }
  }

  function dispatch(event: RunnerEvent) {
    const next = runnerStep(state, event)
    state = next.state
    next.effects.forEach(apply)
  }

  onScopeDispose(() => {
    state = RUNNER_IDLE
    stop()
  })

  return {
    ended: computed(() => ended.value),
    /** Start the worker ahead of the first job, so that job doesn't wait for it to load. */
    warm() {
      worker ??= start()
    },
    run(job: RegexJob) {
      dispatch({ kind: 'run', id: ++jobs, job })
    },
    /** Want nothing more, and forget how the last job ended. */
    cancel() {
      dispatch({ kind: 'cancel' })
    },
  }
}
