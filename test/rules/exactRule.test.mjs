import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  findExactRule,
  replaceExactRule,
  setExactRulePriority,
  setRulePriorityOf,
  toggleExactRule,
} from '../../src/common/data.ts'

const fandom = { target: 'f', value: 'Some Fandom' }
const rule = props => ({ ...fandom, matcher: 'exact', ...props })

describe('findExactRule', () => {
  test('finds only the exact-match rule on the same target, value and pseud', () => {
    const wanted = rule({ behavior: 'collapse' })
    const rules = [
      rule({ matcher: 'contains' }),
      rule({ target: 'tag' }),
      { target: 'author', value: 'someone', matcher: 'exact', pseud: 'alt' },
      wanted,
    ]
    assert.equal(findExactRule(rules, fandom), wanted)
    assert.equal(findExactRule(rules, { target: 'author', value: 'someone' }), undefined, 'an account key is not a pseud rule')
    assert.equal(findExactRule(rules, { target: 'author', value: 'someone', pseud: 'alt' }), rules[2])
  })
})

describe('replaceExactRule', () => {
  test('adds a rule at its behaviour\'s default priority when there was none', () => {
    assert.deepEqual(replaceExactRule([], fandom, 'hide'), [rule({ behavior: 'hide' })])
  })

  test('keeps a priority the old rule set for itself', () => {
    const next = replaceExactRule([rule({ behavior: 'hide', priority: 7 })], fandom, 'collapse')
    assert.deepEqual(next, [rule({ behavior: 'collapse', priority: 7 })])
  })

  test('a rule at its default priority takes the new behaviour\'s default', () => {
    assert.deepEqual(replaceExactRule([rule({ behavior: 'hide' })], fandom, 'invert'), [rule({ behavior: 'invert' })])
    assert.deepEqual(replaceExactRule([rule({ behavior: 'invert' })], fandom, 'hide'), [rule({ behavior: 'hide' })])
  })

  test('a kept priority that is the new behaviour\'s default is not stored', () => {
    assert.deepEqual(replaceExactRule([rule({ behavior: 'hide', priority: 4 })], fandom, 'invert'), [rule({ behavior: 'invert' })])
  })

  test('a disabled rule\'s priority comes back with the behaviour chosen for it', () => {
    assert.deepEqual(
      replaceExactRule([rule({ behavior: 'none', priority: 6 })], fandom, 'hide'),
      [rule({ behavior: 'hide', priority: 6 })],
    )
  })

  test('null removes the rule, and leaves every other rule where it was', () => {
    const others = [rule({ value: 'A' }), rule({ value: 'B' })]
    assert.deepEqual(replaceExactRule([others[0], rule({}), others[1]], fandom, null), others)
  })

  test('does not change the list it was given', () => {
    const rules = [rule({ behavior: 'hide', priority: 7 })]
    const copy = structuredClone(rules)
    replaceExactRule(rules, fandom, 'collapse')
    assert.deepEqual(rules, copy)
  })

  test('carries an author key\'s pseud onto the new rule', () => {
    const key = { target: 'author', value: 'someone', pseud: 'alt' }
    assert.deepEqual(replaceExactRule([], key, 'hide'), [{ ...key, matcher: 'exact', behavior: 'hide' }])
  })
})

describe('toggleExactRule', () => {
  test('choosing the behaviour the rule already has clears it', () => {
    assert.deepEqual(toggleExactRule([rule({ behavior: 'collapse', priority: 7 })], fandom, 'collapse'), [])
  })

  test('a rule with no behaviour is a hide, so choosing hide clears it', () => {
    assert.deepEqual(toggleExactRule([rule({})], fandom, 'hide'), [])
  })

  test('choosing another behaviour replaces it, keeping its priority', () => {
    assert.deepEqual(
      toggleExactRule([rule({ behavior: 'hide', priority: 7 })], fandom, 'collapse'),
      [rule({ behavior: 'collapse', priority: 7 })],
    )
  })
})

describe('setExactRulePriority', () => {
  test('stores a priority that differs from the behaviour\'s default', () => {
    assert.deepEqual(setExactRulePriority([rule({ behavior: 'hide' })], fandom, 5), [rule({ behavior: 'hide', priority: 5 })])
  })

  test('leaves the field out when the priority is the behaviour\'s default', () => {
    assert.deepEqual(setExactRulePriority([rule({ behavior: 'invert', priority: 9 })], fandom, 4), [rule({ behavior: 'invert' })])
    assert.deepEqual(setExactRulePriority([rule({ priority: 3 })], fandom, 0), [rule({})])
  })

  test('keeps the rule in its place in the list', () => {
    const rules = [rule({ value: 'A' }), rule({ behavior: 'collapse' }), rule({ value: 'B' })]
    const next = setExactRulePriority(rules, fandom, 2)
    assert.deepEqual(next, [rules[0], rule({ behavior: 'collapse', priority: 2 }), rules[2]])
  })

  test('clamps to the 0-9 range', () => {
    assert.deepEqual(setExactRulePriority([rule({})], fandom, 12), [rule({ priority: 9 })])
    assert.deepEqual(setExactRulePriority([rule({ behavior: 'invert' })], fandom, -1), [rule({ behavior: 'invert', priority: 0 })])
  })

  test('changes nothing when the key has no rule', () => {
    const rules = [rule({ value: 'Other' })]
    assert.deepEqual(setExactRulePriority(rules, fandom, 5), rules)
  })

  test('does not change the list it was given', () => {
    const rules = [rule({ behavior: 'hide' })]
    setExactRulePriority(rules, fandom, 5)
    assert.deepEqual(rules, [rule({ behavior: 'hide' })])
  })
})

describe('setRulePriorityOf', () => {
  const regex = { target: 'f', value: 'Soft.*', matcher: 'regex', behavior: 'collapse' }

  test('sets the priority of the stored rule equal to the one given, whatever its matcher', () => {
    const rules = [rule({}), { ...regex }, rule({ value: 'B' })]
    assert.deepEqual(setRulePriorityOf(rules, regex, 5), [rules[0], { ...regex, priority: 5 }, rules[2]])
  })

  test('a rule that differs in any field is not the one', () => {
    const rules = [{ ...regex, color: '#fff' }, { ...regex, priority: 3 }]
    assert.deepEqual(setRulePriorityOf(rules, regex, 5), rules)
  })

  test('stores the priority the way the exact-rule helpers do', () => {
    assert.deepEqual(setRulePriorityOf([{ ...regex, priority: 2 }], { ...regex, priority: 2 }, 0), [regex])
  })
})
