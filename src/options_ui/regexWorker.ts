import type { RegexJob, RunnerEvent } from './model/regexCheck.ts'

import { matchSpans } from './model/regexCheck.ts'

/*
  Runs a rule's pattern over names off the page's thread, where a pattern that
  backtracks for too long is stopped by ending the worker. It says when it
  begins each job, so the job's time is counted from then.
*/
addEventListener('message', ({ data }: MessageEvent<RegexJob & { id: number }>) => {
  const started: RunnerEvent = { kind: 'started', id: data.id }
  postMessage(started)
  const spans = matchSpans(data.pattern, data.subjects)
  const done: RunnerEvent = { kind: 'done', id: data.id, spans }
  postMessage(done, { transfer: [spans.buffer] })
})
