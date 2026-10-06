import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { sleep } from './helpers.mjs'
import { skip, startOptions } from './optionsPage.mjs'

/** One rule of each action, an author with a pseud, a priority of a rule's own, and each matcher. */
const RULES = [
  { target: 'author', value: 'someone', pseud: 'sideblog', matcher: 'exact', behavior: 'collapse' },
  { target: 'R', value: 'Steve Rogers/', matcher: 'contains', behavior: 'invert' },
  { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'highlight', color: '#7c3aed' },
  { target: 'tag', value: 'Dead Dove: Do Not Eat', matcher: 'exact', behavior: 'none' },
  { target: 'w', value: 'Major Character Death', matcher: 'exact', priority: 6 },
  { target: 'C', value: '^(Original|OC)\\b', matcher: 'regex', behavior: 'hideFilter' },
]

const SEED = { 'option.rules': { enabled: true, filters: RULES, colors: {} } }
const HASH = '#customize-search-results'
const LIST = 'rules'

/**
 * The rules list's rows: what each says about its rule, the rule's Edit and
 * Remove, and the frame's Add and empty state. Each row is the rule at that
 * place in the stored list.
 */
describe('options UI — rules list', { skip }, () => {
  let session
  let options
  let page

  before(async () => {
    session = await startOptions()
    options = await session.open({ seed: SEED, hash: HASH })
    page = options.page
  }, { timeout: 180000 })

  after(() => session?.close())

  const row = at => options.listRow(LIST, at)

  /** Whether the open dialog is the rule editor, and the rule text it holds. */
  const editor = () => page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    return dialog?.querySelector('[i-codicon-regex]') ? dialog.querySelector('input[type="text"]').value : null
  })

  const closeEditor = async () => {
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    await sleep(200)
  }

  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null)

  test('each row is the rule\'s action, priority, text with its matcher, what it applies to, Edit and Remove', async () => {
    assert.match(await options.text(await row(0)), /^Collapse.*Priority 0 \(default\).*someone \(sideblog\).*Exact.*Author$/)
    assert.match(await options.text(await row(1)), /^Always show.*Priority 4 \(default\).*Steve Rogers\/.*Contains.*Relationship$/)
    assert.match(await options.text(await row(4)), /^Hide work.*Priority 6: beats lower-priority rules that match the same work.*Major Character Death.*Exact.*Archive Warning$/)
    assert.match(await options.text(await row(5)), /^Hide tag.*Hide-tag rules have no priority.*\^\(Original\|OC\)\\b.*Regex.*Character$/)
    for (const [at, value] of [[0, 'someone'], [2, 'Fluff']]) {
      await options.control(await row(at), 'button', `Edit rule “${value}”`)
      await options.control(await row(at), 'button', `Remove rule “${value}”`)
    }
  })

  test('a highlight rule has no priority to show, and its star is in its colour', async () => {
    const highlight = await row(2)
    assert.match(await options.text(highlight), /^Highlight.*Highlight rules have no priority: they never conflict with other rules.*Fluff/)
    const star = await highlight.$('[i-mdi-star]')
    assert.deepEqual(await options.colour(star), [124, 58, 237])
  })

  test('a disabled rule\'s row drops to 48%', async () => {
    assert.equal(await (await row(3)).evaluate(el => getComputedStyle(el).opacity), '0.48')
    assert.equal(await (await row(0)).evaluate(el => getComputedStyle(el).opacity), '1')
  })

  test('Edit opens the editor on that rule, and the focus comes back to it', async () => {
    await (await options.control(await row(2), 'button', 'Edit rule “Fluff”')).click()
    await sleep(400)
    assert.equal(await editor(), 'Fluff')
    await closeEditor()
    assert.equal(await focused(), 'Edit rule “Fluff”')
  })

  test('Add opens a blank editor, and the focus comes back to Add however it was clicked', async () => {
    // Pressed the way a click that doesn't focus its button presses it
    // (Safari's, Firefox's on macOS), after another row's Edit had the focus.
    await options.press(await options.control(await options.list(LIST), 'button', 'Add a rule'))
    await sleep(400)
    assert.equal(await editor(), '')
    await closeEditor()
    assert.equal(await focused(), 'Add a rule')
  })

  test('Remove takes the rule out of storage', async () => {
    await options.press(await options.control(await row(3), 'button', 'Remove rule “Dead Dove: Do Not Eat”'))
    await sleep(1000)
    const stored = await options.lastWrite('option.rules')
    assert.deepEqual(stored.filters.map(rule => rule.value), RULES.filter((_, at) => at !== 3).map(rule => rule.value))
    assert.equal((await options.listRowIds(LIST)).length, RULES.length - 1)
    assert.equal(await options.listCount(LIST), `${RULES.length - 1} rules`)
  })

  test('renders without console errors', () => {
    assert.deepEqual(options.problems(), [])
  })

  test('with no rules, the frame says so in the rows\' place', async () => {
    const empty = await session.open({ seed: { 'option.rules': { enabled: true, filters: [], colors: {} } }, hash: HASH })
    try {
      assert.equal(await empty.listCount(LIST), 'none yet')
      assert.deepEqual(await empty.listRowIds(LIST), [])
      assert.match(await empty.text(await empty.list(LIST)), /No rules yet/)
      assert.deepEqual(empty.problems(), [])
    }
    finally {
      await empty.close()
    }
  })

  /** Where a row's rule text and what it applies to are drawn, by their tops and bottoms. */
  const places = view => view.listRow(LIST, 4).then(handle => handle.evaluate((el) => {
    const deepest = text => [...el.querySelectorAll('*')].filter(node => node.textContent.trim() === text).at(-1).getBoundingClientRect()
    const value = deepest('Major Character Death')
    const target = deepest('Archive Warning')
    return { value: { top: value.top, bottom: value.bottom }, target: { top: target.top } }
  }))

  test('in a wide frame what a rule applies to is a column of its own, and in a phone\'s it goes under the text', async () => {
    const wide = await session.open({ seed: SEED, hash: HASH, viewport: { width: 1440, height: 900 } })
    const narrow = await session.open({ seed: SEED, hash: HASH, viewport: { width: 390, height: 844 } })
    try {
      const across = await places(wide)
      assert.ok(Math.abs(across.target.top - across.value.top) < 6, JSON.stringify(across))
      const under = await places(narrow)
      assert.ok(under.target.top >= under.value.bottom - 1, JSON.stringify(under))
      assert.ok(await narrow.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll')
    }
    finally {
      await wide.close()
      await narrow.close()
    }
  })
})
