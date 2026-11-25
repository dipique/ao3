import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createDefaultMarks, packIds, packProgress } from '../../src/common/workMarks.ts'
import { toEpochDays } from '../../src/common/workProgress.ts'
import { CACHED, DELETED, WIP_VALUE } from '../../src/content_script/searchView/engine.ts'
// statusValues.ts reaches only the pure mark and progress modules and the
// engine, so it loads bare under Node's type stripping.
import { stampStatuses } from '../../src/content_script/searchView/statusValues.ts'

const TODAY = toEpochDays('2026-03-14')

/** A work as the stamping pass reads one: its id, chapter count, completion and deleted record. */
function work(overrides = {}) {
  return { workId: '1', chapters: { written: 3, total: 3 }, complete: true, ...overrides }
}

/** Marks switched on, with whatever ids and progress you name. */
function workMarks({ items = {}, progress = {}, enabled = true } = {}) {
  const marks = createDefaultMarks()
  for (const [id, ids] of Object.entries(items))
    marks[id].items = packIds(ids)
  for (const [id, entries] of Object.entries(progress))
    marks[id].progress = packProgress(Object.entries(entries))
  return { enabled, marks }
}

const NONE = { saved: null, cached: null, today: TODAY }

/** The statuses `stampStatuses` gives one work, sorted for comparison. */
function statusesOf(w, marks = workMarks(), ctx = NONE) {
  stampStatuses([w], marks, ctx)
  return [...w.statuses].sort()
}

describe('Ready', () => {
  test('an unread complete work is ready', () => {
    assert.deepEqual(statusesOf(work()), ['Ready', 'Unread'])
  })

  test('an unread work in progress is not', () => {
    assert.deepEqual(statusesOf(work({ complete: false })), ['Unread', WIP_VALUE])
  })

  test('an ongoing work with unread chapters is ready only once it is complete', () => {
    const marks = workMarks({ items: { continue: ['1'] }, progress: { continue: { 1: { chapter: 1 } } } })
    assert.deepEqual(statusesOf(work(), marks), ['Ongoing', 'Ready'])
    assert.deepEqual(statusesOf(work({ complete: false }), marks), ['Ongoing', WIP_VALUE])
  })

  test('waiting and caught up are said whether or not the work is complete', () => {
    const waiting = workMarks({ items: { continue: ['1'] }, progress: { continue: { 1: { chapter: 1, waitUntil: TODAY + 1 } } } })
    assert.deepEqual(statusesOf(work({ complete: false }), waiting), ['Ongoing', 'Waiting', WIP_VALUE])
    const caughtUp = workMarks({ items: { continue: ['1'] }, progress: { continue: { 1: { chapter: 3 } } } })
    assert.deepEqual(statusesOf(work({ complete: false }), caughtUp), ['Caught up', 'Ongoing', WIP_VALUE])
  })
})

describe('the work’s own state', () => {
  test('a work in progress says so, a complete one does not', () => {
    assert.ok(statusesOf(work({ complete: false })).includes(WIP_VALUE))
    assert.ok(!statusesOf(work()).includes(WIP_VALUE))
  })

  test('cached is the work’s text being in the cache', () => {
    const cached = { ...NONE, cached: new Set(['1']) }
    assert.ok(statusesOf(work(), workMarks(), cached).includes(CACHED))
    assert.ok(!statusesOf(work({ workId: '2' }), workMarks(), cached).includes(CACHED))
    assert.ok(!statusesOf(work()).includes(CACHED), 'an unread cache says nothing')
  })

  test('deleted is a work AO3 has deleted that the list keeps', () => {
    assert.ok(statusesOf(work({ deleted: { at: 1 } })).includes(DELETED))
    assert.ok(!statusesOf(work()).includes(DELETED))
  })

  test('with marks off they are all still there, beside Ready', () => {
    const off = workMarks({ enabled: false, items: { read: ['1'] } })
    const ctx = { ...NONE, cached: new Set(['1']) }
    assert.deepEqual(statusesOf(work({ deleted: { at: 1 } }), off, ctx), [CACHED, DELETED, 'Ready'])
    assert.deepEqual(statusesOf(work({ complete: false }), off, ctx), [CACHED, WIP_VALUE])
  })
})

describe('marks', () => {
  test('a verdict takes Unread and readiness off', () => {
    assert.deepEqual(statusesOf(work(), workMarks({ items: { good: ['1'] } })), ['Good'])
  })

  test('marked for later is the saved index', () => {
    const ctx = { ...NONE, saved: new Set(['1']) }
    assert.deepEqual(statusesOf(work(), workMarks(), ctx), ['Marked for later', 'Ready', 'Unread'])
  })
})
