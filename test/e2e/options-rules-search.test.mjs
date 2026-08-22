import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { ensureBuilt, findChrome, installMock, serveDist, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/**
 * Rules chosen to pin down what the search does and does not look at:
 * casing, a substring that is not a prefix, a `.` and a `*` that must stay
 * literal, and a pseud/target that must NOT be searchable.
 */
const RULES = [
  { target: 'tag', value: 'Slow Burn', matcher: 'exact', behavior: 'hide' },
  { target: 'tag', value: 'slow build', matcher: 'exact', behavior: 'hide' },
  { target: 'tag', value: 'Enemies to Lovers', matcher: 'exact', behavior: 'hide' },
  { target: 'f', value: 'Teen Wolf (TV)', matcher: 'exact', behavior: 'hide' },
  { target: 'author', value: 'someone', pseud: 'BurnNotice', matcher: 'exact', behavior: 'hide' },
  { target: 'tag', value: 'A.B.O. Dynamics', matcher: 'exact', behavior: 'hide' },
  { target: 'tag', value: '5*Stars', matcher: 'exact', behavior: 'hide' },
]

const SEED = { 'option.rules': { enabled: true, filters: RULES, colors: {} } }

/**
 * Searching the rules list. It filters on the rule *text* alone — a few hundred
 * rules are searched for the tag you half-remember, and matching the target or
 * pseud columns would turn up rules whose text has nothing to do with what was
 * typed.
 */
describe('options UI — rules search', { skip }, () => {
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

  const SEARCH = 'input[aria-label="Search rules by text"]'

  /** Type `text` into the search box (replacing whatever is there). */
  const search = async (text) => {
    await page.click(SEARCH, { clickCount: 3 })
    await page.keyboard.press('Backspace')
    if (text)
      await page.type(SEARCH, text)
    await sleep(300)
  }

  /**
   * The rule text of every row currently rendered. The table's `id` is a
   * component prop rather than a DOM attribute, so it never reaches the
   * `<table>`; the generated header ids are what actually identify it.
   */
  const rows = () => page.evaluate(() => {
    const table = document.querySelector('[id^="rules-filters-header-"]')?.closest('table')
    if (!table)
      return []
    // The value cell is `<pre>text<span>(pseud)</span></pre>` — take the text
    // node so a pseud doesn't get folded into the value.
    return [...table.querySelectorAll('th[scope="row"] pre')]
      .map(el => (el.firstChild?.textContent ?? el.textContent).trim())
  })

  test('every rule is listed before anything is typed', async () => {
    await search('')
    const listed = await rows()
    assert.equal(listed.length, RULES.length, listed.join(' | '))
  })

  test('matching is case-insensitive', async () => {
    await search('SLOW')
    const listed = await rows()
    await search('')
    assert.deepEqual(listed.sort(), ['Slow Burn', 'slow build'])
  })

  test('it matches anywhere in the text, not just the start', async () => {
    await search('lovers')
    const listed = await rows()
    await search('')
    assert.deepEqual(listed, ['Enemies to Lovers'])
  })

  test('the target column is not searched', async () => {
    // "Fandom" is what the target column shows for one of these rules, but no
    // rule has the word in its text — so this must find nothing.
    await search('fandom')
    const listed = await rows()
    await search('')
    assert.deepEqual(listed, [])
  })

  test('an author pseud is not searched either', async () => {
    // The pseud renders right beside the rule text, so it is the obvious thing
    // to match by accident.
    await search('BurnNotice')
    const listed = await rows()
    await search('')
    assert.deepEqual(listed, [])

    await search('someone')
    const byValue = await rows()
    await search('')
    assert.deepEqual(byValue, ['someone'], 'the author value itself still matches')
  })

  test('a dot is a dot, not a wildcard', async () => {
    await search('A.B.O')
    const listed = await rows()
    await search('')
    assert.deepEqual(listed, ['A.B.O. Dynamics'])
  })

  test('a star is a star, not a wildcard', async () => {
    await search('5*')
    const listed = await rows()
    await search('')
    assert.deepEqual(listed, ['5*Stars'])
  })

  test('no matches says so rather than showing an empty table', async () => {
    await search('zzzzz')
    const empty = await page.evaluate(() =>
      [...document.querySelectorAll('p')].some(p => p.textContent.includes('No rules match')))
    await search('')
    assert.ok(empty, 'an empty result explains itself')
  })

  test('the count shows how much of the list is showing', async () => {
    await search('slow')
    const count = await page.evaluate(() =>
      [...document.querySelectorAll('span')].map(s => s.textContent.trim())
        .find(t => /^\d+ of \d+$/.test(t)) ?? null)
    await search('')
    assert.equal(count, `2 of ${RULES.length}`)
  })

  test('clearing the box brings the whole list back', async () => {
    await search('slow')
    await page.click('button[aria-label="Clear rule search"]')
    await sleep(300)
    const listed = await rows()
    const value = await page.$eval(SEARCH, el => el.value)
    assert.equal(value, '')
    assert.equal(listed.length, RULES.length)
  })

  test('renders without console errors', () => {
    const bad = consoleMsgs.filter(m => m.type === 'error' || m.type === 'pageerror')
    assert.deepEqual(bad.map(m => m.text), [])
  })
})
