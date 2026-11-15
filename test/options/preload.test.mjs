import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { WAIT_WORDS } from '../../src/content_script/archiveFetch.ts'
import { JOB_LINE, jobView } from '../../src/options_ui/model/jobView.ts'
import { failedNote, listReadView, preloadLine, readFailure, readingLine, retryLine, waitingTurnLine, withReads } from '../../src/options_ui/model/preload.ts'
import { mentions } from '../facts.mjs'

const NOW = 1_800_000_000_000
const KEY = 'tracked-review'

const read = (fields = {}) => ({ name: 'Alpha', phase: 'queued', page: 0, of: 0, ...fields })

/** The Pre-load job's status: running, with `reads` as the reader last said. */
const status = (reads, fields = {}) => ({
  job: {
    cacheKey: KEY,
    descriptor: { sourceId: 'tracked-review', label: 'Tracked review', listUrl: 'https://archiveofourown.org/users/me/readings#ao3e-tracked' },
    steps: ['refreshing'],
    queue: [],
    done: Object.values(reads).filter(one => one.phase === 'done' || one.phase === 'failed').length,
    total: Object.keys(reads).length,
    startedAt: NOW - 60_000,
    updatedAt: NOW - 1_000,
    errors: [],
    errorCount: 0,
  },
  running: true,
  message: '',
  error: null,
  warnings: [],
  waitingUntil: null,
  waitReason: null,
  reads,
  ...fields,
})

const names = key => (key === KEY ? 'This review' : '')
/** The job as the page shows it: Pre-load's, with `reads` as the reader last said. */
const shown = st => withReads(jobView(st, names, NOW), st.reads)
const view = (reads, fields) => shown(status(reads, fields))
const finished = reads => view(reads, { running: false, job: { ...status(reads).job, steps: [] } })
const paused = reads => view(reads, { running: false })
const waitingOn = (reads, reason) => view(reads, { waitingUntil: NOW + 65_000, waitReason: reason })

describe('a list being pre-loaded, as its row shows it', () => {
  const running = view({ alpha: read({ phase: 'reading' }) })

  test('nothing for a list not reached yet, read to its end, or with no read at all', () => {
    assert.equal(listReadView(undefined, running), null)
    assert.equal(listReadView(read(), running), null)
    assert.equal(listReadView(read({ phase: 'done', page: 3, of: 3 }), running), null)
  })

  test('the page being read, and how many its list has once the first page says', () => {
    const first = read({ phase: 'reading' })
    assert.deepEqual(pick(listReadView(first, running)), { state: 'running', severity: undefined, line: readingLine(first), done: 0, total: 0 })
    const third = read({ phase: 'reading', page: 2, of: 4 })
    assert.deepEqual(pick(listReadView(third, running)), { state: 'running', severity: undefined, line: readingLine(third), done: 2, total: 4 })
    assert.notEqual(readingLine(first), readingLine(third))
  })

  test('a pause in requests while it is being read is its own, with the job’s countdown', () => {
    const reading = read({ phase: 'reading', page: 1, of: 4 })
    const job = waitingOn({ alpha: reading }, 'refused')
    const row = listReadView(reading, job)
    assert.equal(row.state, 'waiting')
    assert.equal(row.wait, 'refused')
    assert.equal(row.countdown, job.countdown)
    assert.equal(row.line, WAIT_WORDS.refused)
    assert.equal(row.severity, 'warning')
  })

  test('a failed try says which page, which try, and what went wrong, then that it tries again', () => {
    const retrying = read({ phase: 'retrying', page: 1, of: 4, attempt: 2, error: 'HTTP 502' })
    const row = listReadView(retrying, running)
    assert.deepEqual(pick(row), { state: 'running', severity: 'warning', line: retryLine(retrying, false), done: 1, total: 4 })
    assert.ok(mentions(row.line, 'HTTP 502'))
    const paced = listReadView(retrying, waitingOn({ alpha: retrying }, 'pacing'))
    assert.equal(paced.line, retryLine(retrying, true), 'the countdown says when it tries again')
    assert.ok(paced.countdown)
  })

  test('what went wrong is said by AO3’s status, without the address it was asked', () => {
    const error = 'Failed to fetch https://archiveofourown.org/tags/x/works?page=1 (status 500)'
    const retrying = read({ phase: 'retrying', attempt: 1, error })
    const failed = read({ phase: 'failed', failure: 'request', error })
    for (const text of [retryLine(retrying, false), readFailure(failed)]) {
      assert.ok(mentions(text, '500'), text)
      assert.ok(!mentions(text, 'archiveofourown.org'), text)
    }
    const unlisted = readFailure(read({ phase: 'failed', failure: 'request', error: 'No listing on the page: https://archiveofourown.org/tags/x/works?page=1' }))
    assert.ok(mentions(unlisted, 'No listing on the page'))
    assert.ok(!mentions(unlisted, 'archiveofourown.org'), unlisted)
  })

  test('a list partway read waits its turn while one read less far goes first', () => {
    const partway = read({ page: 2, of: 4 })
    assert.deepEqual(pick(listReadView(partway, running)), { state: 'running', severity: 'neutral', line: waitingTurnLine(partway), done: 2, total: 4 })
  })

  test('a list given up on says why, until the job is put away', () => {
    const signedOut = read({ phase: 'failed', failure: 'signed-out' })
    const request = read({ phase: 'failed', failure: 'request', error: 'HTTP 500', page: 1, of: 3 })
    const notArchive = read({ phase: 'failed', failure: 'not-archive' })
    for (const job of [running, finished({ alpha: request }), paused({ alpha: request })]) {
      const row = listReadView(request, job)
      assert.equal(row.state, 'stopped')
      assert.equal(row.severity, 'destructive')
      assert.equal(row.error, readFailure(request))
    }
    assert.ok(mentions(readFailure(request), 'HTTP 500'))
    assert.equal(new Set([readFailure(signedOut), readFailure(request), readFailure(notArchive)]).size, 3)
    assert.equal(listReadView(request, shown({ ...status({}), job: null })), null)
  })

  test('once the run stops, a list it left partway says nothing', () => {
    assert.equal(listReadView(read({ page: 2, of: 4 }), paused({ alpha: read({ page: 2, of: 4 }) })), null)
  })
})

describe('Pre-load, as This review shows it', () => {
  const reads = {
    alpha: read({ phase: 'done', page: 2, of: 2 }),
    beta: read({ name: 'Beta', phase: 'failed', failure: 'request', error: 'HTTP 500' }),
    gamma: read({ name: 'Gamma', phase: 'reading', page: 1, of: 3 }),
    delta: read({ name: 'Delta' }),
  }

  test('running: the list being read, and how many failed', () => {
    const job = view(reads)
    assert.equal(job.line, preloadLine(reads, 'running'))
    assert.ok(mentions(job.line, 'Gamma'))
    assert.ok(mentions(job.line, '1'))
    assert.deepEqual([job.done, job.total], [2, 4])
    assert.notEqual(preloadLine(reads, 'running'), preloadLine({ ...reads, gamma: read({ name: 'Gamma', phase: 'retrying', page: 1, of: 3, attempt: 1, error: 'x' }) }, 'running'), 'a retry is said as one')
  })

  test('a pause in requests is said as for any job', () => {
    assert.equal(waitingOn(reads, 'refused').line, WAIT_WORDS.refused)
  })

  test('finished: every list read is a success; any failure is a warning naming the lists', () => {
    const clean = { alpha: reads.alpha }
    assert.deepEqual([finished(clean).line, finished(clean).severity], [preloadLine(clean, 'finished'), 'success'])
    assert.deepEqual(finished(clean).warnings, [])

    const failing = { alpha: reads.alpha, beta: reads.beta }
    const job = finished(failing)
    assert.deepEqual([job.line, job.severity], [preloadLine(failing, 'finished'), 'warning'])
    assert.deepEqual(job.warnings, [failedNote(failing)])
    assert.ok(mentions(failedNote(failing), 'Beta'))
    assert.equal(failedNote(clean), null)
  })

  test('paused: says so, and how far it got', () => {
    const job = paused(reads)
    assert.equal(job.state, 'stopped')
    assert.equal(job.line, preloadLine(reads, 'paused'))
    assert.ok(mentions(job.line, JOB_LINE.paused))
  })

  test('a job that isn’t Pre-load is drawn as before', () => {
    const plain = shown({ ...status({}), reads: null, message: 'Fetching “A work”…' })
    assert.equal(plain.line, 'Fetching “A work”…')
  })
})

function pick(row) {
  return { state: row.state, severity: row.severity, line: row.line, done: row.done, total: row.total }
}
