import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { FACET_ROW_CAP, groupCountText, layoutFacetRows, leftOutNote, nameRanks } from '../../src/content_script/searchView/facetRows.ts'
import { figures, mentions } from '../facts.mjs'

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** Rows for `values`, each `[value, count, resultCount?]`, ranked by name as the view ranks them. */
function rows(...values) {
  const ranks = nameRanks(values.map(([value]) => value), collator.compare)
  return values.map(([value, count, resultCount = count], i) => ({ value, lower: value.toLowerCase(), count, resultCount, nameRank: ranks[i] }))
}

function selection({ include = [], exclude = [], require = [] } = {}) {
  return { include: new Set(include), exclude: new Set(exclude), require: new Set(require) }
}

const BY_COUNT = { query: '', sort: 'count', dir: 'desc' }
const names = list => list.map(row => row.value)

describe('nameRanks', () => {
  test('ranks values in collation order, numbers by value', () => {
    assert.deepEqual(nameRanks(['b', 'Chapter 10', 'a', 'Chapter 2'], collator.compare), [1, 3, 0, 2])
  })

  test('ranks values the collator calls equal in the order they came', () => {
    assert.deepEqual(nameRanks(['fluff', 'Fluff', 'angst'], collator.compare), [1, 2, 0])
  })
})

describe('layoutFacetRows', () => {
  test('shows the values that still have works, most first, ties by name', () => {
    const layout = layoutFacetRows(rows(['Fluff', 3], ['Angst', 5], ['Bees', 3]), selection(), BY_COUNT)
    assert.deepEqual(names(layout.rest), ['Angst', 'Bees', 'Fluff'])
    assert.equal(layout.shown, 3)
    assert.equal(layout.relevant, 3)
  })

  test('leaves out an unselected value no work has left', () => {
    const layout = layoutFacetRows(rows(['Fluff', 0], ['Angst', 2]), selection(), BY_COUNT)
    assert.deepEqual(names(layout.rest), ['Angst'])
    assert.equal(layout.shown, 1)
  })

  test('keeps a selected value in its own section even at no works, so it can be turned off', () => {
    const layout = layoutFacetRows(
      rows(['Fluff', 0], ['Angst', 2], ['Bees', 1], ['Crack', 4]),
      selection({ include: ['Fluff'], exclude: ['Angst'], require: ['Crack'] }),
      BY_COUNT,
    )
    assert.deepEqual(names(layout.sections.include), ['Fluff'])
    assert.deepEqual(names(layout.sections.exclude), ['Angst'])
    assert.deepEqual(names(layout.sections.require), ['Crack'])
    assert.deepEqual(names(layout.rest), ['Bees'])
    assert.equal(layout.shown, 4)
  })

  test('orders the rows inside a section by the same sort as the rest', () => {
    const layout = layoutFacetRows(rows(['Fluff', 1], ['Angst', 5], ['Bees', 3]), selection({ include: ['Fluff', 'Angst', 'Bees'] }), BY_COUNT)
    assert.deepEqual(names(layout.sections.include), ['Angst', 'Bees', 'Fluff'])
  })

  test('the value filter narrows what shows, but not what counts as relevant', () => {
    const layout = layoutFacetRows(rows(['Fluff', 1], ['Angst', 5], ['Hurt/Comfort', 0]), selection(), { ...BY_COUNT, query: '  FLU ' })
    assert.deepEqual(names(layout.rest), ['Fluff'])
    assert.equal(layout.shown, 1)
    assert.equal(layout.relevant, 2)
  })

  test('a value filter that matches nothing still leaves the group relevant', () => {
    const layout = layoutFacetRows(rows(['Fluff', 1]), selection(), { ...BY_COUNT, query: 'zzz' })
    assert.equal(layout.shown, 0)
    assert.equal(layout.relevant, 1)
  })

  test('a group with no works left and nothing selected is not relevant', () => {
    const layout = layoutFacetRows(rows(['Fluff', 0], ['Angst', 0]), selection(), BY_COUNT)
    assert.equal(layout.relevant, 0)
    assert.deepEqual(layout.rest, [])
  })

  test('sorts by count ascending, ties still by name A to Z', () => {
    const layout = layoutFacetRows(rows(['Fluff', 3], ['Angst', 5], ['Bees', 3]), selection(), { ...BY_COUNT, dir: 'asc' })
    assert.deepEqual(names(layout.rest), ['Bees', 'Fluff', 'Angst'])
  })

  test('sorts by the result count when asked', () => {
    const layout = layoutFacetRows(rows(['Fluff', 3, 1], ['Angst', 5, 0], ['Bees', 3, 2]), selection(), { ...BY_COUNT, sort: 'result' })
    assert.deepEqual(names(layout.rest), ['Bees', 'Fluff', 'Angst'])
  })

  test('sorts by name either way', () => {
    const list = rows(['Fluff', 3], ['angst', 5], ['Bees', 1])
    assert.deepEqual(names(layoutFacetRows(list, selection(), { query: '', sort: 'name', dir: 'asc' }).rest), ['angst', 'Bees', 'Fluff'])
    assert.deepEqual(names(layoutFacetRows(list, selection(), { query: '', sort: 'name', dir: 'desc' }).rest), ['Fluff', 'Bees', 'angst'])
  })
})

/** `n` rows `Tag 1` … `Tag n`, whose name order is their number's; `count(i)` and `result(i)` give each one's counts. */
function tags(n, count = () => 1, result = count) {
  return rows(...Array.from({ length: n }, (_, k) => [`Tag ${k + 1}`, count(k + 1), result(k + 1)]))
}
const tag = i => `Tag ${i}`
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => tag(from + k))

describe('layoutFacetRows: the cap on unselected rows', () => {
  const N = FACET_ROW_CAP + 5

  test('keeps the values with the most works, and counts the rest as left out', () => {
    const layout = layoutFacetRows(tags(N, i => i), selection(), BY_COUNT)
    assert.deepEqual(names(layout.rest), range(6, N).reverse())
    assert.equal(layout.shown, FACET_ROW_CAP)
    assert.equal(layout.matching, N)
    assert.equal(layout.leftOut, 5)
  })

  test('keeps the values with the fewest works when sorted that way round', () => {
    const layout = layoutFacetRows(tags(N, i => i), selection(), { ...BY_COUNT, dir: 'asc' })
    assert.deepEqual(names(layout.rest), range(1, FACET_ROW_CAP))
    assert.equal(layout.leftOut, 5)
  })

  test('keeps the values with the most results when sorted by the result count', () => {
    const layout = layoutFacetRows(tags(N, i => i, i => N - i), selection(), { ...BY_COUNT, sort: 'result' })
    assert.deepEqual(names(layout.rest), range(1, FACET_ROW_CAP))
    assert.equal(layout.leftOut, 5)
  })

  test('keeps the first values by name, either way round', () => {
    const list = tags(N, i => i)
    const az = layoutFacetRows(list, selection(), { query: '', sort: 'name', dir: 'asc' })
    assert.deepEqual(names(az.rest), range(1, FACET_ROW_CAP))
    const za = layoutFacetRows(list, selection(), { query: '', sort: 'name', dir: 'desc' })
    assert.deepEqual(names(za.rest), range(6, N).reverse())
    assert.equal(za.leftOut, 5)
  })

  test('shows a selected value past the cap in its section, and it takes no place under the cap', () => {
    const layout = layoutFacetRows(
      tags(N, i => N + 1 - i),
      selection({ include: [tag(N)], exclude: [tag(N - 1)], require: [tag(1)] }),
      BY_COUNT,
    )
    assert.deepEqual(names(layout.sections.include), [tag(N)])
    assert.deepEqual(names(layout.sections.exclude), [tag(N - 1)])
    assert.deepEqual(names(layout.sections.require), [tag(1)])
    assert.deepEqual(names(layout.rest), range(2, FACET_ROW_CAP + 1))
    assert.equal(layout.shown, FACET_ROW_CAP + 3)
    assert.equal(layout.matching, N)
    assert.equal(layout.leftOut, 2)
  })

  test('the value filter applies before the cap, so it finds a value the cap left out', () => {
    const list = tags(N, i => N + 1 - i)
    assert.ok(!names(layoutFacetRows(list, selection(), BY_COUNT).rest).includes(tag(N)))
    const layout = layoutFacetRows(list, selection(), { ...BY_COUNT, query: tag(N) })
    assert.deepEqual(names(layout.rest), [tag(N)])
    assert.equal(layout.matching, 1)
    assert.equal(layout.leftOut, 0)
  })

  test('the cap counts only the values the filter matches', () => {
    const list = rows(
      ...tags(FACET_ROW_CAP + 2).map(r => [r.value, 1]),
      ...Array.from({ length: 10 }, (_, k) => [`Other ${k}`, 9]),
    )
    const layout = layoutFacetRows(list, selection(), { ...BY_COUNT, query: 'tag' })
    assert.equal(layout.rest.length, FACET_ROW_CAP)
    assert.ok(layout.rest.every(r => r.value.startsWith('Tag')))
    assert.equal(layout.matching, FACET_ROW_CAP + 2)
    assert.equal(layout.leftOut, 2)
  })

  test('exactly the cap leaves nothing out', () => {
    const layout = layoutFacetRows(tags(FACET_ROW_CAP), selection(), BY_COUNT)
    assert.equal(layout.rest.length, FACET_ROW_CAP)
    assert.equal(layout.matching, FACET_ROW_CAP)
    assert.equal(layout.leftOut, 0)
  })

  test('one past the cap leaves the last one out', () => {
    const layout = layoutFacetRows(tags(FACET_ROW_CAP + 1), selection(), BY_COUNT)
    assert.deepEqual(names(layout.rest), range(1, FACET_ROW_CAP))
    assert.equal(layout.matching, FACET_ROW_CAP + 1)
    assert.equal(layout.leftOut, 1)
  })

  test('below the cap everything shows', () => {
    const layout = layoutFacetRows(tags(FACET_ROW_CAP - 1), selection(), BY_COUNT)
    assert.equal(layout.rest.length, FACET_ROW_CAP - 1)
    assert.equal(layout.leftOut, 0)
  })

  test('an unselected value with no works left counts toward nothing', () => {
    const layout = layoutFacetRows(tags(FACET_ROW_CAP + 5, i => i > FACET_ROW_CAP ? 0 : 1), selection(), BY_COUNT)
    assert.equal(layout.rest.length, FACET_ROW_CAP)
    assert.ok(layout.rest.every(r => r.count > 0))
    assert.equal(layout.matching, FACET_ROW_CAP)
    assert.equal(layout.leftOut, 0)
    assert.equal(layout.relevant, FACET_ROW_CAP)
  })
})

describe('leftOutNote', () => {
  test('says nothing when nothing is left out', () => {
    assert.equal(leftOutNote({ shown: 3, matching: 3, leftOut: 0 }), null)
  })

  test('says how many show of how many, numbers grouped', () => {
    const note = leftOutNote({ shown: FACET_ROW_CAP, matching: 4012, leftOut: 4012 - FACET_ROW_CAP })
    assert.ok(mentions(note, groupCountText(4012)), note)
    assert.deepEqual(figures(note), [FACET_ROW_CAP, 4012])
  })
})

describe('groupCountText', () => {
  test('groups the digits the way the left-out line does', () => {
    assert.equal(groupCountText(4012), (4012).toLocaleString())
    const note = leftOutNote({ shown: FACET_ROW_CAP, matching: 4012, leftOut: 4012 - FACET_ROW_CAP })
    assert.ok(mentions(note, groupCountText(4012)), note)
  })

  test('leaves a small count as it is', () => {
    assert.equal(groupCountText(7), '7')
  })
})
