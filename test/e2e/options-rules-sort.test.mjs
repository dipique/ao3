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
 * The rules list's sort: a menu in the list's header of the four keys. Each
 * press of a key sorts by it ascending, then descending, then not at all; the
 * menu button and each key say where the sort is in `aria-sort`'s terms.
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

  test('the menu offers the four keys, Action first, none of them sorting yet', async () => {
    const items = await menu()
    assert.deepEqual(items.map(item => item.text), ['Action', 'Priority', 'Rule', 'Applies to'])
    assert.deepEqual(items.map(item => item.name), ['Action', 'Priority', 'Rule', 'Applies to'])
    assert.ok(items.every(item => item.hint === 'Sort ascending'), JSON.stringify(items))
  })

  test('it starts unsorted, grouped by target then value', async () => {
    assert.deepEqual(await order(), DEFAULT_ORDER)
    assert.equal(await sortName(), 'Sort: none')
  })

  test('pressing Rule sorts by text, ignoring case', async () => {
    await press('Rule')
    assert.deepEqual(await order(), ['apple', 'banana', 'Mango', 'Zebra'])
    assert.equal(await sortName(), 'Sort: Rule, ascending')
    const rule = (await menu()).find(item => item.text === 'Rule')
    assert.deepEqual(rule, { text: 'Rule', name: 'Rule, sorted ascending', hint: 'Sort descending' })
  })

  test('pressing it again reverses', async () => {
    await press('Rule')
    assert.deepEqual(await order(), ['Zebra', 'Mango', 'banana', 'apple'])
    assert.equal(await sortName(), 'Sort: Rule, descending')
    const rule = (await menu()).find(item => item.text === 'Rule')
    assert.deepEqual(rule, { text: 'Rule', name: 'Rule, sorted descending', hint: 'Clear sort' })
  })

  test('a third press turns sorting off, back to the default grouping', async () => {
    await press('Rule')
    assert.deepEqual(await order(), DEFAULT_ORDER)
    assert.equal(await sortName(), 'Sort: none')
  })

  test('the menu stays open, so the cycle can be stepped through at once', async () => {
    await press('Rule', 2)
    assert.equal(await sortName(), 'Sort: Rule, descending')
    await press('Rule')
    assert.equal(await sortName(), 'Sort: none')
  })

  test('Priority sorts numerically, both ways, with the rules that show none after, in the list\'s own order', async () => {
    await press('Priority')
    assert.deepEqual(await order(), ['Zebra', 'apple', 'Mango', 'banana'])
    await press('Priority')
    assert.deepEqual(await order(), ['apple', 'Zebra', 'Mango', 'banana'])
    await press('Priority')
  })

  test('Applies to sorts by the label shown, not the stored target', async () => {
    // Stored targets are 'F', 'f', 'author', 'series' — sorting those raw would
    // put 'F' first. By label it is Additional Tags, Author, Fandom, Series.
    await press('Applies to')
    assert.deepEqual(await order(), ['Zebra', 'Mango', 'apple', 'banana'])
    await press('Applies to')
    assert.deepEqual(await order(), ['banana', 'apple', 'Mango', 'Zebra'])
    await press('Applies to')
  })

  test('Action sorts by effect: hide, show, highlight, hide-tag', async () => {
    await press('Action')
    assert.deepEqual(await order(), ['Zebra', 'apple', 'Mango', 'banana'])
    await press('Action')
    assert.deepEqual(await order(), ['banana', 'Mango', 'apple', 'Zebra'])
    await press('Action')
  })

  test('sorting by one key clears the sort by another', async () => {
    await press('Rule')
    await press('Priority')
    const items = await menu()
    assert.deepEqual(items.map(item => item.name), ['Action', 'Priority, sorted ascending', 'Rule', 'Applies to'])
    assert.equal(await sortName(), 'Sort: Priority, ascending')
    await press('Priority', 2)
  })

  test('sorting and the filter compose', async () => {
    const search = await options.control(await options.list(LIST), 'textbox', 'Search rules by text')
    await search.type('an')
    await page.waitForFunction(el => el.value === 'an', {}, search)
    await press('Rule')
    const sorted = await order()
    await press('Rule')
    const reversed = await order()
    await (await options.control(await options.list(LIST), 'button', 'Clear rule search')).click()
    await press('Rule')

    // Only Mango and banana contain "an" — the sort has to run over what the
    // filter left, not over the whole list.
    assert.deepEqual(sorted, ['banana', 'Mango'])
    assert.deepEqual(reversed, ['Mango', 'banana'])
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
