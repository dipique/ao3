import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { formatDay, utcToday } from '../../src/common/trackedLists.ts'
import { ensureBuilt, findChrome, installMock, serveDist, sleep, storedLists } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const ARCHIVE = 'https://archiveofourown.org'
const TODAY = utcToday()

/** The two entries the row is drawn from: one tracked and named, one paused and not. */
const COFFEE = { id: 'c0ffee', kind: 'text-search', url: '/works/search?work_search%5Bquery%5D=coffee', alias: 'Coffee shop AUs', tracked: true, since: TODAY - 5 }
const SERIES = { id: 'ser1es', kind: 'series-works', url: '/series/9991', alias: '', tracked: false, since: TODAY - 12 }

/** A list without an alias is called by its URL's tail, here short enough to be all of it. */
const SERIES_LABEL = '/series/9991'

/** Enough of a blurb for a stored list to have a work in it. */
const blurb = id => `<li class="work blurb group" id="work_${id}" role="article">
  <div class="header module"><h4 class="heading"><a href="/works/${id}">Work ${id}</a>
    by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4></div>
  <dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd></dl>
</li>`

const SEED = {
  'option.trackedLists': {
    enabled: true,
    target: 40,
    reviewedThrough: TODAY - 9,
    lists: [COFFEE, SERIES],
  },
  ...storedLists({
    // A stored search nothing tracks yet: the row that offers **Track**.
    'text-search:work_search%5Bquery%5D=tea': {
      version: 2,
      scrapedAt: Date.now() - 3 * 60 * 60 * 1000,
      blurbsHtml: [blurb(101)],
      descriptor: {
        sourceId: 'text-search',
        label: 'Works search — tea',
        listUrl: `${ARCHIVE}/works/search?work_search%5Bquery%5D=tea`,
      },
    },
    // The review's own window. A stored list like any other, and the one that
    // isn't read from a listing, so it can't be refreshed from here.
    'tracked-review': {
      version: 2,
      scrapedAt: Date.now() - 20 * 60 * 1000,
      blurbsHtml: [blurb(102), blurb(103)],
      descriptor: {
        sourceId: 'tracked-review',
        label: 'Tracked review',
        listUrl: `${ARCHIVE}/users/me/readings#ao3e-tracked`,
      },
    },
  }),
}

/**
 * The options page's half of tracked lists: the Search → Tracked lists row,
 * where an entry is renamed, paused and dropped, and the **Track** action on a
 * stored list under Advanced → Site export, which is how a list the reader
 * already has becomes one of them without going back to AO3.
 *
 * Nothing here reaches the archive. Every one of these actions is an options
 * write, which is exactly why they belong on this page.
 */
describe('options UI — tracked lists', { skip }, () => {
  let server
  let browser
  let page
  const problems = []

  before(async () => {
    ensureBuilt()
    server = await serveDist()
    browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-first-run', '--no-default-browser-check'] })
    page = await browser.newPage()
    await page.evaluateOnNewDocument(installMock, SEED)
    page.on('console', m => m.type() === 'error' && problems.push(m.text()))
    page.on('pageerror', e => problems.push(e.message))
    await page.goto(`${server.url}/options_ui/options_ui.html`, { waitUntil: 'networkidle2' })
    await sleep(1500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
    await server?.close()
  })

  /** The last value written to a storage key, or null. */
  const lastWrite = key => page.evaluate(
    k => window.__writes.filter(w => k in w).map(w => w[k]).at(-1) ?? null,
    key,
  )

  const storedOption = () => lastWrite('option.trackedLists')

  /** One row per entry: the name field, what it says under it, and the switch. */
  const rows = () => page.evaluate(() => [...document.querySelectorAll('input[aria-label^="Name for "]')].map((input) => {
    const cell = input.closest('span')
    const toggle = [...document.querySelectorAll('[role="switch"]')]
      .find(s => s.getAttribute('aria-label') === `Track ${input.getAttribute('aria-label').slice('Name for '.length)}`)
    return {
      label: input.getAttribute('aria-label').slice('Name for '.length),
      alias: input.value,
      placeholder: input.placeholder,
      // The cell holds the field and, under it, the line that says what kind of
      // list it is and how it stands. Only the line has text in it.
      note: cell?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      tracked: toggle?.getAttribute('aria-checked') === 'true' || toggle?.dataset.state === 'checked',
    }
  }))

  /** Click a button by the text on it (a `sr-only` icon label counts). */
  const clickButton = text => page.evaluate((t) => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.replace(/\s+/g, ' ').trim() === t)
    if (!button)
      throw new Error(`no button "${t}"`)
    button.click()
  }, text)

  const clickSwitch = label => page.evaluate((l) => {
    [...document.querySelectorAll('[role="switch"]')].find(s => s.getAttribute('aria-label') === l)?.click()
  }, label)

  /** The whole OptionRow for a title — its label and whatever sits under it. */
  const rowText = title => page.evaluate((t) => {
    const span = [...document.querySelectorAll('label span')].find(el => el.textContent.trim() === t)
    const row = span?.closest('label')?.parentElement
    return row?.textContent?.replace(/\s+/g, ' ').trim() ?? null
  }, title)

  /** The text of every button inside the row with this title. */
  const rowButtons = title => page.evaluate((t) => {
    const span = [...document.querySelectorAll('label span')].find(el => el.textContent.trim() === t)
    const row = span?.closest('label')?.parentElement
    return [...(row?.querySelectorAll('button') ?? [])].map(b => b.textContent.replace(/\s+/g, ' ').trim())
  }, title)

  test('every entry gets a row, tracked or paused', async () => {
    const got = await rows()
    assert.deepEqual(got.map(r => r.label), ['Coffee shop AUs', SERIES_LABEL])
    assert.equal(got[0].alias, 'Coffee shop AUs')
    assert.equal(got[1].alias, '', 'no alias, so the field is empty')
    assert.equal(got[1].placeholder, SERIES_LABEL, 'and the URL tail stands in for one')
    assert.match(got[0].note, /Works search/)
    assert.match(got[0].note, new RegExp(`Tracking since ${formatDay(TODAY - 5)}`))
    assert.match(got[1].note, /Series/)
    assert.match(got[1].note, /Paused/)
    assert.equal(got[0].tracked, true)
    assert.equal(got[1].tracked, false)
  })

  test('the watermark reads as a date, not a number', async () => {
    assert.match(await rowText('Tracked lists'), new RegExp(`Reviewed through\\s*${formatDay(TODAY - 9)}`))
  })

  test('renaming a list writes the alias straight through', async () => {
    // The field's own label is the name it is showing, so the element is taken
    // once and then typed over: emptying it first would rename the row out from
    // under the selector.
    const input = await page.$('input[aria-label="Name for Coffee shop AUs"]')
    assert.ok(input, 'the name field is there to type into')
    await input.click({ clickCount: 3 })
    await input.type('Caffeine')
    await sleep(1200)

    const stored = await storedOption()
    assert.equal(stored.lists[0].alias, 'Caffeine')
    assert.equal(stored.lists[0].url, COFFEE.url, 'the entry is the same one, renamed')
    // The label follows the alias, so the rest of the row now answers to it.
    assert.deepEqual((await rows()).map(r => r.label), ['Caffeine', SERIES_LABEL])
  })

  test('the switch pauses a list, and resuming restarts the clock', async () => {
    await clickSwitch('Track Caffeine')
    await sleep(1000)
    let stored = await storedOption()
    assert.equal(stored.lists[0].tracked, false)
    assert.equal(stored.lists[0].since, TODAY - 5, 'pausing leaves the tracking date alone')
    assert.match((await rows())[0].note, /Paused/)

    await clickSwitch('Track Caffeine')
    await sleep(1000)
    stored = await storedOption()
    assert.equal(stored.lists[0].tracked, true)
    // A paused stretch is the reader saying "not these for now", so resuming
    // doesn't pour back what they chose to skip.
    assert.equal(stored.lists[0].since, TODAY, 'resuming tracks from today')
  })

  test('dropping a list asks first, and then takes only that one', async () => {
    await clickButton(`Remove ${SERIES_LABEL}`)
    await sleep(500)
    const asked = await page.evaluate(() => document.querySelector('[role="dialog"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? null)
    assert.match(asked, /Remove this list\?/)
    assert.match(asked, new RegExp(SERIES_LABEL))

    await page.evaluate(() => {
      [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === 'Remove list').click()
    })
    await sleep(1000)

    const stored = await storedOption()
    assert.deepEqual(stored.lists.map(entry => entry.id), ['c0ffee'])
    assert.deepEqual((await rows()).map(r => r.label), ['Caffeine'])
  })

  test('Track on a stored list makes it an entry, from today', async () => {
    await clickButton('Track')
    await sleep(1000)

    const stored = await storedOption()
    assert.equal(stored.lists.length, 2)
    const added = stored.lists.at(-1)
    assert.equal(added.kind, 'text-search')
    assert.equal(added.url, '/works/search?work_search[query]=tea', 'stored as a path, normalized')
    assert.equal(added.alias, 'Works search — tea', 'named after the list the reader already knows')
    assert.equal(added.tracked, true)
    assert.equal(added.since, TODAY)
    assert.notEqual(added.id, 'c0ffee')

    // The entry and the stored list are now the same list, so the row says so
    // and stops offering to track it a second time.
    await sleep(500)
    assert.equal((await rowButtons('Works search — tea')).includes('Track'), false)
    assert.match(await rowText('Works search — tea'), /Tracked/)
  })

  test('the review\'s own window is a stored list that can\'t be refreshed', async () => {
    const buttons = await rowButtons('Tracked review window')
    // "Works" caches the work text, which is per work and works fine. "List"
    // would walk a listing, and there isn't one.
    assert.equal(buttons.includes('List'), false)
    assert.equal(buttons.includes('Works'), true)
    assert.equal(buttons.includes('Track'), false, 'the review is not itself trackable')

    const text = await rowText('Tracked review window')
    assert.match(text, /The range you are reviewing now/)
    assert.match(text, /2 works as of/)
    assert.match(text, /nothing to refresh here/)
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(problems, [])
  })
})
