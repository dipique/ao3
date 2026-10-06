import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { dependentState } from '../../src/options_ui/model/masterGroup.ts'

const MASTER = 'Right-click menus'

describe('dependentState', () => {
  test('with the master on, its dependents are live and show their descriptions', () => {
    assert.deepEqual(dependentState({ title: MASTER, on: true }, false), { inert: false, reason: null, folded: false })
    assert.deepEqual(dependentState({ title: MASTER, on: true }, true), { inert: false, reason: null, folded: false })
  })

  test('with the master off, they are inert, say why by the master\'s name, and fold their descriptions away', () => {
    assert.deepEqual(dependentState({ title: MASTER, on: false }, false), {
      inert: true,
      reason: 'Off while Right-click menus is off',
      folded: true,
    })
  })

  test('a settings search unfolds them, so a hit in a description is in sight', () => {
    assert.deepEqual(dependentState({ title: MASTER, on: false }, true), {
      inert: true,
      reason: 'Off while Right-click menus is off',
      folded: false,
    })
  })
})
