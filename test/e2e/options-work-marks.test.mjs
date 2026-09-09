import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { ensureBuilt, findChrome, installMock, serveDist, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/**
 * A mark table with one non-default entry — `gross` opting out of hiding — so
 * the row's switch has to be reading the stored value rather than assuming the
 * default, and `favorite` inheriting `read`'s.
 *
 * No mark carries an `order`, which is what a table stored before the order was
 * editable looks like: the rows have to fall back on the order it was stored in.
 */
const SEED = {
  'option.workMarks': {
    enabled: true,
    marks: {
      read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: true, items: 'pico,4mm7y' },
      favorite: { icon: 'favorite', label: 'Favorite', color: '#c2185b', triggerAlias: 'read', items: 'aoehq,6jan1' },
      good: { icon: 'good', label: 'Good', color: '#2f8f4e', triggerAlias: 'read', items: '' },
      gross: { icon: 'gross', label: 'Gross', color: '#4d7c0f', triggerAlias: 'read', hideSearchResult: false, items: '' },
      continue: {
        icon: 'continue',
        label: 'Ongoing',
        color: '#0369a1',
        triggerAlias: 'read',
        tracksProgress: true,
        hideSearchResult: true,
        items: '',
        progress: '',
      },
      saved: { icon: 'saved', label: 'Marked for later', color: '#2f8f4e' },
    },
  },
}

/**
 * The work-marks row is built entirely from the stored mark table — one row per
 * mark that holds ids, its icon and colour from the table, and its "hide in
 * listings" switch reading through the trigger alias. Nothing about `favorite`
 * or `gross` is written into the component, so a table with different marks in
 * it renders different rows.
 */
describe('options UI — work marks', { skip }, () => {
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

  /** The rendered rows: label, count line, and whether the hide switch is on. */
  const rows = () => page.evaluate(() => {
    const switches = [...document.querySelectorAll('[role="switch"]')]
    return switches
      .map(s => ({ s, label: s.getAttribute('aria-label') ?? '' }))
      .filter(({ label }) => label.startsWith('Hide works marked '))
      .map(({ s, label }) => ({
        mark: label.slice('Hide works marked '.length).replace(/ (?:in listings|until ready)$/, ''),
        on: s.getAttribute('aria-checked') === 'true' || s.dataset.state === 'checked',
        // The count line sits in the row's first grid cell, two siblings back.
        text: s.previousElementSibling?.textContent ?? '',
      }))
  })

  /** The move buttons, by the title they carry ("Move Gross up"). */
  const moveButton = title => page.evaluate(
    t => [...document.querySelectorAll('button')].find(b => b.title === t)?.disabled ?? null,
    title,
  )

  const clickMove = title => page.evaluate(
    t => [...document.querySelectorAll('button')].find(b => b.title === t)?.click(),
    title,
  )

  /** Any button, by its title — the row's icon, pencil and move buttons all carry one. */
  const clickTitled = title => page.evaluate(
    t => [...document.querySelectorAll('button')].find(b => b.title === t)?.click(),
    title,
  )

  const openAddDialog = () => page.evaluate(() => {
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add mark')?.click()
  })

  /** A button inside the open dialog, by the text on it. */
  const clickDialogButton = text => page.evaluate(
    t => [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === t)?.click(),
    text,
  )

  /** What the dialog currently says: its heading, the key preview, and any error. */
  const dialogState = () => page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog)
      return null
    const save = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save')
    return {
      title: dialog.querySelector('h1')?.textContent.trim() ?? '',
      name: dialog.querySelector('input[name="mark-name"]')?.value ?? '',
      key: dialog.querySelector('code')?.textContent.trim() ?? null,
      error: dialog.querySelector('[role="alert"]')?.textContent.trim() ?? null,
      saveDisabled: save?.disabled ?? null,
    }
  })

  /** Replace the dialog's name field, the way a reader would. */
  const typeName = async (text) => {
    await page.click('[role="dialog"] input[name="mark-name"]', { clickCount: 3 })
    await page.keyboard.press('Backspace')
    await page.type('[role="dialog"] input[name="mark-name"]', text)
  }

  /** The last mark table written to storage. */
  const storedMarks = () => page.evaluate(() => {
    const w = window.__writes.filter(x => 'option.workMarks' in x).map(x => x['option.workMarks'])
    return w.at(-1) ?? null
  })

  test('renders one row per mark that holds ids, in table order', async () => {
    const got = await rows()
    assert.deepEqual(got.map(r => r.mark), ['Read', 'Favorite', 'Good', 'Gross', 'Ongoing'])
  })

  test('shows each mark\'s count, and what it counts as', async () => {
    const got = await rows()
    assert.match(got[0].text, /2 works/)
    assert.match(got[1].text, /2 works/)
    assert.match(got[1].text, /counts as Read/, 'an aliased mark says what it behaves as')
    assert.match(got[2].text, /0 works/)
    assert.doesNotMatch(got[0].text, /counts as/, 'the root mark aliases nothing')
  })

  test('the hide switch reads through the trigger alias', async () => {
    const got = await rows()
    assert.equal(got[0].on, true, 'read hides')
    assert.equal(got[1].on, true, 'favorite inherits read')
    assert.equal(got[2].on, true, 'good inherits read')
    assert.equal(got[3].on, false, 'gross set its own value')
  })

  test('toggling a mark that follows its root stores an override', async () => {
    const before = await rows()
    assert.equal(before[1].on, true)
    await page.evaluate(() => {
      const s = [...document.querySelectorAll('[role="switch"]')]
        .find(el => el.getAttribute('aria-label') === 'Hide works marked Favorite in listings')
      s.click()
    })
    await sleep(1000)
    const stored = await page.evaluate(() => {
      const w = window.__writes.filter(x => 'option.workMarks' in x).map(x => x['option.workMarks'])
      return w.at(-1) ?? null
    })
    assert.equal(stored?.marks?.favorite?.hideSearchResult, false, 'diverging from the root is stored')
    assert.equal(stored?.marks?.read?.hideSearchResult, true, 'the root is untouched')
  })

  test('the ends of the run, and the ongoing mark, cannot be moved', async () => {
    assert.equal(await moveButton('Move Read up'), true, 'nothing above the first mark')
    assert.equal(await moveButton('Move Read down'), false)
    assert.equal(await moveButton('Move Gross down'), true, 'the last verdict cannot pass Ongoing')
    assert.equal(await moveButton('Move Ongoing up'), null, 'Ongoing has no move buttons at all')
    assert.equal(await moveButton('Move Ongoing down'), null)
  })

  test('moving a mark reorders the rows and stores the new order', async () => {
    await clickMove('Move Favorite up')
    await sleep(1000)

    const got = await rows()
    assert.deepEqual(got.map(r => r.mark), ['Favorite', 'Read', 'Good', 'Gross', 'Ongoing'])

    const stored = await page.evaluate(() => {
      const w = window.__writes.filter(x => 'option.workMarks' in x).map(x => x['option.workMarks'])
      return w.at(-1) ?? null
    })
    // The whole table is renumbered, so the order is a stored fact rather than
    // an accident of which keys happen to come first.
    assert.deepEqual(
      Object.fromEntries(Object.entries(stored.marks).map(([id, m]) => [id, m.order])),
      { favorite: 0, read: 1, good: 2, gross: 3, continue: 4, saved: 5 },
    )
    assert.equal(stored.marks.read.items, 'pico,4mm7y', 'the marks themselves are untouched')
  })

  test('each row carries its key for hovering, and the name is separate from it', async () => {
    const titles = await page.evaluate(() => [...document.querySelectorAll('span[title^="id: "]')]
      .map(el => [el.getAttribute('title'), el.textContent.trim()]))
    assert.deepEqual(titles, [
      ['id: favorite', 'Favorite'],
      ['id: read', 'Read'],
      ['id: good', 'Good'],
      ['id: gross', 'Gross'],
      ['id: continue', 'Ongoing'],
    ])
  })

  test('"in menus" writes the disabled flag, and clearing it removes the field', async () => {
    await page.evaluate(() => {
      const s = [...document.querySelectorAll('[role="switch"]')]
        .find(el => el.getAttribute('aria-label') === 'Offer Gross when marking a work')
      s.click()
    })
    await sleep(1000)
    assert.equal((await storedMarks())?.marks?.gross?.disabled, true)
    assert.equal((await storedMarks())?.marks?.gross?.items, '', 'the mark itself is untouched')

    await page.evaluate(() => {
      const s = [...document.querySelectorAll('[role="switch"]')]
        .find(el => el.getAttribute('aria-label') === 'Offer Gross when marking a work')
      s.click()
    })
    await sleep(1000)
    assert.ok(!('disabled' in (await storedMarks()).marks.gross), 'back to the shape it shipped as')
  })

  test('the pencil renames a mark without moving the key its works are filed under', async () => {
    await clickTitled('Rename Good')
    await sleep(300)
    assert.deepEqual(await dialogState(), {
      title: 'Edit mark',
      name: 'Good',
      key: 'good',
      error: null,
      saveDisabled: false,
    })

    await typeName('Great')
    await clickDialogButton('Save')
    await sleep(1000)

    const stored = await storedMarks()
    assert.equal(stored.marks.good.label, 'Great', 'the display name moved')
    assert.ok(!stored.marks.great, 'and nothing else did')
    assert.deepEqual((await rows()).map(r => r.mark), ['Favorite', 'Read', 'Great', 'Gross', 'Ongoing'])
  })

  test('the row icon opens the same dialog, where the palette sets the icon', async () => {
    await clickTitled('Change the Great icon')
    await sleep(300)
    assert.equal((await dialogState()).title, 'Edit mark')

    await page.evaluate(() => {
      [...document.querySelectorAll('[role="dialog"] button')].find(b => b.title === 'mdi/star')?.click()
    })
    await clickDialogButton('Save')
    await sleep(1000)

    assert.equal((await storedMarks()).marks.good.icon, 'mdi/star')
  })

  test('a name whose key is taken is refused rather than merged', async () => {
    await openAddDialog()
    await sleep(300)
    assert.equal((await dialogState()).title, 'Add mark')

    await typeName('read')
    await sleep(100)
    const state = await dialogState()
    assert.match(state.error, /already taken/)
    assert.equal(state.saveDisabled, true, 'and there is no way to save it anyway')

    await clickDialogButton('Cancel')
    await sleep(300)
  })

  test('adding a mark files it under a key worked out from the name', async () => {
    await openAddDialog()
    await sleep(300)

    await typeName('Did Not Finish')
    await sleep(100)
    assert.equal((await dialogState()).key, 'did-not-finish', 'shown before it is committed to')

    await clickDialogButton('Save')
    await sleep(1000)

    const added = (await storedMarks()).marks['did-not-finish']
    assert.equal(added.label, 'Did Not Finish')
    assert.equal(added.triggerAlias, 'read', 'another reading of read')
    assert.equal(added.hideSearchResult, true, 'hidden by default')
    assert.equal(added.icon, 'mdi/book-check', 'the Read icon until it is changed')
    assert.equal(added.items, '')
    assert.deepEqual(
      (await rows()).map(r => r.mark),
      ['Favorite', 'Read', 'Great', 'Gross', 'Did Not Finish', 'Ongoing'],
      'last among the verdicts, still ahead of Ongoing',
    )
  })

  test('renders without console errors', () => {
    const errors = consoleMsgs.filter(m => m.type === 'pageerror' || m.type === 'error')
    assert.deepEqual(errors, [])
  })
})
