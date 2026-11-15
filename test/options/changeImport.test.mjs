import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { countdown, WAIT_WORDS } from '../../src/content_script/archiveFetch.ts'
import { CHANGE_IMPORT_LINE, changeImportView } from '../../src/options_ui/model/changeImport.ts'

const NOW = 1_800_000_000_000

const progress = (fields = {}) => ({ step: 'archive', done: 12, total: 40, waitingUntil: null, waitReason: null, ...fields })

/**
 * An import of changes made in an export, as the line under its row shows it:
 * the same line, bar and countdown a site export job gets, so a pause in
 * requests to AO3 reads the same wherever the reader meets it.
 */
describe('changeImportView', () => {
  test('with no import running, there is no line', () => {
    assert.equal(changeImportView(null, NOW).state, 'idle')
  })

  test('applying the file\'s marks says so, with nothing yet to count', () => {
    const view = changeImportView(progress({ step: 'applying', done: 0, total: 0 }), NOW)

    assert.equal(view.state, 'running')
    assert.equal(view.line, CHANGE_IMPORT_LINE.applying)
    assert.equal(view.total, 0, 'so no bar is drawn')
  })

  test('telling AO3 counts the works it has been asked about, out of all of them', () => {
    const view = changeImportView(progress(), NOW)

    assert.equal(view.state, 'running')
    assert.equal(view.line, CHANGE_IMPORT_LINE.archive)
    assert.deepEqual([view.done, view.total], [12, 40])
    assert.ok(view.label, 'the bar is named')
  })

  test('sitting out a refusal says AO3 asked us to slow down, how long is left, and keeps its count', () => {
    const view = changeImportView(progress({ waitingUntil: NOW + 95_000, waitReason: 'refused' }), NOW)

    assert.equal(view.state, 'waiting')
    assert.equal(view.wait, 'refused')
    assert.equal(view.line, WAIT_WORDS.refused)
    assert.equal(view.countdown, countdown(95_000))
    assert.equal(view.severity, 'warning')
    assert.deepEqual([view.done, view.total], [12, 40])
  })

  test('a breather of our own is said as one, not as AO3 complaining', () => {
    const view = changeImportView(progress({ waitingUntil: NOW + 4_000, waitReason: 'pacing' }), NOW)

    assert.equal(view.wait, 'pacing')
    assert.equal(view.line, WAIT_WORDS.pacing)
    assert.equal(view.severity, 'neutral')
  })

  test('once Stop is pressed, it says it is stopping rather than counting down', () => {
    const view = changeImportView(progress({ waitingUntil: NOW + 95_000, waitReason: 'refused' }), NOW, true)

    assert.equal(view.state, 'running')
    assert.equal(view.line, CHANGE_IMPORT_LINE.stopping)
    assert.equal(view.countdown, undefined)
  })

  test('a pause whose time is up is no longer shown', () => {
    const view = changeImportView(progress({ waitingUntil: NOW, waitReason: 'refused' }), NOW)

    assert.equal(view.state, 'running')
    assert.equal(view.countdown, undefined)
  })
})
