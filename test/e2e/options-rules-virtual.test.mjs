import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { skip, startOptions, stubArchive, until } from './optionsPage.mjs'
import { RuleEditor, RULES_LIST } from './ruleEditor.mjs'

/** Three hundred rules alike but for their text, so the list's own order is theirs by text. */
const COUNT = 300
const RULES = Array.from({ length: COUNT }, (_, i) => ({ target: 'tag', value: `rule ${String(i).padStart(3, '0')}`, matcher: 'exact' }))

const SEED = { 'option.rules': { enabled: true, filters: RULES, colors: {} } }

/**
 * A long rules list draws only the rows near the view, and scrolls as if
 * every row were there: the body is as tall as all of them, each drawn row
 * says where it stands among them, and scrolling anywhere draws the rows
 * there. Which rows a scroll position draws is `rowWindow`'s business, tested
 * case by case in `test/options/rowWindow.test.mjs`.
 */
describe('options UI — a long rules list draws the rows in view', { skip }, () => {
  let session
  let options
  let page
  let rules

  before(async () => {
    session = await startOptions()
    // Typing a rule's text asks AO3 for tags it might be; the archive answers with none.
    options = await session.open({ seed: SEED, hash: '#customize-search-results', prepare: tab => stubArchive(tab, () => ({ json: [] })) })
    page = options.page
    rules = new RuleEditor(options)
  }, { timeout: 180000 })

  after(() => session?.close())

  /** The drawn rows: each one's stored place and its place among the shown rules. */
  const drawn = async () => (await options.list(RULES_LIST)).$$eval('[data-list-row]', els => els.map(el => ({
    at: Number(el.dataset.listRow),
    place: Number(el.getAttribute('aria-posinset')),
    size: Number(el.getAttribute('aria-setsize')),
  })))

  /** Scroll the body to `to`, a number of px or `'end'`, and wait until the rows drawn take it in. */
  const scrollTo = async (to) => {
    await page.$eval(`[data-list="${RULES_LIST}"] [data-list-body]`, (body, where) => {
      body.scrollTop = where === 'end' ? body.scrollHeight : where
    }, to)
    await options.frame()
    await options.frame()
  }

  const body = () => page.$eval(`[data-list="${RULES_LIST}"] [data-list-body]`, el => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop }))

  test('only some of the rows are drawn, the first among them, each saying where it stands', async () => {
    const rows = await drawn()
    assert.ok(rows.length > 7 && rows.length < COUNT / 3, `${rows.length} rows drawn`)
    assert.deepEqual(rows.slice(0, 3).map(row => row.place), [1, 2, 3])
    assert.ok(rows.every(row => row.size === COUNT))
    assert.ok(rows.every(row => row.at === row.place - 1), 'the list\'s own order is the stored order here')
  })

  test('the body scrolls as far as every row would take', async () => {
    const rowHeight = await page.$eval(`[data-list="${RULES_LIST}"] [data-list-row]:nth-child(2)`, el => el.getBoundingClientRect().height)
    const { scrollHeight } = await body()
    assert.ok(Math.abs(scrollHeight - COUNT * rowHeight) <= rowHeight, `${scrollHeight} against ${COUNT} rows of ${rowHeight}`)
  })

  test('scrolled to the middle, the rows there are drawn, in view', async () => {
    const { clientHeight } = await body()
    const rowHeight = await page.$eval(`[data-list="${RULES_LIST}"] [data-list-row]:nth-child(2)`, el => el.getBoundingClientRect().height)
    await scrollTo(150 * rowHeight)
    const rows = await drawn()
    const places = rows.map(row => row.place)
    const inView = Math.floor(clientHeight / rowHeight)
    for (let place = 151; place <= 151 + inView; place++)
      assert.ok(places.includes(place), `row ${place} is drawn: ${places[0]}…${places.at(-1)}`)
    assert.ok(!places.includes(1), 'the first rows are not')
    const visible = await page.$eval(`[data-list="${RULES_LIST}"] [data-list-row][aria-posinset="151"]`, (row) => {
      const body = row.closest('[data-list-body]').getBoundingClientRect()
      const { top, bottom } = row.getBoundingClientRect()
      return { ok: bottom > body.top && top < body.bottom, top: top - body.top }
    })
    assert.ok(visible.ok, `row 151 is in the body's view: ${JSON.stringify(visible)}`)
  })

  test('scrolled to the end, the last row is drawn', async () => {
    await scrollTo('end')
    assert.equal((await drawn()).at(-1).place, COUNT)
  })

  test('a rule edited far down the list is saved and stays in its row', async () => {
    const before = await drawn()
    const target = before.at(-3)
    assert.ok(await rules.openEdit(RULES[target.at].value))
    await rules.retype('value', 'aaa first by text')
    await rules.save()
    assert.ok(await rules.written('aaa first by text'))
    const row = (await drawn()).find(r => r.at === target.at)
    assert.ok(row, 'still drawn')
    assert.equal(row.place, target.place, 'in the same place')
  })

  test('expanded, the taller view draws more rows', async () => {
    await scrollTo(0)
    const inPlace = (await drawn()).length
    await options.press(await options.action(await options.list(RULES_LIST), 'expand'))
    await until('more rows to be drawn', async () => (await drawn()).length > inPlace)
    await page.keyboard.press('Escape')
  })

  test('searching draws what the search keeps, from the top', async () => {
    const filter = await (await options.list(RULES_LIST)).$('[data-list-filter]')
    await filter.type('rule 29')
    const { filters } = await options.stored('option.rules')
    const kept = filters.filter(rule => rule.value.includes('rule 29')).length
    assert.ok(kept > 0)
    await until('the search to apply', async () => (await drawn()).length === kept)
    assert.ok((await drawn()).every(row => row.size === kept))
  })

  test('renders without console errors', () => {
    assert.deepEqual(options.problems(), [])
  })
})
