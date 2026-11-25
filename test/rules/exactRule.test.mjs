import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import {
  findExactRule,
  replaceExactRule,
  setExactRulePriority,
  setRulePriorityOf,
  toggleExactRule,
} from '../../src/common/rules.ts'

/** The rules settings a fresh install starts with. */
const SETTINGS = OPTION_DEFAULTS.rules
/** The priority an "always show" rule gets when it sets none of its own. */
const ALWAYS_SHOW = SETTINGS.alwaysShowPriority
/** The "always show" default moved one step, as a reader might set it. */
const MOVED = { alwaysShowPriority: ALWAYS_SHOW + 1 }

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
    assert.deepEqual(replaceExactRule([], fandom, 'hide', SETTINGS), [rule({ behavior: 'hide' })])
  })

  test('keeps a priority the old rule set for itself', () => {
    const next = replaceExactRule([rule({ behavior: 'hide', priority: 7 })], fandom, 'collapse', SETTINGS)
    assert.deepEqual(next, [rule({ behavior: 'collapse', priority: 7 })])
  })

  test('a rule at its default priority takes the new behaviour\'s default', () => {
    assert.deepEqual(replaceExactRule([rule({ behavior: 'hide' })], fandom, 'invert', SETTINGS), [rule({ behavior: 'invert' })])
    assert.deepEqual(replaceExactRule([rule({ behavior: 'invert' })], fandom, 'hide', SETTINGS), [rule({ behavior: 'hide' })])
  })

  test('a kept priority that is the new behaviour\'s default is not stored', () => {
    assert.deepEqual(replaceExactRule([rule({ behavior: 'hide', priority: ALWAYS_SHOW })], fandom, 'invert', SETTINGS), [rule({ behavior: 'invert' })])
  })

  test('"always show"\'s default is the one the settings give', () => {
    assert.deepEqual(replaceExactRule([rule({ behavior: 'hide', priority: MOVED.alwaysShowPriority })], fandom, 'invert', MOVED), [rule({ behavior: 'invert' })])
    assert.deepEqual(
      replaceExactRule([rule({ behavior: 'hide', priority: ALWAYS_SHOW })], fandom, 'invert', MOVED),
      [rule({ behavior: 'invert', priority: ALWAYS_SHOW })],
      'a priority that is no longer the default is kept',
    )
  })

  test('a disabled rule\'s priority comes back with the behaviour chosen for it', () => {
    assert.deepEqual(
      replaceExactRule([rule({ behavior: 'none', priority: 6 })], fandom, 'hide', SETTINGS),
      [rule({ behavior: 'hide', priority: 6 })],
    )
  })

  test('null removes the rule, and leaves every other rule where it was', () => {
    const others = [rule({ value: 'A' }), rule({ value: 'B' })]
    assert.deepEqual(replaceExactRule([others[0], rule({}), others[1]], fandom, null, SETTINGS), others)
  })

  test('does not change the list it was given', () => {
    const rules = [rule({ behavior: 'hide', priority: 7 })]
    const copy = structuredClone(rules)
    replaceExactRule(rules, fandom, 'collapse', SETTINGS)
    assert.deepEqual(rules, copy)
  })

  test('carries an author key\'s pseud onto the new rule', () => {
    const key = { target: 'author', value: 'someone', pseud: 'alt' }
    assert.deepEqual(replaceExactRule([], key, 'hide', SETTINGS), [{ ...key, matcher: 'exact', behavior: 'hide' }])
  })

  test('a priority given takes the place of the old rule\'s', () => {
    assert.deepEqual(replaceExactRule([rule({ behavior: 'hide', priority: 7 })], fandom, 'collapse', SETTINGS, 2), [rule({ behavior: 'collapse', priority: 2 })])
    assert.deepEqual(replaceExactRule([], fandom, 'invert', SETTINGS, 9), [rule({ behavior: 'invert', priority: 9 })])
  })

  test('a priority given that is the new behaviour\'s default is not stored', () => {
    assert.deepEqual(replaceExactRule([rule({ behavior: 'hide', priority: 7 })], fandom, 'invert', SETTINGS, ALWAYS_SHOW), [rule({ behavior: 'invert' })])
    assert.deepEqual(replaceExactRule([rule({ behavior: 'invert' })], fandom, 'hide', SETTINGS, 0), [rule({ behavior: 'hide' })])
  })

  test('a priority given is clamped to the 0-9 range', () => {
    assert.deepEqual(replaceExactRule([], fandom, 'hide', SETTINGS, 12), [rule({ behavior: 'hide', priority: 9 })])
  })
})

describe('toggleExactRule', () => {
  test('choosing the behaviour the rule already has clears it', () => {
    assert.deepEqual(toggleExactRule([rule({ behavior: 'collapse', priority: 7 })], fandom, 'collapse', SETTINGS), [])
  })

  test('a rule with no behaviour is a hide, so choosing hide clears it', () => {
    assert.deepEqual(toggleExactRule([rule({})], fandom, 'hide', SETTINGS), [])
  })

  test('choosing another behaviour replaces it, keeping its priority', () => {
    assert.deepEqual(
      toggleExactRule([rule({ behavior: 'hide', priority: 7 })], fandom, 'collapse', SETTINGS),
      [rule({ behavior: 'collapse', priority: 7 })],
    )
  })
})

describe('setExactRulePriority', () => {
  test('stores a priority that differs from the behaviour\'s default', () => {
    assert.deepEqual(setExactRulePriority([rule({ behavior: 'hide' })], fandom, 5, SETTINGS), [rule({ behavior: 'hide', priority: 5 })])
  })

  test('leaves the field out when the priority is the behaviour\'s default', () => {
    assert.deepEqual(setExactRulePriority([rule({ behavior: 'invert', priority: 9 })], fandom, ALWAYS_SHOW, SETTINGS), [rule({ behavior: 'invert' })])
    assert.deepEqual(setExactRulePriority([rule({ priority: 3 })], fandom, 0, SETTINGS), [rule({})])
  })

  test('an "always show" set to the settings\' default stores none, and to the shipped one stores it', () => {
    assert.deepEqual(setExactRulePriority([rule({ behavior: 'invert' })], fandom, MOVED.alwaysShowPriority, MOVED), [rule({ behavior: 'invert' })])
    assert.deepEqual(setExactRulePriority([rule({ behavior: 'invert' })], fandom, ALWAYS_SHOW, MOVED), [rule({ behavior: 'invert', priority: ALWAYS_SHOW })])
  })

  test('keeps the rule in its place in the list', () => {
    const rules = [rule({ value: 'A' }), rule({ behavior: 'collapse' }), rule({ value: 'B' })]
    const next = setExactRulePriority(rules, fandom, 2, SETTINGS)
    assert.deepEqual(next, [rules[0], rule({ behavior: 'collapse', priority: 2 }), rules[2]])
  })

  test('clamps to the 0-9 range', () => {
    assert.deepEqual(setExactRulePriority([rule({})], fandom, 12, SETTINGS), [rule({ priority: 9 })])
    assert.deepEqual(setExactRulePriority([rule({ behavior: 'invert' })], fandom, -1, SETTINGS), [rule({ behavior: 'invert', priority: 0 })])
  })

  test('changes nothing when the key has no rule', () => {
    const rules = [rule({ value: 'Other' })]
    assert.deepEqual(setExactRulePriority(rules, fandom, 5, SETTINGS), rules)
  })

  test('does not change the list it was given', () => {
    const rules = [rule({ behavior: 'hide' })]
    setExactRulePriority(rules, fandom, 5, SETTINGS)
    assert.deepEqual(rules, [rule({ behavior: 'hide' })])
  })
})

describe('setRulePriorityOf', () => {
  const regex = { target: 'f', value: 'Soft.*', matcher: 'regex', behavior: 'collapse' }

  test('sets the priority of the stored rule equal to the one given, whatever its matcher', () => {
    const rules = [rule({}), { ...regex }, rule({ value: 'B' })]
    assert.deepEqual(setRulePriorityOf(rules, regex, 5, SETTINGS), [rules[0], { ...regex, priority: 5 }, rules[2]])
  })

  test('a rule that differs in any field is not the one', () => {
    const rules = [{ ...regex, color: '#fff' }, { ...regex, priority: 3 }]
    assert.deepEqual(setRulePriorityOf(rules, regex, 5, SETTINGS), rules)
  })

  test('stores the priority the way the exact-rule helpers do', () => {
    assert.deepEqual(setRulePriorityOf([{ ...regex, priority: 2 }], { ...regex, priority: 2 }, 0, SETTINGS), [regex])
  })
})
