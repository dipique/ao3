import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { muteRuleIds } from '../../src/content_script/mutedUsers.ts'

describe('muteRuleIds', () => {
  test('gives the user id of each class in AO3\'s mute rule', () => {
    assert.deepEqual(muteRuleIds('.user-32838, .user-233995, .user-26223151'), ['32838', '233995', '26223151'])
  })

  test('a single muted user', () => {
    assert.deepEqual(muteRuleIds('.user-32838'), ['32838'])
  })

  test('however the list is spaced', () => {
    assert.deepEqual(muteRuleIds('.user-1,.user-2 ,\n  .user-3'), ['1', '2', '3'])
  })

  test('nothing from a rule that selects anything but user classes', () => {
    assert.deepEqual(muteRuleIds('.user-1, .blurb'), [])
    assert.deepEqual(muteRuleIds('li.user-1'), [])
    assert.deepEqual(muteRuleIds('.user-1 a'), [])
    assert.deepEqual(muteRuleIds('.user-1:hover'), [])
  })

  test('nothing from a class that only looks like one', () => {
    assert.deepEqual(muteRuleIds('.user-abc'), [])
    assert.deepEqual(muteRuleIds('.users-1'), [])
    assert.deepEqual(muteRuleIds('.user-'), [])
  })

  test('nothing from an empty selector', () => {
    assert.deepEqual(muteRuleIds(''), [])
  })
})
