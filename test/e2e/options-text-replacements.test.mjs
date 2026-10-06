import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { sleep } from './helpers.mjs'
import { skip, startOptions } from './optionsPage.mjs'

const LIST = 'text-replacements'
const KEY = 'option.textReplacements'
const HASH = '#work-text'

/** Each icon toggle by its accessible name, and the flag it edits. */
const TOGGLES = {
  'Case sensitive': 'caseSensitive',
  'Match casing': 'matchCasing',
  'Whole word': 'wholeWord',
  'Match across formatting': 'acrossFormatting',
  'Disable this replacement': 'disabled',
}

const CASING_OFF = 'Off while Case sensitive is on'

/**
 * A mix of on and off in every flag, so a flag lost, flipped or read from the
 * wrong rule shows. The third rule is disabled, and case sensitive with
 * Match casing still on.
 */
const RULES = [
  { find: 'Y/N', replace: 'Alex', caseSensitive: false, matchCasing: false, wholeWord: true, acrossFormatting: true, disabled: false },
  { find: 'chuckled darkly', replace: 'laughed', caseSensitive: false, matchCasing: true, wholeWord: false, acrossFormatting: false, disabled: false },
  { find: 'orbs', replace: 'eyes', caseSensitive: true, matchCasing: true, wholeWord: true, acrossFormatting: false, disabled: true },
]

const seed = (rules = RULES) => ({ [KEY]: { enabled: true, tools: false, rules } })

/**
 * Text replacements in the list pattern: one row per rule, find → replace, its
 * five flags as icon toggles, and Remove; Add in the frame's header; and the
 * Editing tools switch above the list. What's checked is what each control
 * stores.
 */
describe('options UI — text replacements', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  const open = (rules, viewport) => session.open({ seed: seed(rules), hash: HASH, viewport })

  const toggle = async (options, index, name) => options.control(await options.listRow(LIST, index), 'button', name)
  const pressed = async handle => handle.evaluate(el => el.getAttribute('aria-pressed') === 'true')

  /** What a row shows: its two fields and whether each toggle is on, by flag. */
  const shown = async (options, index) => {
    const row = await options.listRow(LIST, index)
    const flags = {}
    for (const [name, flag] of Object.entries(TOGGLES))
      flags[flag] = await pressed(await options.control(row, 'button', name))
    return {
      find: await (await options.control(row, 'textbox', 'Find')).evaluate(el => el.value),
      replace: await (await options.control(row, 'textbox', 'Replace with')).evaluate(el => el.value),
      ...flags,
    }
  }

  test('the rules load into a frame headed by its title and count, under the Editing tools switch', async () => {
    const options = await open()
    try {
      const list = await options.list(LIST)
      assert.equal(await options.name(list), 'Text replacements')
      assert.equal(await options.listCount(LIST), '3')
      assert.deepEqual(await options.listRowIds(LIST), ['0', '1', '2'])
      for (const [index, rule] of RULES.entries())
        assert.deepEqual(await shown(options, index), rule, `row ${index}`)

      const tools = await options.control(await options.row('work-text-text-replacement'), 'switch', /^Editing tools on the work page/)
      assert.ok(
        await tools.evaluate((el, frame) => !!(el.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING), list),
        'the switch comes before the list',
      )
      await options.press(tools)
      await sleep(500)
      assert.deepEqual(await options.lastWrite(KEY), { ...seed()[KEY], tools: true })
    }
    finally {
      await options.close()
    }
  })

  test('each toggle writes its own flag on its own rule, and nothing else', async () => {
    const options = await open()
    try {
      const expected = structuredClone(RULES)
      // Match casing before Case sensitive, which would leave it inert.
      for (const name of ['Match casing', 'Whole word', 'Match across formatting', 'Disable this replacement', 'Case sensitive']) {
        const flag = TOGGLES[name]
        await options.press(await toggle(options, 0, name))
        await sleep(500)
        expected[0][flag] = !expected[0][flag]
        assert.deepEqual((await options.lastWrite(KEY)).rules, expected, `after ${name}`)
        assert.equal(await pressed(await toggle(options, 0, name)), expected[0][flag], `${name} shows its new state`)
      }
      assert.deepEqual(options.problems(), [])
    }
    finally {
      await options.close()
    }
  })

  test('Match casing is inert while Case sensitive is on, says why, and keeps its value', async () => {
    const options = await open()
    try {
      const casing = await toggle(options, 2, 'Match casing')
      assert.equal(await casing.evaluate(el => el.disabled), true, 'inert')
      assert.equal(await pressed(casing), true, 'still showing the stored value')
      assert.equal(await options.description(casing), CASING_OFF)
      await options.press(casing)
      await sleep(500)
      assert.equal(await options.lastWrite(KEY), null, 'an inert toggle takes no press')

      await options.press(await toggle(options, 2, 'Case sensitive'))
      await sleep(500)
      assert.deepEqual((await options.lastWrite(KEY)).rules[2], { ...RULES[2], caseSensitive: false })
      const live = await toggle(options, 2, 'Match casing')
      assert.equal(await live.evaluate(el => el.disabled), false, 'live again')
      assert.equal(await options.description(live), '')
      await options.press(live)
      await sleep(500)
      assert.deepEqual((await options.lastWrite(KEY)).rules[2], { ...RULES[2], caseSensitive: false, matchCasing: false })
    }
    finally {
      await options.close()
    }
  })

  test('a disabled rule drops to 48%, and comes back when enabled', async () => {
    const options = await open()
    try {
      const opacity = async index => (await options.listRow(LIST, index)).evaluate(el => getComputedStyle(el).opacity)
      assert.deepEqual([await opacity(0), await opacity(1), await opacity(2)], ['1', '1', '0.48'])
      await options.press(await toggle(options, 2, 'Disable this replacement'))
      await sleep(500)
      assert.equal((await options.lastWrite(KEY)).rules[2].disabled, false)
      assert.equal(await opacity(2), '1')
    }
    finally {
      await options.close()
    }
  })

  test('Add in the header gives a blank rule ready to type in, written as it is filled', async () => {
    const options = await open()
    try {
      await options.press(await options.control(await options.list(LIST), 'button', 'Add a replacement'))
      await sleep(500)
      assert.equal(await options.listCount(LIST), '4')
      const row = await options.listRow(LIST, 3)
      const find = await options.control(row, 'textbox', 'Find')
      assert.ok(await find.evaluate(el => el === document.activeElement), 'the new rule\'s Find is focused')

      await options.page.keyboard.type('smirked')
      await (await options.control(row, 'textbox', 'Replace with')).type('smiled')
      await sleep(500)
      assert.deepEqual((await options.lastWrite(KEY)).rules, [...RULES, {
        find: 'smirked',
        replace: 'smiled',
        caseSensitive: false,
        matchCasing: false,
        wholeWord: false,
        acrossFormatting: false,
        disabled: false,
      }])
      assert.deepEqual(options.problems(), [])
    }
    finally {
      await options.close()
    }
  })

  test('Remove writes the shortened list, and with none left the frame says so in place', async () => {
    const options = await open(RULES.slice(0, 2))
    try {
      await options.press(await options.control(await options.listRow(LIST, 0), 'button', 'Remove replacement'))
      await sleep(500)
      assert.deepEqual((await options.lastWrite(KEY)).rules, [RULES[1]])
      assert.equal(await options.listCount(LIST), '1')

      await options.press(await options.control(await options.listRow(LIST, 0), 'button', 'Remove replacement'))
      await sleep(500)
      assert.deepEqual((await options.lastWrite(KEY)).rules, [])
      assert.deepEqual(await options.listRows(LIST), [])
      assert.equal(await options.listCount(LIST), 'none yet')
      assert.ok((await options.text(await options.list(LIST))).includes('No replacements yet'), 'the empty state shows')
    }
    finally {
      await options.close()
    }
  })

  test('at a phone\'s width each rule\'s toggles go under its pair, inside the frame', async () => {
    const options = await open(RULES, { width: 390, height: 844 })
    try {
      const layout = await options.page.evaluate((id) => {
        const frame = document.querySelector(`[data-list="${id}"]`).getBoundingClientRect()
        return {
          frame: { left: frame.left, right: frame.right },
          scroll: document.documentElement.scrollWidth - window.innerWidth,
          rows: [...document.querySelectorAll(`[data-list="${id}"] [data-list-row]`)].map((row) => {
            const find = row.querySelector('input').getBoundingClientRect()
            const buttons = [...row.querySelectorAll('button')].map(b => b.getBoundingClientRect())
            return {
              findBottom: find.bottom,
              buttonsTop: Math.min(...buttons.map(b => b.top)),
              left: Math.min(find.left, ...buttons.map(b => b.left)),
              right: Math.max(find.right, ...buttons.map(b => b.right)),
            }
          }),
        }
      }, LIST)
      assert.ok(layout.scroll <= 0, `no sideways scroll: ${layout.scroll}`)
      for (const [index, row] of layout.rows.entries()) {
        assert.ok(row.buttonsTop >= row.findBottom, `row ${index}'s toggles are under its fields: ${JSON.stringify(row)}`)
        assert.ok(row.left >= layout.frame.left && row.right <= layout.frame.right, `row ${index} is inside the frame: ${JSON.stringify({ row, frame: layout.frame })}`)
      }
    }
    finally {
      await options.close()
    }
  })
})
