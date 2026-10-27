import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { NOT_A_WORD_COUNT, RANGE_REPEATED, rangeError } from '../../src/common/wordCount.ts'
import { figures, mentions, skip, startOptions, until } from './optionsPage.mjs'

const SEED = {
  'option.wordCountToolbar': { enabled: true, ranges: [{ from: 1000, to: 3000 }] },
  'option.searchWordCount': { enabled: true, from: 2000, to: 40000 },
}

/** The Word count menu's ranges, and the Default word count row. */
const RANGES = 'word-count-ranges'
const DEFAULT_ROW = 'filter-defaults-default-word-count'

/**
 * The two word-count rows in the options UI. Both edit their bounds as text and
 * only write a range back once it is valid, so what's tested here is the gate:
 * a bad range must reach the user as an error and must never reach storage.
 */
describe('options UI — word count ranges', { skip }, () => {
  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({ seed: SEED, hash: '#filter-defaults' })
  }, { timeout: 180000 })

  after(() => session?.close())

  /** Every bound of the menu's ranges, in order. */
  const rangeInputs = async () => options.controls(await options.list(RANGES), 'textbox')

  /** The default's two bounds. */
  const defaultInputs = async () => options.controls(await options.row(DEFAULT_ROW), 'textbox')

  /** The lines saying why a range can't be saved: one in each row that can't be. */
  const rangeErrors = async () => Promise.all((await (await options.list(RANGES)).$$('[data-list-error]')).map(line => options.text(line)))

  const defaultErrors = async () => Promise.all((await (await options.row(DEFAULT_ROW)).$$('[data-error]')).map(line => options.text(line)))

  /** Each of `lines` gives `reason`, and there are `count` of them. */
  const give = (lines, reason, count = 1) => {
    assert.equal(lines.length, count, JSON.stringify(lines))
    for (const line of lines)
      assert.ok(mentions(line, reason), `${line} gives ${reason}`)
  }

  /**
   * Replace a bound's text by typing. The field is brought to the middle of the
   * window first: at the bottom, the "Options saved" toasts can be sitting
   * over it, and a range added from the header is scrolled to just above the
   * window's bottom edge.
   */
  const retype = async (input, value) => {
    await input.evaluate(el => window.scrollBy({ top: el.getBoundingClientRect().top - window.innerHeight / 2, behavior: 'instant' }))
    await input.click({ clickCount: 3 })
    await options.page.keyboard.press('Backspace')
    if (value)
      await input.type(value)
    await options.saved()
  }

  test('loads the saved ranges into the editor, a frame headed by its count', async () => {
    assert.equal(await options.listCount(RANGES), '1')
    const inputs = await rangeInputs()
    assert.equal(inputs.length, 2, 'one row of two bounds')
    assert.equal(await inputs[0].evaluate(el => el.value), '1000')
    assert.equal(await inputs[1].evaluate(el => el.value), '3000')
  })

  test('adding a range from the header writes it once both bounds are set', async () => {
    await options.press(await options.action(await options.list(RANGES), 'add'))
    await until('the range to be added', async () => (await options.listRows(RANGES)).length === 2)
    assert.equal(await options.listCount(RANGES), '2')
    const inputs = await rangeInputs()
    assert.equal(inputs.length, 4)
    await retype(inputs[2], '8000')
    await retype(inputs[3], '20000')
    assert.deepEqual(await options.lastWrite('option.wordCountToolbar'), {
      enabled: true,
      ranges: [{ from: 1000, to: 3000 }, { from: 8000, to: 20000 }],
    })
  })

  test('an upside-down range is refused, not saved', async () => {
    const inputs = await rangeInputs()
    await retype(inputs[3], '10')
    give(await rangeErrors(), rangeError({ from: 8000, to: 10 }))
    // Clearing the box on the way through is itself a valid (open-ended) range,
    // so a write may well have happened — what must never be stored is the
    // upside-down range now on screen.
    const stored = await options.lastWrite('option.wordCountToolbar')
    assert.ok(
      !stored.ranges.some(r => r.from === 8000 && r.to === 10),
      `invalid range reached storage: ${JSON.stringify(stored.ranges)}`,
    )
  })

  test('a duplicate range is refused, not saved', async () => {
    const inputs = await rangeInputs()
    await retype(inputs[2], '1000')
    await retype(inputs[3], '3000')
    // Both rows are now the same, so both are flagged.
    give(await rangeErrors(), RANGE_REPEATED, 2)
    // As above, intermediate valid states may have been written; the duplicated
    // list itself must not have been.
    const stored = await options.lastWrite('option.wordCountToolbar')
    const repeats = stored.ranges.filter(r => r.from === 1000 && r.to === 3000)
    assert.equal(repeats.length, 1, `duplicate reached storage: ${JSON.stringify(stored.ranges)}`)
  })

  test('an overlapping (but distinct) range is accepted', async () => {
    const inputs = await rangeInputs()
    await retype(inputs[3], '2500')
    assert.deepEqual(await rangeErrors(), [])
    assert.deepEqual(await options.lastWrite('option.wordCountToolbar'), {
      enabled: true,
      ranges: [{ from: 1000, to: 3000 }, { from: 1000, to: 2500 }],
    })
  })

  test('removing a range writes the shortened list', async () => {
    const last = (await options.listRows(RANGES)).at(-1)
    await options.press(await options.action(last, 'remove'))
    await options.saved()
    assert.deepEqual(await options.lastWrite('option.wordCountToolbar'), {
      enabled: true,
      ranges: [{ from: 1000, to: 3000 }],
    })
    assert.equal(await options.listCount(RANGES), '1')
  })

  test('with every range removed, the frame says so in place, and its header still adds one', async () => {
    const [row] = await options.listRows(RANGES)
    await options.press(await options.action(row, 'remove'))
    await options.saved()
    assert.deepEqual(await options.lastWrite('option.wordCountToolbar'), { enabled: true, ranges: [] })
    assert.deepEqual(await options.listRows(RANGES), [])
    assert.deepEqual(figures(await options.listCount(RANGES)), [], 'nothing to count')
    const empty = async () => !!(await (await options.list(RANGES)).$('[data-list-empty]'))
    assert.ok(await empty(), 'the empty state shows')

    await options.press(await options.action(await options.list(RANGES), 'add'))
    await until('the range to be added', async () => (await options.listRows(RANGES)).length > 0)
    assert.equal((await options.listRows(RANGES)).length, 1)
    assert.equal((await rangeInputs()).length, 2)
    assert.equal(await empty(), false, 'the empty state goes')
  })

  test('the default range loads, and blanking a bound makes it one-sided', async () => {
    const inputs = await defaultInputs()
    assert.equal(await inputs[0].evaluate(el => el.value), '2000')
    assert.equal(await inputs[1].evaluate(el => el.value), '40000')
    await retype(inputs[1], '')
    assert.deepEqual(await options.lastWrite('option.searchWordCount'), { enabled: true, from: 2000, to: null })
  })

  test('a negative default bound is refused, not saved', async () => {
    const before = await options.lastWrite('option.searchWordCount')
    const inputs = await defaultInputs()
    await retype(inputs[0], '-5')
    give(await defaultErrors(), NOT_A_WORD_COUNT)
    assert.deepEqual(await options.lastWrite('option.searchWordCount'), before)
  })

  test('no page errors along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})
