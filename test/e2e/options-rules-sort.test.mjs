import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { ensureBuilt, findChrome, installMock, serveDist, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/**
 * Four rules, each column deliberately ordering them differently, so no single
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

/**
 * Default: grouped by target, then value — what "sort off" must return to. Note
 * this pre-existing grouping compares the *raw* target code (`author`, `f`, `F`,
 * `series`), not the label, which is why Fandom lands between Author and
 * Additional Tags. Sorting the column explicitly uses the label instead.
 */
const DEFAULT_ORDER = ['Mango', 'apple', 'Zebra', 'banana']

describe('options UI — rules sorting', { skip }, () => {
  let server
  let browser
  let page
  const consoleMsgs = []

  before(async () => {
    ensureBuilt()
    server = await serveDist()
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })
    page = await browser.newPage()
    await page.evaluateOnNewDocument(installMock, SEED)
    page.on('console', m => consoleMsgs.push({ type: m.type(), text: m.text() }))
    page.on('pageerror', e => consoleMsgs.push({ type: 'pageerror', text: e.message }))
    await page.goto(`${server.url}/options_ui/options_ui.html`, { waitUntil: 'networkidle2' })
    await sleep(1200)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
    await server?.close()
  })

  /** The rules table — its `id` prop never reaches the DOM, so go via a header. */
  const TABLE = '[id^="rules-filters-header-"]'

  /** Rule text of every rendered row, in render order. */
  const order = () => page.evaluate((sel) => {
    const table = document.querySelector(sel)?.closest('table')
    return [...table.querySelectorAll('th[scope="row"] pre')]
      .map(el => (el.firstChild?.textContent ?? el.textContent).trim())
  }, TABLE)

  /** Click the header whose column id is `id`. */
  const clickHeader = async (id) => {
    await page.evaluate((columnId) => {
      const th = document.querySelector(`#rules-filters-header-${columnId}`)
      const button = th.querySelector('button')
      button.click()
    }, id)
    await sleep(250)
  }

  /** `aria-sort` on that column's header cell. */
  const ariaSort = id => page.evaluate(columnId =>
    document.querySelector(`#rules-filters-header-${columnId}`).getAttribute('aria-sort'), id)

  test('every sortable column has a header, and the Action one is an icon', async () => {
    const headers = await page.evaluate(() =>
      ['behavior', 'priority', 'value', 'target', 'actions'].map((id) => {
        const th = document.querySelector(`#rules-filters-header-${id}`)
        return th
          ? { id, text: th.textContent.replace(/\s+/g, ' ').trim(), sortable: !!th.querySelector('button[title]') }
          : { id, missing: true }
      }))
    // The Action column had no header at all before — the Rule header's
    // colspan=2 was standing in for it.
    assert.deepEqual(headers.map(h => h.id), ['behavior', 'priority', 'value', 'target', 'actions'])
    assert.ok(headers.every(h => !h.missing), JSON.stringify(headers))
    assert.equal(headers[0].text, 'Action', 'the icon carries an accessible name')
    assert.deepEqual(headers.map(h => h.sortable), [true, true, true, true, false])
  })

  test('the header row and the body rows have the same number of cells', async () => {
    // Handing the span back from the Rule header is only correct if the counts
    // still line up.
    const counts = await page.evaluate((sel) => {
      const table = document.querySelector(sel).closest('table')
      const span = ths => ths.reduce((n, th) => n + (Number(th.getAttribute('colspan')) || 1), 0)
      const headerRow = table.querySelector('thead tr') ?? table.rows[0]
      const bodyRow = [...table.rows].find(r => r !== headerRow)
      return { header: span([...headerRow.cells]), body: span([...bodyRow.cells]) }
    }, TABLE)
    assert.equal(counts.header, counts.body, JSON.stringify(counts))
  })

  test('it starts unsorted, grouped by target then value', async () => {
    assert.deepEqual(await order(), DEFAULT_ORDER)
    assert.equal(await ariaSort('value'), 'none')
  })

  test('clicking Rule sorts by text, ignoring case', async () => {
    await clickHeader('value')
    assert.deepEqual(await order(), ['apple', 'banana', 'Mango', 'Zebra'])
    assert.equal(await ariaSort('value'), 'ascending')
  })

  test('clicking it again reverses', async () => {
    await clickHeader('value')
    assert.deepEqual(await order(), ['Zebra', 'Mango', 'banana', 'apple'])
    assert.equal(await ariaSort('value'), 'descending')
  })

  test('a third click turns sorting off, back to the default grouping', async () => {
    await clickHeader('value')
    assert.deepEqual(await order(), DEFAULT_ORDER)
    assert.equal(await ariaSort('value'), 'none')
  })

  test('Priority sorts numerically, both ways', async () => {
    await clickHeader('priority')
    assert.deepEqual(await order(), ['Zebra', 'banana', 'apple', 'Mango'])
    await clickHeader('priority')
    assert.deepEqual(await order(), ['Mango', 'apple', 'banana', 'Zebra'])
    await clickHeader('priority')
  })

  test('Applies to sorts by the label shown, not the stored target', async () => {
    // Stored targets are 'F', 'f', 'author', 'series' — sorting those raw would
    // put 'F' first. By label it is Additional Tags, Author, Fandom, Series.
    await clickHeader('target')
    assert.deepEqual(await order(), ['Zebra', 'Mango', 'apple', 'banana'])
    await clickHeader('target')
    assert.deepEqual(await order(), ['banana', 'apple', 'Mango', 'Zebra'])
    await clickHeader('target')
  })

  test('Action sorts by effect: hide, show, highlight, hide-tag', async () => {
    await clickHeader('behavior')
    assert.deepEqual(await order(), ['Zebra', 'apple', 'Mango', 'banana'])
    await clickHeader('behavior')
    assert.deepEqual(await order(), ['banana', 'Mango', 'apple', 'Zebra'])
    await clickHeader('behavior')
  })

  test('sorting one column clears the sort on another', async () => {
    await clickHeader('value')
    await clickHeader('priority')
    assert.equal(await ariaSort('value'), 'none')
    assert.equal(await ariaSort('priority'), 'ascending')
    await clickHeader('priority')
    await clickHeader('priority')
  })

  test('sorting and the search filter compose', async () => {
    await page.type('input[aria-label="Search rules by text"]', 'an')
    await sleep(300)
    await clickHeader('value')
    const sorted = await order()
    await clickHeader('value')
    const reversed = await order()
    await page.click('button[aria-label="Clear rule search"]')
    await clickHeader('value')
    await sleep(250)

    // Only Mango and banana contain "an" — the sort has to run over what the
    // filter left, not over the whole list.
    assert.deepEqual(sorted, ['banana', 'Mango'])
    assert.deepEqual(reversed, ['Mango', 'banana'])
  })

  test('renders without console errors', () => {
    const bad = consoleMsgs.filter(m => m.type === 'error' || m.type === 'pageerror')
    assert.deepEqual(bad.map(m => m.text), [])
  })
})
