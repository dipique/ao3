import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { figures, mentions, skip, startOptions } from './optionsPage.mjs'

/** A few rules, two of them sharing a word for the filter to find. */
const RULES = [
  { target: 'tag', value: 'Slow Burn', matcher: 'exact', behavior: 'hide' },
  { target: 'tag', value: 'slow build', matcher: 'exact', behavior: 'hide' },
  { target: 'tag', value: 'Enemies to Lovers', matcher: 'exact', behavior: 'hide' },
  { target: 'f', value: 'Teen Wolf (TV)', matcher: 'exact', behavior: 'hide' },
  { target: 'author', value: 'someone', pseud: 'BurnNotice', matcher: 'exact', behavior: 'hide' },
]

const SEED = { 'option.rules': { enabled: true, filters: RULES, colors: {} } }

const LIST = 'rules'

/**
 * Filtering the rules list from the filter in its header: the field drives
 * the filter, and the list shows what it leaves, says so when that is nothing,
 * and comes back whole when the field is cleared.
 */
describe('options UI — rules filter', { skip }, () => {
  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({ seed: SEED, hash: '#customize-search-results' })
  }, { timeout: 180000 })

  after(() => session?.close())

  const filterBox = async () => (await options.list(LIST)).$('[data-list-filter]')

  /** Type `text` into the filter (replacing whatever is there), and wait until the filter holds it. */
  const filter = async (text) => {
    const box = await filterBox()
    await box.click({ clickCount: 3 })
    await options.page.keyboard.press('Backspace')
    if (text)
      await box.type(text)
    await options.page.waitForFunction((el, value) => el.value === value, {}, box, text)
  }

  /** The text of every rule the list is showing. Each row is the rule at that place in the stored list. */
  const rows = async () => (await options.listRowIds(LIST)).map(at => RULES[Number(at)].value)

  /** The numbers the header's count gives. */
  const counted = async () => figures(await options.listCount(LIST))

  test('the field drives the filter: typing narrows the rows, and the header counts what is showing', async () => {
    await filter('')
    const all = await rows()
    assert.equal(all.length, RULES.length, all.join(' | '))
    assert.deepEqual(await counted(), [RULES.length])

    // What the filter matches is `shownRules`' business, tested case by case in
    // `test/options/listView.test.mjs`; here, that the field reaches it and
    // the list shows what it leaves.
    await filter('slow')
    const listed = await rows()
    const count = await counted()
    await filter('')
    assert.deepEqual(listed.sort(), ['Slow Burn', 'slow build'])
    assert.deepEqual(count, [2, RULES.length], 'what is showing, of how many')
  })

  test('no matches says so in the list\'s place', async () => {
    await filter('zzzzz')
    const listed = await rows()
    const empty = await (await options.list(LIST)).$('[data-list-empty]')
    const text = empty && await options.text(empty)
    await filter('')
    assert.deepEqual(listed, [])
    assert.ok(text && mentions(text, 'zzzzz'), 'an empty result explains itself, with what was searched for')
  })

  test('clearing the filter brings the whole list back, and keeps the focus in it', async () => {
    await filter('slow')
    await (await options.action(await options.list(LIST), 'clear')).click()
    const box = await filterBox()
    await options.page.waitForFunction(el => el.value === '', {}, box)
    const listed = await rows()
    assert.equal(await box.evaluate(el => el.value), '')
    assert.equal(listed.length, RULES.length)
    assert.equal(await box.evaluate(el => el === document.activeElement), true, 'the clear button went, so the field has the focus')
  })

  test('filtering writes nothing', async () => {
    await filter('slow')
    await filter('')
    await options.saved()
    assert.equal(await options.lastWrite('option.rules'), null)
  })

  test('renders without console errors', () => {
    assert.deepEqual(options.problems(), [])
  })
})
