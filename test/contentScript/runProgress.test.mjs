import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { NO_RUNS, runAsked, runFinished, runProgressMarks, runStarted } from '../../src/content_script/runProgress.ts'

describe('runProgress', () => {
  test('busy from the start, since the first run is asked for as the script loads, until it finishes', () => {
    assert.deepEqual(runProgressMarks(NO_RUNS), { runs: null, busy: true })
    const started = runStarted(NO_RUNS)
    assert.deepEqual(runProgressMarks(started), { runs: null, busy: true })
    assert.deepEqual(runProgressMarks(runFinished(started)), { runs: '1', busy: false })
  })

  test('an options change asks for a run, which is busy until that run has finished', () => {
    const first = runFinished(runStarted(NO_RUNS))
    const asked = runAsked(first)
    assert.deepEqual(runProgressMarks(asked), { runs: '1', busy: true })
    const second = runStarted(asked)
    assert.deepEqual(runProgressMarks(second), { runs: '1', busy: true })
    assert.deepEqual(runProgressMarks(runFinished(second)), { runs: '2', busy: false })
  })

  test('a change during a run asks for another: finishing the first leaves the page busy', () => {
    const during = runAsked(runStarted(NO_RUNS))
    const first = runFinished(during)
    assert.deepEqual(runProgressMarks(first), { runs: '1', busy: true })
    assert.deepEqual(runProgressMarks(runFinished(runStarted(first))), { runs: '2', busy: false })
  })

  test('runs that overlap: busy until the last of them finishes', () => {
    const both = runStarted(runAsked(runStarted(NO_RUNS)))
    const one = runFinished(both)
    assert.deepEqual(runProgressMarks(one), { runs: '1', busy: true })
    assert.deepEqual(runProgressMarks(runFinished(one)), { runs: '2', busy: false })
  })

  test('each step leaves the progress it was given as it was', () => {
    const progress = Object.freeze({ ...NO_RUNS })
    for (const step of [runAsked, runStarted, runFinished])
      step(progress)
    assert.deepEqual(progress, NO_RUNS)
  })
})
