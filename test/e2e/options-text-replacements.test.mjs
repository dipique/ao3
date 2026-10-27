import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { MATCH_CASING_OFF } from '../../src/options_ui/model/textReplacements.ts'
import { figures, mentions, skip, startOptions } from './optionsPage.mjs'

const LIST = 'text-replacements'
const KEY = 'option.textReplacements'
const HASH = '#work-text'

/** The flags a rule's icon toggles edit, a toggle each, found by its `data-flag`. */
const FLAGS = ['caseSensitive', 'matchCasing', 'wholeWord', 'acrossFormatting', 'disabled']

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

  const toggle = async (options, index, flag) => {
    const handle = await (await options.listRow(LIST, index)).$(`[data-flag="${flag}"]`)
    assert.ok(handle, `no ${flag} toggle in row ${index}`)
    return handle
  }
  const input = async (options, index, name) => {
    const handle = await (await options.listRow(LIST, index)).$(`[data-field="${name}"]`)
    assert.ok(handle, `no ${name} field in row ${index}`)
    return handle
  }
  const pressed = async handle => handle.evaluate(el => el.getAttribute('aria-pressed') === 'true')

  /** What a row shows: its two fields and whether each toggle is on, by flag. */
  const shown = async (options, index) => {
    const flags = {}
    for (const flag of FLAGS)
      flags[flag] = await pressed(await toggle(options, index, flag))
    return {
      find: await (await input(options, index, 'find')).evaluate(el => el.value),
      replace: await (await input(options, index, 'replace')).evaluate(el => el.value),
      ...flags,
    }
  }

  test('the rules load into a frame headed by its count, under the Editing tools switch', async () => {
    const options = await open()
    try {
      const list = await options.list(LIST)
      assert.equal(await options.listCount(LIST), '3')
      assert.deepEqual(await options.listRowIds(LIST), ['0', '1', '2'])
      for (const [index, rule] of RULES.entries())
        assert.deepEqual(await shown(options, index), rule, `row ${index}`)

      const tools = await (await options.row('work-text-text-replacement')).$('#ao3e-text-replacement-tools')
      assert.ok(
        await tools.evaluate((el, frame) => !!(el.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING), list),
        'the switch comes before the list',
      )
      await options.press(tools)
      await options.saved()
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
      for (const flag of ['matchCasing', 'wholeWord', 'acrossFormatting', 'disabled', 'caseSensitive']) {
        await options.press(await toggle(options, 0, flag))
        await options.saved()
        expected[0][flag] = !expected[0][flag]
        assert.deepEqual((await options.lastWrite(KEY)).rules, expected, `after ${flag}`)
        assert.equal(await pressed(await toggle(options, 0, flag)), expected[0][flag], `${flag} shows its new state`)
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
      const casing = await toggle(options, 2, 'matchCasing')
      assert.equal(await casing.evaluate(el => el.disabled), true, 'inert')
      assert.equal(await pressed(casing), true, 'still showing the stored value')
      assert.ok(mentions(await options.description(casing), MATCH_CASING_OFF))
      await options.press(casing)
      await options.saved()
      assert.equal(await options.lastWrite(KEY), null, 'an inert toggle takes no press')

      await options.press(await toggle(options, 2, 'caseSensitive'))
      await options.saved()
      assert.deepEqual((await options.lastWrite(KEY)).rules[2], { ...RULES[2], caseSensitive: false })
      const live = await toggle(options, 2, 'matchCasing')
      assert.equal(await live.evaluate(el => el.disabled), false, 'live again')
      assert.equal(await options.description(live), '')
      await options.press(live)
      await options.saved()
      assert.deepEqual((await options.lastWrite(KEY)).rules[2], { ...RULES[2], caseSensitive: false, matchCasing: false })
    }
    finally {
      await options.close()
    }
  })

  test('a toggle whose name doesn\'t say what it does says it in its tooltip', async () => {
    const options = await open()
    try {
      for (const flag of ['matchCasing', 'acrossFormatting', 'disabled']) {
        const handle = await toggle(options, 0, flag)
        const tip = await options.tooltip(handle)
        assert.notEqual(tip, await options.name(handle), `${flag}'s tooltip says more than its name`)
      }
    }
    finally {
      await options.close()
    }
  })

  test('a disabled rule fades its glyphs and controls to 48%, its fields\' words in the text colour at 57%, and comes back when enabled', async () => {
    const options = await open()
    try {
      /** How much of the element its own and its ancestors' opacity leave drawn. */
      const opacity = handle => handle.evaluate((el) => {
        let left = 1
        for (let at = el; at; at = at.parentElement)
          left *= Number(getComputedStyle(at).opacity)
        return Math.round(left * 100) / 100
      })
      /**
       * How the row is drawn: its arrow's and its Remove's opacity, and its
       * fields' opacity and colour. A toggle's own opacity says whether it is
       * on, so the toggles are read where that holds still.
       */
      const drawn = async (index) => {
        const row = await options.listRow(LIST, index)
        const field = async el => ({ opacity: await opacity(el), colour: await el.evaluate(f => getComputedStyle(f).color) })
        return {
          arrow: await opacity(await row.$('.i-tabler-arrow-right')),
          remove: await opacity(await options.action(row, 'remove')),
          fields: await Promise.all((await options.controls(row, 'textbox')).map(field)),
        }
      }
      const [r, g, b] = await options.token('default-fg')
      const whole = { arrow: 1, remove: 1, fields: [{ opacity: 1, colour: `rgb(${r}, ${g}, ${b})` }, { opacity: 1, colour: `rgb(${r}, ${g}, ${b})` }] }
      const off = { arrow: 0.48, remove: 0.48, fields: [{ opacity: 1, colour: `rgba(${r}, ${g}, ${b}, 0.57)` }, { opacity: 1, colour: `rgba(${r}, ${g}, ${b}, 0.57)` }] }

      assert.deepEqual([await drawn(0), await drawn(1), await drawn(2)], [whole, whole, off])
      assert.equal(await opacity(await toggle(options, 2, 'caseSensitive')), 0.48, 'a toggle that is on fades with its row')
      await options.press(await toggle(options, 2, 'disabled'))
      await options.saved()
      assert.equal((await options.lastWrite(KEY)).rules[2].disabled, false)
      assert.deepEqual(await drawn(2), whole)
      assert.equal(await opacity(await toggle(options, 2, 'caseSensitive')), 1)
    }
    finally {
      await options.close()
    }
  })

  test('Add in the header gives a blank rule ready to type in, written as it is filled', async () => {
    const options = await open()
    try {
      await options.press(await options.action(await options.list(LIST), 'add'))
      await options.page.waitForFunction(id => document.querySelector(`[data-list="${id}"] [data-list-row="3"]`)?.contains(document.activeElement), {}, LIST)
      assert.equal(await options.listCount(LIST), '4')
      const find = await input(options, 3, 'find')
      assert.ok(await find.evaluate(el => el === document.activeElement), 'the new rule\'s Find is focused')

      await options.page.keyboard.type('smirked')
      await (await input(options, 3, 'replace')).type('smiled')
      await options.saved()
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
      await options.press(await options.action(await options.listRow(LIST, 0), 'remove'))
      await options.saved()
      assert.deepEqual((await options.lastWrite(KEY)).rules, [RULES[1]])
      assert.equal(await options.listCount(LIST), '1')

      await options.press(await options.action(await options.listRow(LIST, 0), 'remove'))
      await options.saved()
      assert.deepEqual((await options.lastWrite(KEY)).rules, [])
      assert.deepEqual(await options.listRows(LIST), [])
      assert.deepEqual(figures(await options.listCount(LIST)), [], 'nothing to count')
      assert.ok(await (await options.list(LIST)).$('[data-list-empty]'), 'the empty state shows')
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
