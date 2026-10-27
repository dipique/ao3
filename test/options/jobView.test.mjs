import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { WAIT_WORDS } from '../../src/content_script/archiveFetch.ts'
import { claimRefresh, loadingLine, withPause, withProgress } from '../../src/content_script/searchView/listRefresh.ts'
import { busyNotice, cachedTextOff, foreignView, JOB_LINE, jobVerb, jobView, listJob, offReason, railJob, removeOff } from '../../src/options_ui/model/jobView.ts'
import { mentions } from '../facts.mjs'

const NOW = 1_800_000_000_000
const MINE = 'marked-for-later:tester'
const OTHER = 'tag-works:Coffee%20Shop%20AU'
/** What the page calls the list the job is on. */
const NAME = 'Marked for Later'

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
const names = key => (key === MINE ? NAME : '')

const view = fields => jobView(status(fields), names, NOW)

const failure = n => ({ workId: String(n), title: `Work ${n}`, reason: 'HTTP 404 — the work is gone' })

/** What a job in each phase is said to be doing. */
const REFRESHING = jobVerb({ phase: 'refreshing' })
const CACHING = jobVerb({ phase: 'caching' })
const DOWNLOADING = jobVerb({ phase: 'exporting' })

/** `text` says the job is on the list called `name`, and what it is doing. */
function saysJob(text, verb, name = NAME) {
  assert.ok(mentions(text, name), `${text} should name ${name}`)
  assert.ok(mentions(text, verb), `${text} should say it is ${verb}`)
}

/** A reason the list the job is on gives: it is busy itself, so no other list is named. */
function busyItself(reason, verb = CACHING) {
  assert.ok(mentions(reason, verb), `${reason} should say it is ${verb}`)
  assert.ok(!mentions(reason, NAME), `${reason} should name no list`)
}

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
    assert.equal(running.name, NAME)
    assert.equal(running.phase, 'caching')
    saysJob(running.label, CACHING)
    assert.equal(running.line, 'Fetching “A work with a reasonably long title”…')
    assert.equal(running.done, 148)
    assert.equal(running.total, 240)
    assert.equal(running.wait, undefined)
    assert.equal(running.countdown, undefined)
    assert.equal(running.severity, undefined, 'a running job is drawn in the brand colour, not a severity')
  })

  test('running before the runner has said what it is doing', () => {
    assert.equal(view({ message: '' }).line, JOB_LINE.working)
  })

  test('a Download\'s last stage: the phase is exporting, said as its button says', () => {
    const downloading = view({ job: job({ steps: ['exporting'] }) })
    assert.equal(downloading.phase, 'exporting')
    saysJob(downloading.label, DOWNLOADING)
  })

  test('a list the page has no name for goes by its own label', () => {
    assert.equal(jobView(status(), () => '', NOW).name, 'Marked for Later — tester')
  })

  test('pacing: giving AO3 a moment, muted, counting down', () => {
    const pacing = view({ waitingUntil: NOW + 8_100, waitReason: 'pacing' })
    assert.equal(pacing.state, 'waiting')
    assert.equal(pacing.wait, 'pacing')
    assert.equal(pacing.line, WAIT_WORDS.pacing)
    assert.equal(pacing.countdown, '9s')
    assert.equal(pacing.severity, 'neutral')
  })

  test('refused: AO3 asked us to slow down, a warning, counting down in minutes', () => {
    const refused = view({ waitingUntil: NOW + 296_000, waitReason: 'refused' })
    assert.equal(refused.state, 'waiting')
    assert.equal(refused.wait, 'refused')
    assert.equal(refused.line, WAIT_WORDS.refused)
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

  test('paused part-way: the steps and queue it left, to continue or discard', () => {
    const stopped = view({ running: false, message: '' })
    assert.equal(stopped.state, 'stopped')
    assert.equal(stopped.line, JOB_LINE.paused)
    assert.equal(stopped.severity, 'neutral')
    assert.equal(stopped.error, undefined)
    assert.equal(stopped.done, 148)
  })

  test('stopped by AO3: stopped, with the runner\'s reason as an error', () => {
    const reason = 'AO3 kept asking us to wait, so the run stopped after waiting it out for as long as is sensible.'
    const blocked = view({ job: job({ blocked: 'rate-limited' }), running: false, message: '', error: reason })
    assert.equal(blocked.state, 'stopped')
    assert.equal(blocked.line, JOB_LINE.stopped)
    assert.equal(blocked.error, reason)
    assert.equal(blocked.severity, 'destructive')
  })

  test('finished, with a warning: finished, and the warning carried', () => {
    const warning = '35 of 240 works have no saved text, so the site links those to AO3 instead of opening them.'
    const finished = view({ job: job({ steps: [], queue: [], done: 240 }), running: false, message: '', warnings: [warning] })
    assert.equal(finished.state, 'finished')
    assert.equal(finished.line, JOB_LINE.finished)
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

describe('foreignView', () => {
  const claim = withProgress(claimRefresh('tab', 'page', NOW - 5_000), 2, 5, NOW - 1_000)

  test('a refresh another page runs: the list, refreshing, and how far it has got', () => {
    const there = foreignView(claim, MINE, names, NOW)
    assert.equal(there.key, MINE)
    assert.equal(there.name, NAME)
    assert.equal(there.phase, 'refreshing')
    saysJob(there.label, REFRESHING)
    assert.equal(there.state, 'running')
    assert.equal(there.line, loadingLine(2, 5))
    assert.equal(there.done, 2)
    assert.equal(there.total, 5)
    assert.equal(there.claimId, claim.id)
    assert.deepEqual(there.warnings, [])
    assert.deepEqual(there.failures, { shown: [], more: 0 })
  })

  test('before its page count is known, it is fetching the list', () => {
    assert.equal(foreignView(claimRefresh('options', 'options', NOW), MINE, names, NOW).line, loadingLine(0, 0))
  })

  test('sitting out a pause: waiting, with its kind and countdown', () => {
    const paused = foreignView(withPause(claim, NOW + 65_000, 'refused', NOW - 500), MINE, names, NOW)
    assert.equal(paused.state, 'waiting')
    assert.equal(paused.wait, 'refused')
    assert.equal(paused.countdown, '1:05')
    assert.equal(paused.line, WAIT_WORDS.refused)
    assert.equal(paused.severity, 'warning')
  })

  test('a list the page has no name for goes by its key', () => {
    assert.equal(foreignView(claim, OTHER, names, NOW).name, OTHER)
  })
})

describe('offReason', () => {
  test('while a job runs, every other list says which list holds the one job, and what it is doing', () => {
    saysJob(offReason(view(), OTHER), CACHING)
    saysJob(offReason(view({ job: job({ steps: ['refreshing', 'caching'] }) }), OTHER), REFRESHING)
  })

  test('a Download\'s last stage is said as its button says', () => {
    saysJob(offReason(view({ job: job({ steps: ['exporting'] }) }), OTHER), DOWNLOADING)
    busyItself(offReason(view({ job: job({ steps: ['exporting'] }) }), MINE), DOWNLOADING)
  })

  test('the list the job is on says it is busy itself', () => {
    busyItself(offReason(view(), MINE))
    assert.notEqual(offReason(view(), MINE), offReason(view(), OTHER))
  })

  test('a job sitting out a pause is still running', () => {
    assert.equal(offReason(view({ waitingUntil: NOW + 5_000, waitReason: 'pacing' }), OTHER), offReason(view(), OTHER))
  })

  test('nothing is off while no job runs: idle, stopped or finished', () => {
    assert.equal(offReason(view({ job: null, running: false }), OTHER), null)
    assert.equal(offReason(view({ running: false }), OTHER), null)
    assert.equal(offReason(view({ running: false }), MINE), null)
    assert.equal(offReason(view({ job: job({ steps: [] }), running: false }), OTHER), null)
  })

  test('a list held in several copies is busy itself while the job is on any of them', () => {
    assert.equal(offReason(view(), [OTHER, MINE]), offReason(view(), MINE))
    assert.equal(offReason(view(), [OTHER]), offReason(view(), OTHER))
  })
})

describe('listJob', () => {
  test('with no job, a list\'s offline actions are there and on, and no line is its', () => {
    assert.deepEqual(listJob(view({ job: null, running: false }), MINE), { actions: 'offline', off: null, here: false })
  })

  test('another list\'s job turns them off, naming that list', () => {
    assert.deepEqual(listJob(view(), OTHER), { actions: 'offline', off: offReason(view(), OTHER), here: false })
    saysJob(listJob(view({ waitingUntil: NOW + 5_000, waitReason: 'refused' }), OTHER).off, CACHING)
  })

  test('its own job, running or sitting out a pause: Pause or Cancel, and the line is its', () => {
    assert.deepEqual(listJob(view(), MINE), { actions: 'stop', off: null, here: true })
    assert.deepEqual(listJob(view({ waitingUntil: NOW + 5_000, waitReason: 'pacing' }), MINE), { actions: 'stop', off: null, here: true })
  })

  test('its own job, stopped: Continue or Discard', () => {
    assert.deepEqual(listJob(view({ running: false }), MINE), { actions: 'resume', off: null, here: true })
  })

  test('its own job, finished: the line stays, and the actions are back', () => {
    assert.deepEqual(listJob(view({ job: job({ steps: [] }), running: false }), MINE), { actions: 'offline', off: null, here: true })
  })

  test('another list\'s stopped or finished job turns nothing off', () => {
    assert.deepEqual(listJob(view({ running: false }), OTHER), { actions: 'offline', off: null, here: false })
    assert.deepEqual(listJob(view({ job: job({ steps: [] }), running: false }), OTHER), { actions: 'offline', off: null, here: false })
  })

  test('a job on any of a list\'s copies is its own: an older sort order of its search, say', () => {
    const copies = [OTHER, MINE]
    assert.deepEqual(listJob(view(), copies), { actions: 'stop', off: null, here: true })
    assert.deepEqual(listJob(view({ running: false }), copies), { actions: 'resume', off: null, here: true })
    assert.deepEqual(listJob(view({ job: job({ steps: [] }), running: false }), copies), { actions: 'offline', off: null, here: true })
    assert.deepEqual(listJob(view(), [OTHER]), { actions: 'offline', off: offReason(view(), OTHER), here: false })
  })

  test('a refresh another page runs on it: Cancel alone, and the line is its', () => {
    const there = foreignView(claimRefresh('tab', 'page', NOW), MINE, names, NOW)
    assert.deepEqual(listJob(view({ job: null, running: false }), MINE, there), { actions: 'cancel', off: null, here: true })
    assert.deepEqual(listJob(view({ running: false }), MINE, there), { actions: 'cancel', off: null, here: true }, 'over a job of its own left paused')
  })

  test('its own job running, following that refresh, keeps Pause and Cancel', () => {
    const there = foreignView(claimRefresh('tab', 'page', NOW), MINE, names, NOW)
    assert.deepEqual(listJob(view(), MINE, there), { actions: 'stop', off: null, here: true })
  })

  test('a refresh another page runs on another list turns nothing off here', () => {
    const there = foreignView(claimRefresh('tab', 'page', NOW), OTHER, names, NOW)
    assert.deepEqual(listJob(view({ job: null, running: false }), MINE, there), { actions: 'offline', off: null, here: false })
  })
})

describe('removeOff', () => {
  test('a list\'s offline copy can\'t be removed while its own job runs', () => {
    assert.equal(removeOff(view(), MINE), offReason(view(), MINE))
    busyItself(removeOff(view(), MINE))
  })

  test('another list\'s job leaves it removable, and so does a stopped one', () => {
    assert.equal(removeOff(view(), OTHER), null)
    assert.equal(removeOff(view({ running: false }), MINE), null)
  })

  test('nor can a list held in several copies be removed while the job is on any of them', () => {
    assert.equal(removeOff(view(), [OTHER, MINE]), offReason(view(), MINE))
    assert.equal(removeOff(view(), [OTHER]), null)
    assert.equal(removeOff(view({ running: false }), [OTHER, MINE]), null)
  })
})

describe('cachedTextOff', () => {
  test('cached work text is left alone while a job runs, naming the list it is on', () => {
    saysJob(cachedTextOff(view()), CACHING)
    assert.equal(cachedTextOff(view({ waitingUntil: NOW + 5_000, waitReason: 'refused' })), cachedTextOff(view()))
  })

  test('a Download\'s last stage is said as its button says', () => {
    saysJob(cachedTextOff(view({ job: job({ steps: ['exporting'] }) })), DOWNLOADING)
  })

  test('and is free again once none does', () => {
    assert.equal(cachedTextOff(view({ running: false })), null)
    assert.equal(cachedTextOff(view({ job: null, running: false })), null)
  })
})

describe('railJob', () => {
  test('a running job shows on the rail: how far it has got, and what it is', () => {
    const rail = railJob(view())
    assert.equal(rail.text, '148/240')
    saysJob(rail.title, CACHING)
    assert.deepEqual(railJob(view({ waitingUntil: NOW + 5_000, waitReason: 'pacing' })), rail)
  })

  test('a Download\'s last stage is said as its button says', () => {
    saysJob(railJob(view({ job: job({ steps: ['exporting'] }) })).title, DOWNLOADING)
  })

  test('before it has counted anything, it shows no count', () => {
    const rail = railJob(view({ job: job({ steps: ['refreshing'], done: 0, total: 0 }) }))
    assert.equal(rail.text, '')
    saysJob(rail.title, REFRESHING)
  })

  test('a job that isn\'t running isn\'t on the rail', () => {
    assert.equal(railJob(view({ running: false })), null)
    assert.equal(railJob(view({ job: null, running: false })), null)
  })
})

describe('busyNotice', () => {
  test('while a job runs, the saved lists\' header names the list it is on and what it is doing', () => {
    saysJob(busyNotice(view()), CACHING)
    assert.equal(busyNotice(view({ waitingUntil: NOW + 5_000, waitReason: 'refused' })), busyNotice(view()))
    saysJob(busyNotice(view({ job: job({ steps: ['refreshing', 'caching'] }) })), REFRESHING)
    saysJob(busyNotice(view({ job: job({ steps: ['exporting'] }) })), DOWNLOADING)
  })

  test('a job that isn\'t running says nothing there', () => {
    assert.equal(busyNotice(view({ running: false })), null)
    assert.equal(busyNotice(view({ running: false, job: job({ steps: [] }) })), null)
    assert.equal(busyNotice(view({ job: null, running: false })), null)
  })
})
