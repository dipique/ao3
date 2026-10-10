import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { ruleValueMatches } from '../../src/common/data.ts'
import { compilePattern, ended, IDLE_RUN, matchSpans, RUNNER_IDLE, runnerStep, runOf, sameJob } from '../../src/options_ui/model/regexCheck.ts'

/** The spans `matchSpans` packs, one `[start, end]` or null per subject. */
const unpacked = spans => Array.from({ length: spans.length / 2 }, (_, i) => (spans[2 * i] === -1 ? null : [spans[2 * i], spans[2 * i + 1]]))

describe('compilePattern', () => {
  test('compiles a pattern as a rule does, ignoring case', () => {
    const regex = compilePattern('^slow')
    assert.ok(regex instanceof RegExp)
    assert.equal(regex.flags, 'i')
  })

  test('gives the engine\'s reason for a pattern it refuses', () => {
    assert.equal(compilePattern('(slow'), 'Unterminated group')
  })
})

describe('matchSpans', () => {
  test('finds each subject\'s first match, as a live rule finds whether there is one', () => {
    const subjects = ['Slow Burn', 'slow burn', 'Burning Slowly', 'Omega Verse', '']
    for (const pattern of ['^slow', 'burn$', 'Slow\\S*Burn', 'Slow\\s*Burn', 'omega\\S+verse', '\\bl', '\\Bl', '^$']) {
      const spans = unpacked(matchSpans(pattern, subjects))
      for (const [i, subject] of subjects.entries())
        assert.equal(spans[i] !== null, ruleValueMatches({ value: pattern, matcher: 'regex' }, subject), `${pattern} on ${JSON.stringify(subject)}`)
    }
  })

  test('says where the first match starts and ends', () => {
    assert.deepEqual(unpacked(matchSpans('burn', ['Slow Burn', 'Fluff', 'burn, burn'])), [[5, 9], null, [0, 4]])
  })

  test('a match of nothing is a match', () => {
    assert.deepEqual(unpacked(matchSpans('^', ['Fluff'])), [[0, 0]])
  })

  test('a pattern the engine refuses matches nothing, as a live rule\'s does', () => {
    assert.deepEqual(unpacked(matchSpans('(slow', ['slow'])), [null])
  })
})

describe('sameJob', () => {
  const subjects = ['Slow Burn']

  test('is the same pattern over the same list of names', () => {
    assert.equal(sameJob({ pattern: 'a', subjects }, { pattern: 'a', subjects }), true)
    assert.equal(sameJob({ pattern: 'a', subjects }, { pattern: 'b', subjects }), false)
  })

  test('an equal list made again is another job: the names are known by their list', () => {
    assert.equal(sameJob({ pattern: 'a', subjects }, { pattern: 'a', subjects: [...subjects] }), false)
  })

  test('no job is only ever the same as no job', () => {
    assert.equal(sameJob(null, null), true)
    assert.equal(sameJob(null, { pattern: 'a', subjects }), false)
    assert.equal(sameJob({ pattern: 'a', subjects }, null), false)
  })
})

describe('ended', () => {
  test('holds each subject\'s match by the subject', () => {
    const job = { pattern: 'burn', subjects: ['Slow Burn', 'Fluff'] }
    const end = ended(job, matchSpans(job.pattern, job.subjects))
    assert.equal(end.kind, 'done')
    assert.equal(end.job, job)
    assert.deepEqual([...end.matches], [['Slow Burn', [5, 9]], ['Fluff', null]])
  })
})

describe('runOf', () => {
  const job = { pattern: 'burn', subjects: ['Slow Burn'] }
  const done = ended(job, matchSpans(job.pattern, job.subjects))
  const other = ended({ pattern: 'fluff', subjects: job.subjects }, matchSpans('fluff', job.subjects))

  test('with nothing to run, is idle', () => {
    assert.deepEqual(runOf(null, done), IDLE_RUN)
  })

  test('is how its job ended, once it has', () => {
    assert.equal(runOf(job, done), done)
    const slow = { kind: 'slow', job }
    assert.equal(runOf(job, slow), slow)
  })

  test('is under way until its own job ends, keeping how the last one ended', () => {
    assert.deepEqual(runOf(job, other), { kind: 'running', last: other })
    assert.deepEqual(runOf(job, null), { kind: 'running', last: null })
  })

  test('is under way while the names it runs over load', () => {
    assert.deepEqual(runOf('loading', other), { kind: 'running', last: other })
  })
})

describe('runnerStep', () => {
  const job = (pattern, subjects = ['aaaa!']) => ({ pattern, subjects })
  const first = job('(a+)+$')
  const second = job('^a+!$')
  const third = job('^a')

  /** Each event in turn from `state`: the state after them, and every effect they had, in order. */
  const steps = (events, state = RUNNER_IDLE) => {
    const effects = []
    for (const event of events) {
      const next = runnerStep(state, event)
      state = next.state
      effects.push(...next.effects)
    }
    return { state, effects }
  }
  const spans = pattern => matchSpans(pattern, ['aaaa!'])

  test('a job is handed to the worker at once when none runs, and timed from when the worker begins it', () => {
    const posted = steps([{ kind: 'run', id: 1, job: first }])
    assert.deepEqual(posted.effects, [{ kind: 'post', id: 1, job: first }])
    assert.deepEqual(steps([{ kind: 'started', id: 1 }], posted.state).effects, [{ kind: 'time', id: 1 }])
  })

  test('a job that ends in time gives its matches, and its timing stops', () => {
    const { effects, state } = steps([{ kind: 'run', id: 1, job: second }, { kind: 'started', id: 1 }, { kind: 'done', id: 1, spans: spans(second.pattern) }])
    assert.deepEqual(effects.slice(2), [{ kind: 'time', id: null }, { kind: 'end', end: ended(second, spans(second.pattern)) }])
    assert.equal(state.running, null)
  })

  test('a job that runs past the budget stops the worker and ends too slow', () => {
    const { effects, state } = steps([{ kind: 'run', id: 1, job: first }, { kind: 'started', id: 1 }, { kind: 'timeout', id: 1 }])
    assert.deepEqual(effects.slice(2), [{ kind: 'stop' }, { kind: 'end', end: { kind: 'slow', job: first } }])
    assert.equal(state.running, null)
  })

  test('the worker failing ends its job as one running past the budget would', () => {
    const { effects } = steps([{ kind: 'run', id: 1, job: first }, { kind: 'started', id: 1 }, { kind: 'error' }])
    assert.deepEqual(effects.slice(2), [{ kind: 'stop' }, { kind: 'end', end: { kind: 'slow', job: first } }])
  })

  test('a worker that fails with no job running is stopped all the same, so the next job goes to a new one', () => {
    const idle = steps([{ kind: 'error' }])
    assert.deepEqual(idle.effects, [{ kind: 'stop' }])
    assert.deepEqual(steps([{ kind: 'run', id: 1, job: second }], idle.state).effects, [{ kind: 'post', id: 1, job: second }])
    const between = steps([{ kind: 'run', id: 1, job: second }, { kind: 'started', id: 1 }, { kind: 'done', id: 1, spans: spans(second.pattern) }, { kind: 'error' }])
    assert.deepEqual(between.effects.at(-1), { kind: 'stop' })
  })

  test('a newer job waits for the one running, and replaces any already waiting', () => {
    const { effects, state } = steps([{ kind: 'run', id: 1, job: first }, { kind: 'run', id: 2, job: second }, { kind: 'run', id: 3, job: third }])
    assert.deepEqual(effects, [{ kind: 'post', id: 1, job: first }])
    assert.deepEqual(state.waiting, { id: 3, job: third })
  })

  test('a job replaced while it runs ends unseen, and the newest is handed over next', () => {
    const { effects } = steps([
      { kind: 'run', id: 1, job: second },
      { kind: 'started', id: 1 },
      { kind: 'run', id: 2, job: third },
      { kind: 'done', id: 1, spans: spans(second.pattern) },
    ])
    assert.deepEqual(effects.slice(2), [{ kind: 'time', id: null }, { kind: 'post', id: 2, job: third }])
  })

  test('a replaced job that runs past the budget is stopped all the same, and the newest goes to a new worker', () => {
    const { effects, state } = steps([
      { kind: 'run', id: 1, job: first },
      { kind: 'started', id: 1 },
      { kind: 'run', id: 2, job: second },
      { kind: 'timeout', id: 1 },
    ])
    assert.deepEqual(effects.slice(2), [{ kind: 'stop' }, { kind: 'post', id: 2, job: second }])
    assert.deepEqual(state.running, { id: 2, job: second })
  })

  test('word of a job no longer running changes nothing', () => {
    const { state } = steps([{ kind: 'run', id: 1, job: second }, { kind: 'started', id: 1 }, { kind: 'done', id: 1, spans: spans(second.pattern) }, { kind: 'run', id: 2, job: third }])
    for (const event of [{ kind: 'timeout', id: 1 }, { kind: 'done', id: 1, spans: spans(second.pattern) }, { kind: 'started', id: 1 }])
      assert.deepEqual(runnerStep(state, event), { state, effects: [] }, event.kind)
  })

  test('cancelling wants nothing more: a job waiting is dropped, the one running ends unseen, and how the last ended is forgotten', () => {
    const cancelled = steps([{ kind: 'run', id: 1, job: second }, { kind: 'run', id: 2, job: third }, { kind: 'cancel' }])
    assert.deepEqual(cancelled.effects.slice(1), [{ kind: 'end', end: null }])
    assert.equal(cancelled.state.waiting, null)
    const after = steps([{ kind: 'started', id: 1 }, { kind: 'done', id: 1, spans: spans(second.pattern) }], cancelled.state)
    assert.deepEqual(after.effects, [{ kind: 'time', id: 1 }, { kind: 'time', id: null }])
  })

  test('a job run after cancelling a slow one waits for the slow one to be stopped', () => {
    const { effects } = steps([{ kind: 'run', id: 1, job: first }, { kind: 'started', id: 1 }, { kind: 'cancel' }, { kind: 'run', id: 2, job: second }, { kind: 'timeout', id: 1 }])
    assert.deepEqual(effects.slice(2), [{ kind: 'end', end: null }, { kind: 'stop' }, { kind: 'post', id: 2, job: second }])
  })
})
