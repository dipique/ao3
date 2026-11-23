import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { skip, startOptions, until } from './optionsPage.mjs'

const ROW = 'auto-exclude-hidden'

/**
 * The minimum priority under "Exclude hidden works from the search": a stepper
 * that opens with the switch, starts at the shipped default, and stores what it
 * is stepped to. Which rules it holds back is the rules module's to test.
 */
describe('options UI — minimum priority for excluding hidden works', { skip }, () => {
  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({ seed: { 'option.autoExcludeHidden': true }, hash: `#${ROW}` })
  }, { timeout: 180000 })

  after(() => session?.close())

  test('starts at 0 and stores each step', async () => {
    const row = await options.row(ROW)
    assert.equal(await (await options.control(row, 'spinbutton')).evaluate(el => el.value), '0')
    // The stepper steps as the pointer goes down, so it is pressed with the pointer.
    await (await options.action(row, 'increment')).click()
    await (await options.action(row, 'increment')).click()
    await until('the minimum to be written', async () => await options.stored('option.autoExcludeMinPriority') === 2)
    await (await options.action(row, 'decrement')).click()
    await until('the minimum to be written again', async () => await options.stored('option.autoExcludeMinPriority') === 1)
  })

  test('no page errors along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})
