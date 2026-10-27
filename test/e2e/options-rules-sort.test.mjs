import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { RULE_SORTS, sortHint, UNSORTED } from '../../src/options_ui/model/listView.ts'
import { skip, startOptions } from './optionsPage.mjs'

/**
 * Four rules, each key deliberately ordering them differently, so no single
 * expected order could be produced by sorting on the wrong key. Targets are real
 * `RuleTarget` values — fandom is TagType `'f'`, not the string "fandom".
 *
 * | value  | target label    | behavior   | priority |
 * | Zebra  | Additional Tags | hide       | 0        |
 * | apple  | Fandom          | invert     | 4        |
 * | Mango  | Author          | highlight  | 7        |
 * | banana | Series          | hideFilter | 2        |
 */
const RULES = [
  { target: 'F', value: 'Zebra', matcher: 'exact', behavior: 'hide' },
  { target: 'f', value: 'apple', matcher: 'exact', behavior: 'invert' },
  { target: 'author', value: 'Mango', matcher: 'exact', behavior: 'highlight', priority: 7 },
  { target: 'series', value: 'banana', matcher: 'exact', behavior: 'hideFilter', priority: 2 },
]

const SEED = { 'option.rules': { enabled: true, filters: RULES, colors: {} } }

const LIST = 'rules'

/**
 * Default: grouped by target, then value — what "sort off" must return to. Note
 * this grouping compares the *raw* target code (`author`, `f`, `F`, `series`),
 * not the label, which is why Fandom lands between Author and Additional Tags.
 * Sorting by Applies to uses the label instead.
 */
const DEFAULT_ORDER = ['Mango', 'apple', 'Zebra', 'banana']

/**
 * The rules list's sort: a menu in the list's header of the four keys, each
 * press of which steps the sort on; the menu button and each key say where the
 * sort is in `aria-sort`'s terms, and nothing of it is stored.
 */
describe('options UI — rules sorting', { skip }, () => {
  let session
  let options
  let page

  before(async () => {
    session = await startOptions()
    options = await session.open({ seed: SEED, hash: '#customize-search-results' })
    page = options.page
  }, { timeout: 180000 })

  after(() => session?.close())

  /** Rule text of every rendered row, in render order. Each row is the rule at that place in the stored list. */
  const order = async () => (await options.listRowIds(LIST)).map(at => RULES[Number(at)].value)

  /** The sort in the list's header. */
  const sortButton = async () => options.action(await options.list(LIST), 'sort')
  /** Where the sort is, as the button says: the key it sorts by, or null, and which way, in `aria-sort`'s terms. */
  const sorted = async () => (await sortButton()).evaluate(el => ({ key: el.dataset.sort ?? null, state: el.dataset.sortState }))
  const UNSORTED_STATE = { key: null, state: 'none' }

  const closeMenu = async () => {
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[role="menuitem"]'))
  }

  /** The menu's keys, as `{ key, state, hint }`: what each sorts by, where it is in its cycle, and what pressing it does. */
  const menu = async () => {
    await options.press(await sortButton())
    await page.waitForSelector('[role="menuitem"]')
    const items = await page.$$eval('[role="menuitem"]', els => els.map(el => ({
      key: el.dataset.sort,
      state: el.dataset.sortState,
      hint: el.title,
    })))
    await closeMenu()
    return items
  }

  /**
   * Press the key that sorts by `key` in the sort's menu, `times` times over,
   * then close the menu. Each press is waited out by where the key says it is
   * in its cycle, which changes with every press.
   */
  const press = async (key, times = 1) => {
    await options.press(await sortButton())
    await page.waitForSelector('[role="menuitem"]')
    const item = () => page.$(`[role="menuitem"][data-sort="${key}"]`)
    for (let i = 0; i < times; i++) {
      const before = await (await item()).evaluate(el => el.dataset.sortState)
      await (await item()).evaluate(el => el.click())
      await page.waitForFunction((k, was) => document.querySelector(`[role="menuitem"][data-sort="${k}"]`)?.dataset.sortState !== was, {}, key, before)
    }
    await closeMenu()
  }

  test('the menu offers the four keys, Action first, none of them sorting yet: the list is in its default grouping', async () => {
    const items = await menu()
    assert.deepEqual(items.map(item => item.key), RULE_SORTS.map(choice => choice.value))
    assert.ok(items.every(item => item.state === 'none'), JSON.stringify(items))
    assert.ok(items.every(item => item.hint === sortHint(UNSORTED, item.key)), JSON.stringify(items))
    assert.deepEqual(await order(), DEFAULT_ORDER)
    assert.deepEqual(await sorted(), UNSORTED_STATE)
  })

  test('pressing a key sorts the rows by it, and the button and the key say so', async () => {
    // How each key orders, and what each press of it does next, is `shownRules`'
    // and `cycleSort`'s business, tested case by case in
    // `test/options/listView.test.mjs`; here, that the menu reaches them and the
    // list and its labels show the result.
    await press('value')
    assert.deepEqual(await order(), ['apple', 'banana', 'Mango', 'Zebra'])
    assert.deepEqual(await sorted(), { key: 'value', state: 'ascending' })
    const rule = (await menu()).find(item => item.key === 'value')
    assert.deepEqual(rule, { key: 'value', state: 'ascending', hint: sortHint({ key: 'value', direction: 'asc' }, 'value') })
  })

  test('the menu stays open, so the cycle can be stepped through at once: two more presses and the sort is off', async () => {
    await press('value', 2)
    assert.deepEqual(await order(), DEFAULT_ORDER)
    assert.deepEqual(await sorted(), UNSORTED_STATE)
  })

  test('sorting writes nothing, and a reload starts unsorted', async () => {
    await press('priority')
    await options.saved()
    assert.equal(await options.lastWrite('option.rules'), null)
    await options.reload()
    assert.deepEqual(await sorted(), UNSORTED_STATE)
    assert.deepEqual(await order(), DEFAULT_ORDER)
  })

  test('renders without console errors', () => {
    assert.deepEqual(options.problems(), [])
  })
})
