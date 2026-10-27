import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { ruleTimingText } from '../../src/options_ui/model/ruleTiming.ts'

const summary = props => ({
  evaluations: 12,
  works: 340,
  withinWindow: true,
  msPer100: 0.123,
  matchMsPer100: 0.1,
  pageMsPer100: null,
  pageWorks: 0,
  averageRules: 14.25,
  averageMatchers: { exact: 12, contains: 2, regex: 0.25 },
  ...props,
})

/**
 * The numbers a line gives, in its order and as it writes them, to the places
 * it gives them: not a digit in a name, such as AO3's.
 */
const written = text => text.match(/\b\d[\d,]*(?:\.\d+)?/g) ?? []

/** The timings and counts a line gives: its numbers, less the 100 works each time is per. */
const timings = text => written(text).filter(n => n !== '100')

describe('ruleTimingText', () => {
  test('says so when nothing has been recorded, with no detail and no count', () => {
    const text = ruleTimingText(null)
    assert.equal(text.detail, null)
    assert.ok(text.summary, 'a line saying so')
    assert.deepEqual(written(text.summary), [])
  })

  test('counts evaluations and works, and gives the time per 100 works to two places, over the average rules to one', () => {
    assert.deepEqual(timings(ruleTimingText(summary()).summary), ['12', '340', '0.12', '14.3'])
  })

  test('names a window only when every evaluation counted is inside it', () => {
    const within = ruleTimingText(summary()).summary
    const older = ruleTimingText(summary({ withinWindow: false })).summary
    assert.notEqual(within, older)
    assert.ok(within.length > older.length, 'the window is named on top of the same counts')
  })

  test('one evaluation of one work is worded by its count', () => {
    const shape = text => text.replace(/\d+/g, '#')
    const one = ruleTimingText(summary({ evaluations: 1, works: 1 })).summary
    const two = ruleTimingText(summary({ evaluations: 2, works: 2 })).summary
    assert.notEqual(shape(one), shape(two))
  })

  test('large counts are grouped the reader\'s way', () => {
    assert.ok(written(ruleTimingText(summary({ works: 12345 })).summary).includes((12345).toLocaleString()))
  })

  test('the detail splits matching from page changes, when a page was changed', () => {
    assert.deepEqual(timings(ruleTimingText(summary({ pageMsPer100: 0.034, pageWorks: 60 })).detail), ['0.10', '0.03', '12.0', '2.0', '0.3'])
  })

  test('the detail leaves out page changes when no page was changed', () => {
    assert.deepEqual(timings(ruleTimingText(summary()).detail), ['0.10', '12.0', '2.0', '0.3'])
  })
})
