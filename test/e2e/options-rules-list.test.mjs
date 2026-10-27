import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { ruleTargetLabel } from '../../src/common/data.ts'
import { rulePriorityCell } from '../../src/options_ui/model/listView.ts'
import { figures, mentions, skip, startOptions, until } from './optionsPage.mjs'

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
  const editor = () => page.evaluate(() => document.querySelector('[role="dialog"] [data-rule-field="value"]')?.value ?? null)

  /** Close the editor, and wait for the focus to land back on the page. */
  const closeEditor = async () => {
    await options.closeDialog()
    await page.waitForFunction(() => document.activeElement !== document.body)
  }

  const focused = handle => handle.evaluate(el => el === document.activeElement)

  test('each row is the rule\'s action, priority, text with its matcher, what it applies to, Edit and Remove', async () => {
    /** The row shows the rule's action and matcher by their glyphs, and says its priority, text and target. */
    const shows = async (at, glyphs, ...facts) => {
      const handle = await row(at)
      for (const glyph of glyphs)
        assert.ok(await handle.$(glyph), `row ${at} draws ${glyph}`)
      const text = await options.text(handle)
      for (const fact of [rulePriorityCell(RULES[at]).title, RULES[at].value, ruleTargetLabel(RULES[at].target), ...facts])
        assert.ok(mentions(text, fact), `row ${at} says ${fact}: ${text}`)
    }
    await shows(0, ['[i-mdi-arrow-collapse-vertical]', '[i-codicon-symbol-string]'], RULES[0].pseud)
    await shows(1, ['[i-tabler-eye-exclamation]', '[i-codicon-whole-word]'])
    await shows(4, ['[i-tabler-eye-off]', '[i-codicon-symbol-string]'])
    await shows(5, ['[i-mdi-tag-off]', '[i-codicon-regex]'])
    for (const at of [0, 2]) {
      await options.action(await row(at), 'edit')
      await options.action(await row(at), 'remove')
    }
  })

  test('a highlight rule has no priority to show, and its star is in its colour', async () => {
    const highlight = await row(2)
    assert.ok(mentions(await options.text(highlight), rulePriorityCell(RULES[2]).title))
    const star = await highlight.$('[i-mdi-star]')
    assert.deepEqual(await options.colour(star), [124, 58, 237])
  })

  test('a disabled rule\'s row fades its glyphs and controls to 48%, and draws its words in the text colour at 57%', async () => {
    /** How much of the element its own and its ancestors' opacity leave drawn. */
    const opacity = handle => handle.evaluate((el) => {
      let left = 1
      for (let at = el; at; at = at.parentElement)
        left *= Number(getComputedStyle(at).opacity)
      return Math.round(left * 100) / 100
    })
    /** Each piece of text the row draws, as `{ text, opacity, colour }`. */
    const words = handle => handle.evaluate((row) => {
      const drawn = []
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const el = node.parentElement
        if (!node.textContent.trim() || el.closest('.sr-only'))
          continue
        let left = 1
        for (let at = el; at; at = at.parentElement)
          left *= Number(getComputedStyle(at).opacity)
        drawn.push({ text: node.textContent.trim(), opacity: Math.round(left * 100) / 100, colour: getComputedStyle(el).color })
      }
      return drawn
    })
    const [r, g, b] = await options.token('default-fg')

    const off = await row(3)
    for (const glyph of ['[i-mdi-cancel]', '[i-codicon-symbol-string]'])
      assert.equal(await opacity(await off.$(glyph)), 0.48, `the ${glyph} glyph fades`)
    for (const action of ['edit', 'remove'])
      assert.equal(await opacity(await options.action(off, action)), 0.48, `${action} fades`)
    const quiet = { opacity: 1, colour: `rgba(${r}, ${g}, ${b}, 0.57)` }
    const drawn = [rulePriorityCell(RULES[3]).text, RULES[3].value, ruleTargetLabel(RULES[3].target)]
    assert.deepEqual(await words(off), drawn.map(text => ({ text, ...quiet })))

    const on = await row(0)
    assert.equal(await opacity(await on.$('[i-mdi-arrow-collapse-vertical]')), 1)
    assert.equal(await opacity(await options.action(on, 'edit')), 1)
    assert.ok((await words(on)).every(word => word.opacity === 1 && word.colour !== quiet.colour), 'a rule that acts is drawn whole')
  })

  test('Edit opens the editor on that rule, and the focus comes back to it', async () => {
    const edit = await options.action(await row(2), 'edit')
    await edit.click()
    await page.waitForSelector('[role="dialog"]')
    assert.equal(await editor(), 'Fluff')
    await closeEditor()
    assert.ok(await focused(edit))
  })

  test('Add opens a blank editor, and the focus comes back to Add however it was clicked', async () => {
    // Pressed the way a click that doesn't focus its button presses it
    // (Safari's, Firefox's on macOS), after another row's Edit had the focus.
    const add = await options.action(await options.list(LIST), 'add')
    await options.openDialog(add)
    assert.equal(await editor(), '')
    await closeEditor()
    assert.ok(await focused(add))
  })

  test('Remove takes the rule out of storage', async () => {
    await options.press(await options.action(await row(3), 'remove'))
    await until('the rules to be written', async () => await options.lastWrite('option.rules') !== null)
    const stored = await options.lastWrite('option.rules')
    assert.deepEqual(stored.filters.map(rule => rule.value), RULES.filter((_, at) => at !== 3).map(rule => rule.value))
    assert.equal((await options.listRowIds(LIST)).length, RULES.length - 1)
    assert.deepEqual(figures(await options.listCount(LIST)), [RULES.length - 1])
  })

  test('renders without console errors', () => {
    assert.deepEqual(options.problems(), [])
  })

  test('with no rules, the frame says so in the rows\' place', async () => {
    const empty = await session.open({ seed: { 'option.rules': { enabled: true, filters: [], colors: {} } }, hash: HASH })
    try {
      assert.deepEqual(figures(await empty.listCount(LIST)), [], 'nothing to count')
      assert.deepEqual(await empty.listRowIds(LIST), [])
      assert.ok(await (await empty.list(LIST)).$('[data-list-empty]'), 'the empty state shows')
      assert.deepEqual(empty.problems(), [])
    }
    finally {
      await empty.close()
    }
  })

  /** Where a row's rule text and what it applies to are drawn, by their tops and bottoms. */
  const places = view => view.listRow(LIST, 4).then(handle => handle.evaluate((el, texts) => {
    const deepest = text => [...el.querySelectorAll('*')].filter(node => node.textContent.trim() === text).at(-1).getBoundingClientRect()
    const value = deepest(texts.value)
    const target = deepest(texts.target)
    return { value: { top: value.top, bottom: value.bottom }, target: { top: target.top } }
  }, { value: RULES[4].value, target: ruleTargetLabel(RULES[4].target) }))

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
