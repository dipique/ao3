import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

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

  /** The sort in the list's header, named for the sort the list shows. */
  const sortButton = async () => options.control(await options.list(LIST), 'button', /^Sort: /)
  const sortName = async () => options.name(await sortButton())

  const closeMenu = async () => {
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[role="menuitem"]'))
  }

  /** The menu's keys, as `{ text, name, hint }`: what each shows, what it is called, and what pressing it does. */
  const menu = async () => {
    await options.press(await sortButton())
    await page.waitForSelector('[role="menuitem"]')
    const items = await page.$$eval('[role="menuitem"]', els => els.map(el => ({
      text: el.textContent.trim(),
      name: el.getAttribute('aria-label'),
      hint: el.title,
    })))
    await closeMenu()
    return items
  }

  /**
   * Press the key so labelled in the sort's menu, `times` times over, then
   * close the menu. Each press is waited out by the key's name, which says
   * where the sort is, and changes with every press of a three-way cycle.
   */
  const press = async (label, times = 1) => {
    await options.press(await sortButton())
    await page.waitForSelector('[role="menuitem"]')
    const item = () => page.evaluateHandle(text => [...document.querySelectorAll('[role="menuitem"]')]
      .find(el => el.textContent.trim() === text), label)
    for (let i = 0; i < times; i++) {
      const before = await (await item()).evaluate(el => el.getAttribute('aria-label'))
      await (await item()).evaluate(el => el.click())
      await page.waitForFunction((text, was) => [...document.querySelectorAll('[role="menuitem"]')]
        .find(el => el.textContent.trim() === text)
        ?.getAttribute('aria-label') !== was, {}, label, before)
    }
    await closeMenu()
  }

  test('the menu offers the four keys, Action first, none of them sorting yet: the list is in its default grouping', async () => {
    const items = await menu()
    assert.deepEqual(items.map(item => item.text), ['Action', 'Priority', 'Rule', 'Applies to'])
    assert.deepEqual(items.map(item => item.name), ['Action', 'Priority', 'Rule', 'Applies to'])
    assert.ok(items.every(item => item.hint === 'Sort ascending'), JSON.stringify(items))
    assert.deepEqual(await order(), DEFAULT_ORDER)
    assert.equal(await sortName(), 'Sort: none')
  })

  test('pressing a key sorts the rows by it, and the button and the key say so', async () => {
    // How each key orders, and what each press of it does next, is `shownRules`'
    // and `cycleSort`'s business, tested case by case in
    // `test/options/listView.test.mjs`; here, that the menu reaches them and the
    // list and its labels show the result.
    await press('Rule')
    assert.deepEqual(await order(), ['apple', 'banana', 'Mango', 'Zebra'])
    assert.equal(await sortName(), 'Sort: Rule, ascending')
    const rule = (await menu()).find(item => item.text === 'Rule')
    assert.deepEqual(rule, { text: 'Rule', name: 'Rule, sorted ascending', hint: 'Sort descending' })
  })

  test('the menu stays open, so the cycle can be stepped through at once: two more presses and the sort is off', async () => {
    await press('Rule', 2)
    assert.deepEqual(await order(), DEFAULT_ORDER)
    assert.equal(await sortName(), 'Sort: none')
  })

  test('sorting writes nothing, and a reload starts unsorted', async () => {
    await press('Priority')
    await options.saved()
    assert.equal(await options.lastWrite('option.rules'), null)
    await options.reload()
    assert.equal(await sortName(), 'Sort: none')
    assert.deepEqual(await order(), DEFAULT_ORDER)
  })

  test('renders without console errors', () => {
    assert.deepEqual(options.problems(), [])
  })
})
