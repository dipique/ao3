import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { ensureBuilt, findChrome, installMock, serveDist, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const SEED = {
  'option.wordCountToolbar': { enabled: true, ranges: [{ from: 1000, to: 3000 }] },
  'option.searchWordCount': { enabled: true, from: 2000, to: 40000 },
}

/**
 * The two word-count rows in the options UI. Both edit their bounds as text and
 * only write a range back once it is valid, so what's tested here is the gate:
 * a bad range must reach the user as an error and must never reach storage.
 */
describe('options UI — word count ranges', { skip }, () => {
  let server
  let browser
  let page
  const consoleMsgs = []

  before(async () => {
    ensureBuilt()
    server = await serveDist()
    browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-first-run', '--no-default-browser-check'] })
    page = await browser.newPage()
    await page.evaluateOnNewDocument(installMock, SEED)
    page.on('console', m => consoleMsgs.push({ type: m.type(), text: m.text() }))
    page.on('pageerror', e => consoleMsgs.push({ type: 'pageerror', text: e.message }))
    await page.goto(`${server.url}/options_ui/options_ui.html`, { waitUntil: 'networkidle2' })
    await sleep(1500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
    await server?.close()
  })

  /** The whole OptionRow — its label and the expanded content below it. */
  const rowHandle = async (title) => {
    const handle = await page.evaluateHandle((t) => {
      const span = [...document.querySelectorAll('label span')].find(el => el.textContent.trim() === t)
      return span?.closest('label')?.parentElement ?? null
    }, title)
    const el = handle.asElement()
    assert.ok(el, `option row "${title}" not found`)
    return el
  }

  /** Every text input inside the named row, in document order. */
  const inputsIn = async (title) => {
    const row = await rowHandle(title)
    return row.$$('input[type="text"]')
  }

  const lastWrite = key => page.evaluate(k => window.__writes.filter(w => k in w).map(w => w[k]).at(-1) ?? null, key)

  const errorsIn = async (title) => {
    const row = await rowHandle(title)
    return row.evaluate(el => [...el.querySelectorAll('p')]
      .map(p => p.textContent.trim())
      .filter(t => /must|already|at least/i.test(t)))
  }

  const retype = async (input, value) => {
    await input.click({ clickCount: 3 })
    await page.keyboard.press('Backspace')
    if (value)
      await input.type(value)
    await sleep(400)
  }

  test('loads the saved ranges into the editor', async () => {
    const inputs = await inputsIn('Word count menu')
    assert.equal(inputs.length, 2, 'one row of two bounds')
    assert.equal(await inputs[0].evaluate(el => el.value), '1000')
    assert.equal(await inputs[1].evaluate(el => el.value), '3000')
  })

  test('adding a range writes it once both bounds are set', async () => {
    const row = await rowHandle('Word count menu')
    await row.evaluate((el) => {
      const button = [...el.querySelectorAll('button')].find(b => b.textContent.includes('Add range'))
      button.click()
    })
    await sleep(300)
    const inputs = await inputsIn('Word count menu')
    assert.equal(inputs.length, 4)
    await retype(inputs[2], '8000')
    await retype(inputs[3], '20000')
    assert.deepEqual(await lastWrite('option.wordCountToolbar'), {
      enabled: true,
      ranges: [{ from: 1000, to: 3000 }, { from: 8000, to: 20000 }],
    })
  })

  test('an upside-down range is refused, not saved', async () => {
    const inputs = await inputsIn('Word count menu')
    await retype(inputs[3], '10')
    assert.deepEqual(await errorsIn('Word count menu'), ['The upper bound must not be below the lower bound.'])
    // Clearing the box on the way through is itself a valid (open-ended) range,
    // so a write may well have happened — what must never be stored is the
    // upside-down range now on screen.
    const stored = await lastWrite('option.wordCountToolbar')
    assert.ok(
      !stored.ranges.some(r => r.from === 8000 && r.to === 10),
      `invalid range reached storage: ${JSON.stringify(stored.ranges)}`,
    )
  })

  test('a duplicate range is refused, not saved', async () => {
    const inputs = await inputsIn('Word count menu')
    await retype(inputs[2], '1000')
    await retype(inputs[3], '3000')
    // Both rows are now the same, so both are flagged.
    assert.deepEqual(await errorsIn('Word count menu'), [
      'This range is already in the list.',
      'This range is already in the list.',
    ])
    // As above, intermediate valid states may have been written; the duplicated
    // list itself must not have been.
    const stored = await lastWrite('option.wordCountToolbar')
    const repeats = stored.ranges.filter(r => r.from === 1000 && r.to === 3000)
    assert.equal(repeats.length, 1, `duplicate reached storage: ${JSON.stringify(stored.ranges)}`)
  })

  test('an overlapping (but distinct) range is accepted', async () => {
    const inputs = await inputsIn('Word count menu')
    await retype(inputs[3], '2500')
    assert.deepEqual(await errorsIn('Word count menu'), [])
    assert.deepEqual(await lastWrite('option.wordCountToolbar'), {
      enabled: true,
      ranges: [{ from: 1000, to: 3000 }, { from: 1000, to: 2500 }],
    })
  })

  test('removing a range writes the shortened list', async () => {
    const row = await rowHandle('Word count menu')
    await row.evaluate((el) => {
      const buttons = [...el.querySelectorAll('button[title="Remove this range"]')]
      buttons.at(-1).click()
    })
    await sleep(400)
    assert.deepEqual(await lastWrite('option.wordCountToolbar'), {
      enabled: true,
      ranges: [{ from: 1000, to: 3000 }],
    })
  })

  test('the default range loads, and blanking a bound makes it one-sided', async () => {
    const inputs = await inputsIn('Default word count range')
    assert.equal(await inputs[0].evaluate(el => el.value), '2000')
    assert.equal(await inputs[1].evaluate(el => el.value), '40000')
    await retype(inputs[1], '')
    assert.deepEqual(await lastWrite('option.searchWordCount'), { enabled: true, from: 2000, to: null })
  })

  test('a negative default bound is refused, not saved', async () => {
    const before = await lastWrite('option.searchWordCount')
    const inputs = await inputsIn('Default word count range')
    await retype(inputs[0], '-5')
    assert.deepEqual(await errorsIn('Default word count range'), ['Word counts must be whole numbers of 0 or more.'])
    assert.deepEqual(await lastWrite('option.searchWordCount'), before)
  })

  test('no page errors along the way', () => {
    const bad = consoleMsgs.filter(m => m.type === 'pageerror' || m.type === 'error')
    assert.deepEqual(bad, [])
  })
})
