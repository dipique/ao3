import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { armedAt, CONFIRM_MS, DISARMED, press } from '../../src/options_ui/model/confirmInPlace.ts'

const T = 1_000_000

describe('confirm-in-place', () => {
  test('arms for five seconds', () => {
    assert.equal(CONFIRM_MS, 5000)
  })

  test('a first press arms the control and does nothing else', () => {
    const { state, fire } = press(DISARMED, 'purge', T)
    assert.equal(fire, false)
    assert.deepEqual(state, { armed: 'purge', until: T + CONFIRM_MS })
    assert.equal(armedAt(state, T), 'purge')
  })

  test('a second press while armed fires, and disarms', () => {
    const armed = press(DISARMED, 'purge', T).state
    const { state, fire } = press(armed, 'purge', T + CONFIRM_MS - 1)
    assert.equal(fire, true)
    assert.deepEqual(state, DISARMED)
    assert.equal(armedAt(state, T + CONFIRM_MS - 1), null)
  })

  test('an armed control reverts after five seconds, and a press then only arms it again', () => {
    const armed = press(DISARMED, 'purge', T).state
    assert.equal(armedAt(armed, T + CONFIRM_MS - 1), 'purge')
    assert.equal(armedAt(armed, T + CONFIRM_MS), null)

    const { state, fire } = press(armed, 'purge', T + CONFIRM_MS)
    assert.equal(fire, false)
    assert.deepEqual(state, { armed: 'purge', until: T + 2 * CONFIRM_MS })
  })

  test('one armed control per page: arming another disarms the first, firing neither', () => {
    const first = press(DISARMED, 'purge', T).state
    const { state, fire } = press(first, 'orphans', T + 100)
    assert.equal(fire, false)
    assert.equal(armedAt(state, T + 100), 'orphans')

    const back = press(state, 'purge', T + 200)
    assert.equal(back.fire, false, 'the first has to be pressed twice again')
    assert.equal(armedAt(back.state, T + 200), 'purge')
  })

  test('leaves the state it was given alone', () => {
    const armed = press(DISARMED, 'purge', T).state
    const copy = { ...armed }
    press(armed, 'purge', T + 1)
    press(armed, 'orphans', T + 1)
    assert.deepEqual(armed, copy)
    assert.deepEqual(DISARMED, { armed: null, until: 0 })
  })
})
