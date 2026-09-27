import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import { assessPull, describePullLoss, GUARD_MIN_REMOVED } from '../../src/common/syncGuard.ts'
import { createDefaultMarks, packIds } from '../../src/common/workMarks.ts'
import { marksFixture, range, rulesFixture, textReplacementsFixture, trackedListsFixture } from './harness.mjs'

const withOptions = update => ({ ...structuredClone(OPTION_DEFAULTS), ...structuredClone(update) })
const rules = (from, count) => ({ ...rulesFixture(0), filters: rulesFixture(from + count).filters.slice(from) })

describe('assessPull', () => {
  test('an update that removes nothing is within bounds', () => {
    const options = withOptions({ rules: rulesFixture(40), workMarks: marksFixture(range(1, 60)) })
    assert.equal(assessPull(options, options), null)
  })

  test('fewer than the minimum removed is within bounds, whatever the share', () => {
    const current = withOptions({ rules: rulesFixture(GUARD_MIN_REMOVED - 1) })
    assert.equal(assessPull(current, withOptions({})), null, 'emptying a short list is an edit, not an accident')
  })

  test('the minimum removed and a quarter of the list is held', () => {
    const current = withOptions({ rules: rulesFixture(20) })
    const incoming = withOptions({ rules: rules(5, 15) })
    const loss = assessPull(current, incoming)
    assert.deepEqual(loss?.rules, { removed: 5, of: 20 })
  })

  test('the minimum removed from a long list is within bounds', () => {
    const current = withOptions({ rules: rulesFixture(21) })
    const incoming = withOptions({ rules: rules(5, 16) })
    assert.equal(assessPull(current, incoming), null, '5 of 21 is under a quarter')
  })

  test('a rule is what it matches: changing how it behaves removes nothing', () => {
    const current = withOptions({ rules: rulesFixture(20) })
    const edited = rulesFixture(20)
    for (const rule of edited.filters) {
      rule.behavior = 'collapse'
      rule.priority = 7
    }
    assert.equal(assessPull(current, withOptions({ rules: edited })), null)
  })

  test('the incident: every rule and marked work gone', () => {
    const current = withOptions({
      rules: rulesFixture(348),
      workMarks: marksFixture(range(1, 282)),
      textReplacements: textReplacementsFixture(26),
    })
    const incoming = withOptions({ rules: { enabled: true, filters: [], colors: {} }, workMarks: marksFixture(range(9000, 2)), textReplacements: textReplacementsFixture(26) })
    const loss = assessPull(current, incoming)
    assert.deepEqual(loss?.rules, { removed: 348, of: 348 })
    assert.deepEqual(loss?.markedWorks, { removed: 282, of: 282 })
    assert.deepEqual(loss?.textReplacements, { removed: 0, of: 26 })
  })

  test('a work carrying two marks counts once', () => {
    const marks = createDefaultMarks()
    marks.hot.items = packIds(range(1, 10))
    marks.fluff.items = packIds(range(1, 10))
    const current = withOptions({ workMarks: { enabled: true, marks, version: 1 } })
    const loss = assessPull(current, withOptions({}))
    assert.deepEqual(loss?.markedWorks, { removed: 10, of: 10 })
  })

  test('text replacements are held like the other lists', () => {
    const loss = assessPull(withOptions({ textReplacements: textReplacementsFixture(12) }), withOptions({}))
    assert.deepEqual(loss?.textReplacements, { removed: 12, of: 12 })
  })

  test('tracked lists are held like the other lists', () => {
    const loss = assessPull(withOptions({ trackedLists: trackedListsFixture(12) }), withOptions({}))
    assert.deepEqual(loss?.trackedLists, { removed: 12, of: 12 })
  })

  test('a tracked list is its id: renaming or pausing one removes nothing', () => {
    const current = withOptions({ trackedLists: trackedListsFixture(20) })
    const edited = trackedListsFixture(20, { reviewedThrough: 20100 })
    for (const entry of edited.lists) {
      entry.alias = `${entry.alias} (renamed)`
      entry.tracked = false
      entry.since = 20050
    }
    assert.equal(assessPull(current, withOptions({ trackedLists: edited })), null)
  })

  test('nor does refining every one of them: a new query and view filter on the same id', () => {
    const current = withOptions({ trackedLists: trackedListsFixture(20) })
    const refined = trackedListsFixture(20)
    for (const entry of refined.lists) {
      entry.url = `${entry.url}&work_search%5Bexcluded_tag_names%5D=Angst`
      entry.filter = { facets: { characters: { ex: ['Draco Malfoy'] } } }
      entry.alias = `${entry.alias}, no Draco`
    }
    assert.equal(assessPull(current, withOptions({ trackedLists: refined })), null)
  })

  test('dropping most lists is still held, however the rest were refined', () => {
    const current = withOptions({ trackedLists: trackedListsFixture(12) })
    const incoming = trackedListsFixture(2)
    for (const entry of incoming.lists)
      entry.url = '/works/search?work_search%5Bquery%5D=something+else'
    assert.deepEqual(assessPull(current, withOptions({ trackedLists: incoming }))?.trackedLists, { removed: 10, of: 12 })
  })

  test('a list re-made under a new id is one lost and one gained, even with the same query', () => {
    const current = withOptions({ trackedLists: trackedListsFixture(8) })
    const remade = trackedListsFixture(8)
    for (const entry of remade.lists)
      entry.id = `new-${entry.id}`
    assert.deepEqual(assessPull(current, withOptions({ trackedLists: remade }))?.trackedLists, { removed: 8, of: 8 })
  })

  test('a mark holding works that disappears from the table is always held', () => {
    const marks = { ...createDefaultMarks(), cute: { icon: 'mdi/heart', label: 'Cute/Sweet', color: '#f0f', triggerAlias: 'read', items: packIds(['7']) } }
    const current = withOptions({ workMarks: { enabled: true, marks, version: 1 } })
    const incoming = withOptions({ workMarks: { enabled: true, marks: { ...createDefaultMarks(), read: { ...createDefaultMarks().read, items: packIds(['7']) } }, version: 1 } })
    assert.deepEqual(assessPull(current, incoming)?.marks, ['Cute/Sweet'], 'one work moved, but the reader\'s own mark went with it')
  })

  test('an empty mark that disappears is not', () => {
    const marks = { ...createDefaultMarks(), cute: { icon: 'mdi/heart', label: 'Cute/Sweet', color: '#f0f', triggerAlias: 'read', items: '' } }
    assert.equal(assessPull(withOptions({ workMarks: { enabled: true, marks, version: 1 } }), withOptions({})), null)
  })
})

describe('describePullLoss', () => {
  const none = { removed: 0, of: 0 }

  test('lists only what would be removed', () => {
    assert.equal(
      describePullLoss({ rules: { removed: 348, of: 348 }, markedWorks: { removed: 267, of: 282 }, textReplacements: none, trackedLists: none, marks: [] }),
      '348 of your 348 rules and 267 of your 282 marked works',
    )
  })

  test('one item stands alone; marks are named', () => {
    assert.equal(describePullLoss({ rules: none, markedWorks: none, textReplacements: { removed: 9, of: 12 }, trackedLists: none, marks: [] }), '9 of your 12 text replacements')
    assert.equal(
      describePullLoss({ rules: { removed: 5, of: 20 }, markedWorks: none, textReplacements: none, trackedLists: { removed: 6, of: 7 }, marks: ['Cute/Sweet', 'meh'] }),
      '5 of your 20 rules, 6 of your 7 tracked lists and the marks “Cute/Sweet”, “meh”',
    )
  })

  test('a loss stored by a build that weighed fewer collections still reads', () => {
    // `pause.loss` is stored, so an upgrade can find one with no `trackedLists`
    // in it. What it doesn't name, it doesn't mention.
    assert.equal(
      describePullLoss({ rules: { removed: 5, of: 20 }, markedWorks: none, textReplacements: none, marks: [] }),
      '5 of your 20 rules',
    )
  })
})
