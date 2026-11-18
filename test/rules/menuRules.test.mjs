import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { menuChecks, menuClick } from '../../src/background/menuRules.ts'
import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'

/** The rules settings a fresh install starts with. */
const SETTINGS = OPTION_DEFAULTS.rules

const author = { target: 'author', value: 'someone' }
const rule = props => ({ ...author, matcher: 'exact', ...props })
const other = { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'hide' }

/** Behaviours the menu's two items don't write. */
const NEITHER = ['collapse', 'highlight', 'hideFilter']

describe('menuChecks', () => {
  test('no rule checks neither item', () => {
    assert.deepEqual(menuChecks([other], author), { hide: false, show: false })
  })

  test('a hide rule checks Hide, and a rule with no behaviour is a hide', () => {
    assert.deepEqual(menuChecks([rule({ behavior: 'hide' })], author), { hide: true, show: false })
    assert.deepEqual(menuChecks([rule({})], author), { hide: true, show: false })
  })

  test('an "always show" rule checks Show', () => {
    assert.deepEqual(menuChecks([rule({ behavior: 'invert' })], author), { hide: false, show: true })
  })

  for (const behavior of [...NEITHER, 'none']) {
    test(`a ${behavior} rule checks neither item`, () => {
      assert.deepEqual(menuChecks([rule({ behavior })], author), { hide: false, show: false })
    })
  }

  test('reads only the key\'s own rule: the account and a pseud are separate', () => {
    const pseud = { ...author, pseud: 'alt' }
    assert.deepEqual(menuChecks([rule({ pseud: 'alt', behavior: 'invert' })], author), { hide: false, show: false })
    assert.deepEqual(menuChecks([rule({ behavior: 'hide' })], pseud), { hide: false, show: false })
  })
})

describe('menuClick', () => {
  test('Hide with no rule adds a hide', () => {
    assert.deepEqual(menuClick([other], author, 'hide', SETTINGS), { filters: [other, rule({ behavior: 'hide' })], undone: false })
  })

  test('Show with no rule adds an "always show"', () => {
    assert.deepEqual(menuClick([], author, 'show', SETTINGS), { filters: [rule({ behavior: 'invert' })], undone: false })
  })

  test('Hide on a hide removes it', () => {
    assert.deepEqual(menuClick([other, rule({ behavior: 'hide' })], author, 'hide', SETTINGS), { filters: [other], undone: true })
    assert.deepEqual(menuClick([rule({})], author, 'hide', SETTINGS), { filters: [], undone: true })
  })

  test('Show on an "always show" removes it', () => {
    assert.deepEqual(menuClick([rule({ behavior: 'invert', priority: 8 })], author, 'show', SETTINGS), { filters: [], undone: true })
  })

  test('Hide on an "always show" replaces it, keeping a priority it set for itself', () => {
    assert.deepEqual(menuClick([rule({ behavior: 'invert', priority: 8 })], author, 'hide', SETTINGS), { filters: [rule({ behavior: 'hide', priority: 8 })], undone: false })
  })

  test('Show on a hide replaces it', () => {
    assert.deepEqual(menuClick([rule({ behavior: 'hide' })], author, 'show', SETTINGS), { filters: [rule({ behavior: 'invert' })], undone: false })
  })

  for (const behavior of NEITHER) {
    test(`Hide on a ${behavior} rule replaces it with a hide, keeping its priority`, () => {
      assert.deepEqual(menuClick([rule({ behavior, priority: 6 })], author, 'hide', SETTINGS), { filters: [rule({ behavior: 'hide', priority: 6 })], undone: false })
    })

    test(`Show on a ${behavior} rule replaces it with an "always show", keeping its priority`, () => {
      assert.deepEqual(menuClick([rule({ behavior, priority: 6 })], author, 'show', SETTINGS), { filters: [rule({ behavior: 'invert', priority: 6 })], undone: false })
    })
  }

  test('a disabled rule is no rule: either item sets its behaviour, and the priority comes back', () => {
    assert.deepEqual(menuClick([rule({ behavior: 'none', priority: 6 })], author, 'hide', SETTINGS), { filters: [rule({ behavior: 'hide', priority: 6 })], undone: false })
    assert.deepEqual(menuClick([rule({ behavior: 'none', priority: 6 })], author, 'show', SETTINGS), { filters: [rule({ behavior: 'invert', priority: 6 })], undone: false })
  })

  test('a pseud\'s item writes the pseud\'s rule and leaves the account\'s alone', () => {
    const pseud = { ...author, pseud: 'alt' }
    const account = rule({ behavior: 'hide' })
    assert.deepEqual(menuClick([account], pseud, 'hide', SETTINGS), { filters: [account, rule({ pseud: 'alt', behavior: 'hide' })], undone: false })
  })

  test('does not change the list it was given', () => {
    const rules = [rule({ behavior: 'collapse', priority: 6 })]
    const copy = structuredClone(rules)
    menuClick(rules, author, 'hide', SETTINGS)
    assert.deepEqual(rules, copy)
  })
})
