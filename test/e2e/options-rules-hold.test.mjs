import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { skip, startOptions, stubArchive, until } from './optionsPage.mjs'
import { RuleEditor, RULES_LIST } from './ruleEditor.mjs'

/** Twelve rules alike but for their text, so the list's own order is theirs by text, and the list scrolls past its cap. */
const RULES = Array.from({ length: 12 }, (_, i) => ({ target: 'tag', value: `rule ${String(i + 1).padStart(2, '0')}`, matcher: 'exact' }))

const SEED = { 'option.rules': { enabled: true, filters: RULES, colors: {} } }

/**
 * The rules list as rules are edited down it: opening a rule holds the order
 * the rows are in, so an edited rule stays in its row, until Re-sort or a
 * change of the filter or sort lets go; and the list lifted over the page, as
 * tall as the window, until it is put back.
 *
 * Where a rule goes in a held order is `shownRules`' and `keepOrder`'s
 * business, tested case by case in `test/options/listView.test.mjs`; here,
 * that the list holds and lets go, and draws the result.
 */
describe('options UI — rules list holds its order while editing', { skip }, () => {
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

  /** Each drawn row's rule text, in the order drawn, by the rules as stored now. */
  const order = async () => {
    const { filters } = await options.stored('option.rules')
    return (await options.listRowIds(RULES_LIST)).map(at => filters[Number(at)].value)
  }

  const list = () => options.list(RULES_LIST)
  const resort = async () => (await list()).$('[data-action="resort"]')

  /** Open the rule `from` from its row's Edit, give it the text `to`, and save it. */
  const retext = async (from, to) => {
    assert.ok(await rules.openEdit(from))
    await rules.retype('value', to)
    await rules.save()
  }

  test('a rule edited so it sorts elsewhere stays in its row, and Re-sort shows', async () => {
    assert.equal(await resort(), null, 'nothing to re-sort before an edit')
    await retext('rule 01', 'rule 99')
    assert.deepEqual((await order()).slice(0, 3), ['rule 99', 'rule 02', 'rule 03'])
    assert.ok(await resort())
  })

  test('the rows hold through the next edit', async () => {
    await retext('rule 05', 'rule 00')
    assert.deepEqual((await order()).slice(0, 5), ['rule 99', 'rule 02', 'rule 03', 'rule 04', 'rule 00'])
  })

  test('removing a rule leaves the others where they are', async () => {
    await options.press(await options.action(await rules.row('rule 03'), 'remove'))
    await options.saved()
    assert.deepEqual((await order()).slice(0, 4), ['rule 99', 'rule 02', 'rule 04', 'rule 00'])
  })

  test('Re-sort puts the rows in sorted order again, and goes', async () => {
    await options.press(await resort())
    await until('Re-sort to go', async () => await resort() === null)
    const shown = await order()
    assert.equal(shown[0], 'rule 00')
    assert.equal(shown.at(-1), 'rule 99')
  })

  test('typing in the search lets go of a held order', async () => {
    await retext('rule 02', 'rule 98')
    assert.ok(await resort())
    const filter = await (await list()).$('[data-list-filter]')
    await filter.type('rule')
    await until('Re-sort to go', async () => await resort() === null)
    assert.deepEqual((await order()).slice(-2), ['rule 98', 'rule 99'])
    await filter.evaluate(el => el.select())
    await page.keyboard.press('Backspace')
  })

  /**
   * Boxes in the window: the frame, its body, the space holding its place
   * while it is lifted, and what comes after the frame's place; and whether
   * the page's own content (marked before the first lift) can be reached.
   */
  const boxes = () => page.evaluate((id) => {
    const frame = document.querySelector(`[data-list="${id}"]`)
    const spot = document.querySelector('[data-list-spot]')
    const box = el => el && (({ top, bottom, left, width, height }) => ({ top, bottom, left, width, height }))(el.getBoundingClientRect())
    return {
      frame: box(frame),
      body: frame.querySelector('[data-list-body]').clientHeight,
      spot: box(spot),
      next: box((spot ?? frame).nextElementSibling),
      expanded: frame.dataset.expanded !== undefined,
      inert: document.querySelector('[data-test-page]').inert,
      scrollY: window.scrollY,
    }
  }, RULES_LIST)

  const toggle = async () => options.action(await list(), 'expand')
  /**
   * Whether `handle` is drawn over whatever `under` picks, at the handle's
   * middle: of everything drawn there, the first that is either is the
   * handle's. The page behind a lifted list is inert, which takes it out of
   * what is found at a point, so it is let back in for the look.
   */
  const drawnOver = (handle, under) => handle.evaluate((el, selector) => {
    const page = document.querySelector('[data-test-page]')
    page.inert = false
    const { left, top, width, height } = el.getBoundingClientRect()
    const first = document.elementsFromPoint(left + width / 2, top + height / 2)
      .find(at => el.contains(at) || at.closest(selector))
    page.inert = true
    return !!first && el.contains(first)
  }, under)
  const expanded = () => page.evaluate(id => document.querySelector(`[data-list="${id}"]`).dataset.expanded !== undefined, RULES_LIST)
  const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 1, `${message}: ${actual} against ${expected}`)

  let inPlace

  test('Expand lifts the list over the page, as tall as the window, in its own column, with the focus on its button', async () => {
    await page.evaluate(id => document.querySelector(`[data-list="${id}"]`).closest('body > *').dataset.testPage = '', RULES_LIST)
    inPlace = await boxes()
    assert.equal(inPlace.expanded, false)

    await options.press(await toggle())
    await until('the list to expand', expanded)
    await options.calm()
    const lifted = await boxes()
    const { height } = page.viewport()
    near(lifted.frame.top, 16, 'top margin')
    near(lifted.frame.bottom, height - 16, 'bottom margin')
    near(lifted.frame.left, inPlace.frame.left, 'left edge')
    near(lifted.frame.width, inPlace.frame.width, 'width')
    assert.ok(lifted.body > inPlace.body, `the rows get the room: ${lifted.body} against ${inPlace.body}`)
    assert.ok(await (await toggle()).evaluate(el => el === document.activeElement), 'the focus is on the button')
    assert.ok(await drawnOver(await toggle(), '[data-test-page]'), 'the header is drawn over the page, its top bar too')
  })

  test('the page behind holds still: its place is kept, it can\'t be reached, and a wheel over it scrolls nothing', async () => {
    const lifted = await boxes()
    near(lifted.spot.height, inPlace.frame.height, 'the space holding its place')
    near(lifted.next.top, inPlace.next.top, 'what comes after it')
    assert.equal(lifted.inert, true)
    await page.mouse.move(4, 300)
    await page.mouse.wheel({ deltaY: 600 })
    await options.frame()
    assert.equal((await boxes()).scrollY, lifted.scrollY)
  })

  test('a rule edited while expanded is saved, and the list stays expanded with its rows held', async () => {
    assert.ok(await rules.openEdit('rule 06'))
    await rules.retype('value', 'rule 97')
    assert.ok(await drawnOver(await rules.saveButton(), `[data-list="${RULES_LIST}"]`), 'the editor is drawn over the list')
    await options.press(await rules.saveButton())
    await page.waitForFunction(() => !document.querySelector('[role="dialog"] [data-rule-field]'))
    await options.saved()
    assert.ok((await rules.written('rule 97')), 'stored')
    assert.equal(await expanded(), true)
    assert.ok(await resort(), 'the rows are held')
    assert.ok(await page.evaluate(id => document.querySelector(`[data-list="${id}"]`).contains(document.activeElement), RULES_LIST), 'the focus is back in the list')
  })

  test('Escape puts the list back, with the focus on its button, and the page as it was', async () => {
    await page.keyboard.press('Escape')
    await until('the list to go back', async () => !await expanded())
    const back = await boxes()
    assert.equal(back.inert, false)
    near(back.frame.top, inPlace.frame.top, 'the list is where it was')
    near(back.next.top, inPlace.next.top, 'what comes after it')
    assert.ok(await (await toggle()).evaluate(el => el === document.activeElement), 'the focus is on the button')
  })

  test('a press on the dimmed page puts it back too', async () => {
    await options.press(await toggle())
    await until('the list to expand', expanded)
    await options.press(await page.$('[data-list-scrim]'))
    await until('the list to go back', async () => !await expanded())
    assert.equal((await boxes()).inert, false)
  })

  test('renders without console errors', () => {
    assert.deepEqual(options.problems(), [])
  })
})
