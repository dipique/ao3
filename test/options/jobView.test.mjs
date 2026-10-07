import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { cachedTextOff, jobView, offReason, railJob, removeOff } from '../../src/options_ui/model/jobView.ts'

const NOW = 1_800_000_000_000
const MINE = 'marked-for-later:tester'
const OTHER = 'tag-works:Coffee%20Shop%20AU'

const job = (fields = {}) => ({
  cacheKey: MINE,
  descriptor: { sourceId: 'marked-for-later', label: 'Marked for Later — tester', listUrl: 'https://archiveofourown.org/users/tester/readings?show=to-read' },
  steps: ['caching'],
  queue: ['31', '32'],
  done: 148,
  total: 240,
  startedAt: NOW - 60_000,
  updatedAt: NOW - 1_000,
  errors: [],
  errorCount: 0,
  ...fields,
})

const status = (fields = {}) => ({
  job: job(),
  running: true,
  message: 'Fetching “A work with a reasonably long title”…',
  error: null,
  warnings: [],
  waitingUntil: null,
  waitReason: null,
  ...fields,
})

/** The options page's names for its lists: only the one the job is on is known here. */
const names = key => (key === MINE ? 'Marked for Later' : '')

const view = fields => jobView(status(fields), names, NOW)

const failure = n => ({ workId: String(n), title: `Work ${n}`, reason: 'HTTP 404 — the work is gone' })

describe('jobView', () => {
  test('no job: idle, with nothing to say', () => {
    const idle = view({ job: null, running: false, message: '' })
    assert.equal(idle.state, 'idle')
    assert.equal(idle.key, null)
    assert.equal(idle.phase, null)
    assert.equal(idle.line, '')
    assert.deepEqual(idle.failures, { shown: [], more: 0 })
  })

  test('running: the list it is on, its phase, what it is fetching and how far it has got', () => {
    const running = view()
    assert.equal(running.state, 'running')
    assert.equal(running.key, MINE)
    assert.equal(running.name, 'Marked for Later')
    assert.equal(running.phase, 'caching')
    assert.equal(running.label, 'Caching Marked for Later')
    assert.equal(running.line, 'Fetching “A work with a reasonably long title”…')
    assert.equal(running.done, 148)
    assert.equal(running.total, 240)
    assert.equal(running.wait, undefined)
    assert.equal(running.countdown, undefined)
    assert.equal(running.severity, undefined, 'a running job is drawn in the brand colour, not a severity')
  })

  test('running before the runner has said what it is doing', () => {
    assert.equal(view({ message: '' }).line, 'Working…')
  })

  test('a list the page has no name for goes by its own label', () => {
    assert.equal(jobView(status(), () => '', NOW).name, 'Marked for Later — tester')
  })

  test('pacing: giving AO3 a moment, muted, counting down', () => {
    const pacing = view({ waitingUntil: NOW + 8_100, waitReason: 'pacing' })
    assert.equal(pacing.state, 'waiting')
    assert.equal(pacing.wait, 'pacing')
    assert.equal(pacing.line, 'Giving AO3 a moment')
    assert.equal(pacing.countdown, '9s')
    assert.equal(pacing.severity, 'neutral')
  })

  test('refused: AO3 asked us to slow down, a warning, counting down in minutes', () => {
    const refused = view({ waitingUntil: NOW + 296_000, waitReason: 'refused' })
    assert.equal(refused.state, 'waiting')
    assert.equal(refused.wait, 'refused')
    assert.equal(refused.line, 'AO3 asked us to slow down')
    assert.equal(refused.countdown, '4:56')
    assert.equal(refused.severity, 'warning')
    assert.equal(refused.done, 148, 'the count holds still while it waits')
  })

  test('a wait whose time is up reads as running again', () => {
    const over = view({ waitingUntil: NOW - 10, waitReason: 'refused' })
    assert.equal(over.state, 'running')
    assert.equal(over.wait, undefined)
    assert.equal(over.countdown, undefined)
    assert.equal(over.line, 'Fetching “A work with a reasonably long title”…')
  })

  test('stopped part-way: the steps and queue it left, to continue or discard', () => {
    const stopped = view({ running: false, message: '' })
    assert.equal(stopped.state, 'stopped')
    assert.equal(stopped.line, 'Stopped')
    assert.equal(stopped.severity, 'neutral')
    assert.equal(stopped.error, undefined)
    assert.equal(stopped.done, 148)
  })

  test('stopped by AO3: stopped, with the runner\'s reason as an error', () => {
    const reason = 'AO3 kept asking us to wait, so the run stopped after waiting it out for as long as is sensible.'
    const blocked = view({ job: job({ blocked: 'rate-limited' }), running: false, message: '', error: reason })
    assert.equal(blocked.state, 'stopped')
    assert.equal(blocked.line, 'Stopped')
    assert.equal(blocked.error, reason)
    assert.equal(blocked.severity, 'destructive')
  })

  test('finished, with a warning: finished, and the warning carried', () => {
    const warning = '35 of 240 works have no saved text, so the site links those to AO3 instead of opening them.'
    const finished = view({ job: job({ steps: [], queue: [], done: 240 }), running: false, message: '', warnings: [warning] })
    assert.equal(finished.state, 'finished')
    assert.equal(finished.line, 'Finished')
    assert.equal(finished.severity, 'success')
    assert.deepEqual(finished.warnings, [warning])
    assert.equal(finished.phase, null)
  })

  test('failures: the ones the job kept, and how many more it counted', () => {
    const kept = Array.from({ length: 50 }, (_, i) => failure(i + 1))
    const capped = view({ job: job({ errors: kept, errorCount: 57 }) })
    assert.equal(capped.failures.shown.length, 50)
    assert.equal(capped.failures.more, 7)

    const few = view({ job: job({ errors: [failure(1), failure(2)], errorCount: 2 }) })
    assert.deepEqual(few.failures, { shown: [failure(1), failure(2)], more: 0 })
  })
})

describe('offReason', () => {
  test('while a job runs, every other list says which list holds the one job, and what it is doing', () => {
    assert.equal(offReason(view(), OTHER), 'off for now: one job at a time, and Marked for Later is caching')
    assert.equal(offReason(view({ job: job({ steps: ['refreshing', 'caching'] }) }), OTHER), 'off for now: one job at a time, and Marked for Later is refreshing')
    assert.equal(offReason(view({ job: job({ steps: ['exporting'] }) }), OTHER), 'off for now: one job at a time, and Marked for Later is exporting')
  })

  test('the list the job is on says it is busy itself', () => {
    assert.equal(offReason(view(), MINE), 'off while this list is caching')
  })

  test('a job sitting out a pause is still running', () => {
    assert.equal(offReason(view({ waitingUntil: NOW + 5_000, waitReason: 'pacing' }), OTHER), 'off for now: one job at a time, and Marked for Later is caching')
  })

  test('nothing is off while no job runs: idle, stopped or finished', () => {
    assert.equal(offReason(view({ job: null, running: false }), OTHER), null)
    assert.equal(offReason(view({ running: false }), OTHER), null)
    assert.equal(offReason(view({ running: false }), MINE), null)
    assert.equal(offReason(view({ job: job({ steps: [] }), running: false }), OTHER), null)
  })
})

describe('removeOff', () => {
  test('a list\'s offline copy can\'t be removed while its own job runs', () => {
    assert.equal(removeOff(view(), MINE), 'off while this list is caching')
  })

  test('another list\'s job leaves it removable, and so does a stopped one', () => {
    assert.equal(removeOff(view(), OTHER), null)
    assert.equal(removeOff(view({ running: false }), MINE), null)
  })
})

describe('cachedTextOff', () => {
  test('cached work text is left alone while a job runs', () => {
    assert.equal(cachedTextOff(view()), 'off while Marked for Later is caching')
    assert.equal(cachedTextOff(view({ waitingUntil: NOW + 5_000, waitReason: 'refused' })), 'off while Marked for Later is caching')
  })

  test('and is free again once none does', () => {
    assert.equal(cachedTextOff(view({ running: false })), null)
    assert.equal(cachedTextOff(view({ job: null, running: false })), null)
  })
})

describe('railJob', () => {
  test('a running job shows on the rail: how far it has got, and what it is', () => {
    assert.deepEqual(railJob(view()), { text: '148/240', title: 'A job is running: caching Marked for Later' })
    assert.deepEqual(railJob(view({ waitingUntil: NOW + 5_000, waitReason: 'pacing' })), { text: '148/240', title: 'A job is running: caching Marked for Later' })
  })

  test('before it has counted anything, it shows no count', () => {
    assert.deepEqual(railJob(view({ job: job({ steps: ['refreshing'], done: 0, total: 0 }) })), { text: '', title: 'A job is running: refreshing Marked for Later' })
  })

  test('a job that isn\'t running isn\'t on the rail', () => {
    assert.equal(railJob(view({ running: false })), null)
    assert.equal(railJob(view({ job: null, running: false })), null)
  })
})
