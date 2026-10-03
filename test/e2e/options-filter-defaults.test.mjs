import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { ensureBuilt, findChrome, installMock, serveDist, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/**
 * The completion and crossover rows under Filter defaults. Switching one on
 * stores its starting choice, so the default is live the moment the row opens;
 * picking another from its dropdown stores that.
 */
describe('options UI — completion and crossover defaults', { skip }, () => {
  let server
  let browser
  let page
  const consoleMsgs = []

  before(async () => {
    ensureBuilt()
    server = await serveDist()
    browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-first-run', '--no-default-browser-check'] })
    page = await browser.newPage()
    await page.evaluateOnNewDocument(installMock, {})
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

  const lastWrite = key => page.evaluate(k => window.__writes.filter(w => k in w).map(w => w[k]).at(-1) ?? null, key)

  const switchOn = async (title) => {
    const row = await rowHandle(title)
    const toggle = await row.$('[role="switch"]')
    await toggle.click()
    await sleep(500)
  }

  /** Open the row's dropdown and pick the option reading `label`. */
  const choose = async (title, label) => {
    const row = await rowHandle(title)
    const trigger = await row.$('[role="combobox"]')
    assert.ok(trigger, `no dropdown in "${title}"`)
    await trigger.click()
    await sleep(300)
    const option = await page.evaluateHandle(l =>
      [...document.querySelectorAll('[role="option"]')].find(el => el.textContent.trim() === l) ?? null, label)
    assert.ok(option.asElement(), `no "${label}" option in "${title}"`)
    await option.asElement().click()
    await sleep(500)
  }

  const shown = async (title) => {
    const row = await rowHandle(title)
    return row.$eval('[role="combobox"]', el => el.textContent.trim())
  }

  test('switching on the completion default stores its starting choice', async () => {
    await switchOn('Default completion status')
    assert.deepEqual(await lastWrite('option.searchCompletion'), { enabled: true, completion: 'complete' })
    assert.equal(await shown('Default completion status'), 'Completed works only')
  })

  test('picking works in progress stores it', async () => {
    await choose('Default completion status', 'Incomplete works only')
    assert.deepEqual(await lastWrite('option.searchCompletion'), { enabled: true, completion: 'incomplete' })
  })

  test('switching on the crossover default stores its starting choice', async () => {
    await switchOn('Default crossovers')
    assert.deepEqual(await lastWrite('option.searchCrossovers'), { enabled: true, crossovers: 'exclude' })
    assert.equal(await shown('Default crossovers'), 'No crossovers')
  })

  test('picking crossovers only stores it', async () => {
    await choose('Default crossovers', 'Crossovers only')
    assert.deepEqual(await lastWrite('option.searchCrossovers'), { enabled: true, crossovers: 'only' })
  })

  test('no page errors along the way', () => {
    const bad = consoleMsgs.filter(m => m.type === 'pageerror' || m.type === 'error')
    assert.deepEqual(bad, [])
  })
})
