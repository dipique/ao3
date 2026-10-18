import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { planChildren } from '../../src/content_script/searchView/childOrder.ts'

/** Carry a plan out over `current` the way the DOM would: removals, then each insertion in turn. */
function apply(current, { remove, insert }) {
  const children = current.filter(node => !remove.includes(node))
  for (const { node, before } of insert) {
    const at = children.indexOf(node)
    if (at !== -1)
      children.splice(at, 1)
    children.splice(before === null ? children.length : children.indexOf(before), 0, node)
  }
  return children
}

function check(current, desired) {
  const plan = planChildren(current, desired)
  assert.deepEqual(apply(current, plan), desired)
  return plan
}

const letters = s => [...s]

describe('planChildren', () => {
  test('touches nothing when the children are already in order', () => {
    const plan = check(letters('abcde'), letters('abcde'))
    assert.deepEqual(plan, { remove: [], insert: [] })
  })

  test('fills an empty parent in order', () => {
    const plan = check([], letters('abc'))
    assert.equal(plan.insert.length, 3)
  })

  test('empties a parent by removing, never inserting', () => {
    const plan = check(letters('abc'), [])
    assert.deepEqual(plan, { remove: letters('abc'), insert: [] })
  })

  test('moves only the one child that changed place', () => {
    const plan = check(letters('abcdef'), letters('abdecf'))
    assert.deepEqual(plan.remove, [])
    assert.deepEqual(plan.insert.map(op => op.node), ['c'])
  })

  test('moves a child to the very end', () => {
    const plan = check(letters('abcd'), letters('bcda'))
    assert.deepEqual(plan.insert, [{ node: 'a', before: null }])
  })

  test('keeps the longest run already in order and moves the rest', () => {
    // a, c, d, f keep their order; b and e move.
    const plan = check(letters('abcdef'), letters('aecdbf'))
    assert.deepEqual(plan.insert.map(op => op.node).sort(), ['b', 'e'])
  })

  test('reverses with all but one moved', () => {
    const plan = check(letters('abcdef'), letters('fedcba'))
    assert.equal(plan.insert.length, 5)
  })

  test('removes what is no longer wanted and inserts what is new, keeping the rest put', () => {
    const plan = check(letters('abcdef'), letters('axcyf'))
    assert.deepEqual(plan.remove, letters('bde'))
    assert.deepEqual(plan.insert.map(op => op.node).sort(), ['x', 'y'])
  })

  test('agrees with a brute-force minimum over every order of a few children', () => {
    const items = letters('abcde')
    for (const desired of permutations(items)) {
      const plan = check(items, desired)
      assert.equal(plan.insert.length, items.length - longestInOrder(items, desired), desired.join(''))
    }
  })
})

/** Length of the longest subsequence of `desired` that `current` also holds in that order. */
function longestInOrder(current, desired) {
  const at = desired.filter(x => current.includes(x)).map(x => current.indexOf(x))
  const best = at.map(() => 1)
  for (let i = 0; i < at.length; i++) {
    for (let j = 0; j < i; j++) {
      if (at[j] < at[i])
        best[i] = Math.max(best[i], best[j] + 1)
    }
  }
  return Math.max(0, ...best)
}

function* permutations(items) {
  if (items.length <= 1) {
    yield items
    return
  }
  for (const [i, item] of items.entries()) {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)]))
      yield [item, ...rest]
  }
}
