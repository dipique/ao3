import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { RULE_TIMING_MIN_KEPT, RULE_TIMING_WINDOW_MS } from '../../src/common/constants.ts'
import { appendRuleTiming, keepRuleTimings, ruleTimingEntry, summarizeRuleTimings } from '../../src/common/ruleTiming.ts'

const NOW = Date.UTC(2026, 9, 15, 12)

const rules = (...matchers) => matchers.map(matcher => ({ matcher }))

const entry = props => ({
  at: NOW,
  where: 'list',
  works: 20,
  rules: 3,
  matchers: { exact: 1, contains: 1, regex: 1 },
  ms: 1,
  matchMs: 1,
  ...props,
})

/** `count` entries, one a minute, the last at `end`. */
function series(count, end) {
  return Array.from({ length: count }, (_, i) => entry({ at: end - (count - 1 - i) * 60_000 }))
}

describe('ruleTimingEntry', () => {
  test('counts the rules and how each matches', () => {
    const made = ruleTimingEntry({
      at: NOW,
      where: 'page',
      works: 20,
      rules: rules('exact', 'exact', 'contains', 'regex'),
      ms: 2,
      matchMs: 1.5,
      pageMs: 0.25,
    })
    assert.deepEqual(made, {
      at: NOW,
      where: 'page',
      works: 20,
      rules: 4,
      matchers: { exact: 2, contains: 1, regex: 1 },
      ms: 2,
      matchMs: 1.5,
      pageMs: 0.25,
    })
  })

  test('a pass that changed nothing on the page carries no page time', () => {
    const made = ruleTimingEntry({ at: NOW, where: 'list', works: 5, rules: rules('exact'), ms: 1, matchMs: 1 })
    assert.equal('pageMs' in made, false)
  })

  test('is null with no rules to weigh', () => {
    assert.equal(ruleTimingEntry({ at: NOW, where: 'list', works: 5, rules: [], ms: 1, matchMs: 1 }), null)
  })

  test('is null with no works to weigh them against', () => {
    assert.equal(ruleTimingEntry({ at: NOW, where: 'list', works: 0, rules: rules('exact'), ms: 1, matchMs: 1 }), null)
  })
})

describe('keepRuleTimings', () => {
  test('keeps every evaluation inside the window, however many', () => {
    const log = series(RULE_TIMING_MIN_KEPT * 2, NOW)
    assert.equal(keepRuleTimings(log, NOW).length, RULE_TIMING_MIN_KEPT * 2)
  })

  test('drops evaluations older than the window once enough newer ones are kept', () => {
    const old = series(5, NOW - RULE_TIMING_WINDOW_MS - 60_000)
    const recent = series(RULE_TIMING_MIN_KEPT, NOW)
    assert.deepEqual(keepRuleTimings([...old, ...recent], NOW), recent)
  })

  test('keeps the newest of the older evaluations while the window holds too few', () => {
    const old = series(RULE_TIMING_MIN_KEPT, NOW - RULE_TIMING_WINDOW_MS - 60_000)
    const recent = series(10, NOW)
    const kept = keepRuleTimings([...old, ...recent], NOW)
    assert.equal(kept.length, RULE_TIMING_MIN_KEPT)
    assert.deepEqual(kept, [...old.slice(10), ...recent])
  })

  test('an evaluation exactly at the edge of the window is inside it', () => {
    const edge = entry({ at: NOW - RULE_TIMING_WINDOW_MS })
    const log = [edge, ...series(RULE_TIMING_MIN_KEPT, NOW)]
    assert.equal(keepRuleTimings(log, NOW)[0], edge)
  })

  test('hands back the same list when nothing is dropped', () => {
    const log = series(3, NOW)
    assert.equal(keepRuleTimings(log, NOW), log)
  })
})

describe('appendRuleTiming', () => {
  test('adds the evaluation last, without changing the list it was given', () => {
    const log = series(2, NOW - 60_000)
    const added = entry({ at: NOW })
    const next = appendRuleTiming(log, added)
    assert.deepEqual(next, [...log, added])
    assert.equal(log.length, 2)
  })

  test('prunes against the new evaluation\'s time', () => {
    const old = series(RULE_TIMING_MIN_KEPT, NOW - RULE_TIMING_WINDOW_MS - 60_000)
    const next = appendRuleTiming(old, entry({ at: NOW }))
    assert.equal(next.length, RULE_TIMING_MIN_KEPT)
    assert.equal(next.at(-1).at, NOW)
  })

  test('a stored value that is not a list starts a fresh one', () => {
    const added = entry()
    assert.deepEqual(appendRuleTiming(undefined, added), [added])
  })
})

describe('summarizeRuleTimings', () => {
  test('is null with nothing recorded', () => {
    assert.equal(summarizeRuleTimings([], NOW), null)
  })

  test('totals the evaluations and works, and weighs time by works', () => {
    const summary = summarizeRuleTimings([
      entry({ works: 100, ms: 3, matchMs: 2, rules: 10 }),
      entry({ works: 300, ms: 1, matchMs: 1, rules: 20 }),
    ], NOW)
    assert.equal(summary.evaluations, 2)
    assert.equal(summary.works, 400)
    assert.equal(summary.msPer100, 1)
    assert.equal(summary.matchMsPer100, 0.75)
    assert.equal(summary.averageRules, 15)
  })

  test('says whether every evaluation counted falls inside the window', () => {
    assert.equal(summarizeRuleTimings(series(3, NOW), NOW).withinWindow, true)
    const old = series(3, NOW - RULE_TIMING_WINDOW_MS - 60_000)
    assert.equal(summarizeRuleTimings([...old, ...series(3, NOW)], NOW).withinWindow, false)
  })

  test('counts only what pruning would keep', () => {
    const old = series(5, NOW - RULE_TIMING_WINDOW_MS - 60_000)
    const summary = summarizeRuleTimings([...old, ...series(RULE_TIMING_MIN_KEPT, NOW)], NOW)
    assert.equal(summary.evaluations, RULE_TIMING_MIN_KEPT)
    assert.equal(summary.withinWindow, true)
  })

  test('page-change time comes only from the passes that changed a page', () => {
    const summary = summarizeRuleTimings([
      entry({ where: 'page', works: 50, ms: 2, matchMs: 1, pageMs: 0.5 }),
      entry({ where: 'list', works: 1000, ms: 5, matchMs: 5 }),
    ], NOW)
    assert.equal(summary.pageMsPer100, 1)
    assert.equal(summary.pageWorks, 50)
  })

  test('has no page-change time when no pass changed a page', () => {
    assert.equal(summarizeRuleTimings([entry()], NOW).pageMsPer100, null)
  })

  test('averages how many rules of each kind were weighed', () => {
    const summary = summarizeRuleTimings([
      entry({ matchers: { exact: 4, contains: 1, regex: 0 } }),
      entry({ matchers: { exact: 2, contains: 0, regex: 1 } }),
    ], NOW)
    assert.deepEqual(summary.averageMatchers, { exact: 3, contains: 0.5, regex: 0.5 })
  })
})
