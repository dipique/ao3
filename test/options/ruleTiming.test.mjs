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

describe('ruleTimingText', () => {
  test('says so when nothing has been recorded', () => {
    assert.deepEqual(ruleTimingText(null), { summary: 'No ruleset evaluations recorded yet.', detail: null })
  })

  test('counts evaluations and works, and gives the time per 100 works', () => {
    assert.equal(
      ruleTimingText(summary()).summary,
      '12 ruleset evaluations in the last seven days on 340 total works. Average time to process ruleset: 0.12ms/100 items for 14.3 average rules.',
    )
  })

  test('names no window when older evaluations are counted too', () => {
    assert.equal(
      ruleTimingText(summary({ withinWindow: false })).summary,
      '12 ruleset evaluations on 340 total works. Average time to process ruleset: 0.12ms/100 items for 14.3 average rules.',
    )
  })

  test('one evaluation of one work reads in the singular', () => {
    assert.match(ruleTimingText(summary({ evaluations: 1, works: 1 })).summary, /^1 ruleset evaluation in the last seven days on 1 total work\. /)
  })

  test('large counts are grouped the reader\'s way', () => {
    const grouped = (12345).toLocaleString()
    assert.match(ruleTimingText(summary({ works: 12345 })).summary, new RegExp(` on ${grouped} total works\\.`))
  })

  test('the detail splits matching from page changes, when a page was changed', () => {
    assert.equal(
      ruleTimingText(summary({ pageMsPer100: 0.034, pageWorks: 60 })).detail,
      'Matching rules: 0.10ms/100 items. Changing AO3 listing pages: 0.03ms/100 items. Rules by match type, on average: 12.0 exact, 2.0 contains, 0.3 regex.',
    )
  })

  test('the detail leaves out page changes when no page was changed', () => {
    assert.equal(
      ruleTimingText(summary()).detail,
      'Matching rules: 0.10ms/100 items. Rules by match type, on average: 12.0 exact, 2.0 contains, 0.3 regex.',
    )
  })
})
