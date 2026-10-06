import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { sleep } from './helpers.mjs'
import { skip, startOptions } from './optionsPage.mjs'

const LIST = 'work-marks'
const ROW = 'marks-status-work-marks'
const KEY = 'option.workMarks'
const HASH = '#marks-status'

const ORDER_OFF = 'Sort by your order to rearrange'

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
 * {@link SEED} with a different number of works under each mark — read 2,
 * favorite 3, good none, gross 1, ongoing 4 — so a sort by works has one
 * answer, and one that is neither the order they're kept in nor by name.
 */
const COUNTED = structuredClone(SEED)
Object.assign(COUNTED[KEY].marks.read, { items: '1,1' })
Object.assign(COUNTED[KEY].marks.favorite, { items: '3,1,1' })
Object.assign(COUNTED[KEY].marks.gross, { items: 'a' })
Object.assign(COUNTED[KEY].marks.continue, { items: 'k,1,1,1' })

/**
 * The work-marks row is built entirely from the stored mark table — one row per
 * mark that holds ids, its icon and colour from the table, and its "hide in
 * listings" toggle reading through the trigger alias. Nothing about `favorite`
 * or `gross` is written into the component, so a table with different marks in
 * it renders different rows.
 *
 * The list is a list frame: Add mark and a sort in its header, and each row a
 * mark's order buttons (or its pin), icon, name, count, Hide and In menus
 * toggles, and Clear, which asks again in its own place.
 */
describe('options UI — work marks', { skip }, () => {
  let session
  let options
  let page

  before(async () => {
    session = await startOptions()
    options = await session.open({ seed: SEED, hash: HASH })
    page = options.page
  }, { timeout: 180000 })

  after(() => session?.close())

  /** The rendered rows: label, everything the row says, and whether the hide toggle is on. */
  const rows = async () => Promise.all((await options.listRows(LIST)).map(async (row) => {
    const hide = await options.control(row, 'button', /^Hide works marked /)
    return {
      mark: (await options.name(hide)).slice('Hide works marked '.length).replace(/ (?:in listings|until ready)$/, ''),
      on: await hide.evaluate(el => el.getAttribute('aria-pressed') === 'true'),
      text: await options.text(row),
    }
  }))

  /** Whether the named button is disabled, or null when there is no such button. */
  const moveButton = async (name) => {
    const [button] = await options.controls(await options.list(LIST), 'button', name)
    return button ? button.evaluate(el => el.disabled) : null
  }

  /** Any button in the list, by its name — the row's icon, pencil and move buttons all have one. */
  const clickNamed = async name => options.press(await options.control(await options.list(LIST), 'button', name))

  /**
   * Add mark, pressed the way a click that doesn't focus its button presses it
   * (Safari's, Firefox's on macOS), so focus is wherever an earlier dialog left
   * it.
   */
  const openAddDialog = () => clickNamed('Add mark')

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
  const storedMarks = () => options.lastWrite('option.workMarks')

  test('renders one row per mark that holds ids, in table order', async () => {
    const got = await rows()
    assert.deepEqual(got.map(r => r.mark), ['Read', 'Favorite', 'Good', 'Gross', 'Ongoing'])
  })

  test('the frame is headed by its title, the marks, and the works they are on', async () => {
    assert.equal(await options.name(await options.list(LIST)), 'Work marks')
    assert.equal(await options.listCount(LIST), '5 · 4 works', 'read and favorite hold two works each')
  })

  test('shows each mark\'s count, and what it counts as', async () => {
    const got = await rows()
    assert.match(got[0].text, /2 works/)
    assert.match(got[1].text, /2 works/)
    assert.match(got[1].text, /counts as Read/, 'an aliased mark says what it behaves as')
    assert.match(got[2].text, /0 works/)
    assert.doesNotMatch(got[0].text, /counts as/, 'the root mark aliases nothing')
  })

  test('the hide toggle reads through the trigger alias', async () => {
    const got = await rows()
    assert.equal(got[0].on, true, 'read hides')
    assert.equal(got[1].on, true, 'favorite inherits read')
    assert.equal(got[2].on, true, 'good inherits read')
    assert.equal(got[3].on, false, 'gross set its own value')
  })

  test('toggling a mark that follows its root stores an override', async () => {
    const before = await rows()
    assert.equal(before[1].on, true)
    await options.press(await options.control(await options.listRow(LIST, 'favorite'), 'button', 'Hide works marked Favorite in listings'))
    await sleep(1000)
    const stored = await storedMarks()
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
    await clickNamed('Move Favorite up')
    await sleep(1000)

    const got = await rows()
    assert.deepEqual(got.map(r => r.mark), ['Favorite', 'Read', 'Good', 'Gross', 'Ongoing'])
    assert.deepEqual(await options.listRowIds(LIST), ['favorite', 'read', 'good', 'gross', 'continue'])

    const stored = await storedMarks()
    // The whole table is renumbered, so the order is a stored fact rather than
    // an accident of which keys happen to come first.
    assert.deepEqual(
      Object.fromEntries(Object.entries(stored.marks).map(([id, m]) => [id, m.order])),
      { favorite: 0, read: 1, good: 2, gross: 3, continue: 4, saved: 5 },
    )
    assert.equal(stored.marks.read.items, 'pico,4mm7y', 'the marks themselves are untouched')
  })

  test('each row carries its key for hovering, and the name is separate from it', async () => {
    const titles = await (await options.list(LIST)).$$eval('[title^="id: "]', els =>
      els.map(el => [el.getAttribute('title'), el.textContent.trim()]))
    assert.deepEqual(titles, [
      ['id: favorite', 'Favorite'],
      ['id: read', 'Read'],
      ['id: good', 'Good'],
      ['id: gross', 'Gross'],
      ['id: continue', 'Ongoing'],
    ])
  })

  test('"in menus" writes the disabled flag, and clearing it removes the field', async () => {
    const offer = async () => options.control(await options.listRow(LIST, 'gross'), 'button', 'Offer Gross when marking a work')
    const pressed = async () => (await offer()).evaluate(el => el.getAttribute('aria-pressed') === 'true')
    assert.equal(await pressed(), true, 'offered until it says otherwise')
    await options.press(await offer())
    await sleep(1000)
    assert.equal((await storedMarks())?.marks?.gross?.disabled, true)
    assert.equal((await storedMarks())?.marks?.gross?.items, '', 'the mark itself is untouched')
    assert.equal(await pressed(), false)

    await options.press(await offer())
    await sleep(1000)
    assert.ok(!('disabled' in (await storedMarks()).marks.gross), 'back to the shape it shipped as')
    assert.equal(await pressed(), true)
  })

  test('the pencil renames a mark without moving the key its works are filed under', async () => {
    await clickNamed('Rename Good')
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
    await clickNamed('Change the Great icon')
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
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
      'Add mark',
      'focus goes back to the button that opened the dialog',
    )
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

  /**
   * The two settings that speak for every hiding mark rather than one: the
   * work-marks row's only dropdown and only number box.
   */
  const modeBox = async () => options.control(await options.row(ROW), 'combobox')
  const priorityBox = async () => options.control(await options.row(ROW), 'spinbutton')
  const hideSettings = async () => ({
    mode: await options.text(await modeBox()),
    priority: await (await priorityBox()).evaluate(el => el.value),
  })

  test('the mode and priority fall back to their defaults on a table that predates them', async () => {
    // SEED stores neither field, which is every table written before they
    // existed — the row has to answer with the shipped defaults rather than
    // with nothing.
    const got = await hideSettings()
    assert.match(got.mode, /^Collapse/, 'collapsed to a reason line')
    assert.equal(got.priority, '9', 'above an "always show" rule at its own default of 4')
  })

  test('typing a priority stores it against the whole table, not one mark', async () => {
    await (await priorityBox()).evaluate((box) => {
      box.focus()
      box.select()
    })
    await page.keyboard.press('Backspace')
    await page.keyboard.type('3')
    await sleep(1000)

    const stored = await storedMarks()
    assert.equal(stored?.hidePriority, 3)
    // The page edits a clone of the defaults and writes the option whole, so
    // the mode is written too — as the default it was already showing.
    assert.equal(stored?.hideMode, 'collapse')
    assert.ok(stored?.marks?.read, 'and the marks themselves came along unharmed')
  })

  test('renders without console errors', () => {
    assert.deepEqual(options.problems(), [])
  })

  /** The sort in the list's header, named for the sort it shows. */
  const sortButton = async view => view.control(await view.list(LIST), 'button', /^Sort: /)

  /** Choose a sort from the header's menu, and return the choice the menu then shows as checked. */
  const sortBy = async (view, choice) => {
    await view.press(await sortButton(view))
    await view.page.waitForSelector('[role="menuitemradio"]')
    await view.page.evaluate(text => [...document.querySelectorAll('[role="menuitemradio"]')]
      .find(item => item.textContent.trim() === text)
      .click(), choice)
    await sleep(300)
  }

  /** Whether the move button so named is inert, and what it is described by. */
  const moveState = async (view, name) => {
    const button = await view.control(await view.list(LIST), 'button', name)
    return { disabled: await button.evaluate(el => el.disabled), why: await view.description(button) }
  }

  test('a sort shows the marks another way, writes nothing, and holds the order still until your order is back', async () => {
    const counted = await session.open({ seed: COUNTED, hash: HASH })
    try {
      const yourOrder = ['read', 'favorite', 'good', 'gross', 'continue']
      assert.equal(await counted.name(await sortButton(counted)), 'Sort: Your order', 'the list starts in your order')
      assert.deepEqual(await counted.listRowIds(LIST), yourOrder)
      assert.deepEqual(await moveState(counted, 'Move Favorite up'), { disabled: false, why: '' })

      await sortBy(counted, 'Works')
      assert.equal(await counted.name(await sortButton(counted)), 'Sort: Works')
      assert.deepEqual(await counted.listRowIds(LIST), ['continue', 'favorite', 'read', 'gross', 'good'], 'most works first')
      for (const name of ['Move Read up', 'Move Favorite up', 'Move Favorite down', 'Move Gross down'])
        assert.deepEqual(await moveState(counted, name), { disabled: true, why: ORDER_OFF }, name)
      await counted.press(await counted.control(await counted.list(LIST), 'button', 'Move Favorite up'))

      await sortBy(counted, 'Name')
      assert.deepEqual(await counted.listRowIds(LIST), ['favorite', 'good', 'gross', 'continue', 'read'], 'Favorite, Good, Gross, Ongoing, Read')
      assert.deepEqual(await moveState(counted, 'Move Favorite down'), { disabled: true, why: ORDER_OFF })

      await sortBy(counted, 'Your order')
      assert.deepEqual(await counted.listRowIds(LIST), yourOrder)
      assert.deepEqual(await moveState(counted, 'Move Favorite up'), { disabled: false, why: '' })
      assert.deepEqual(await moveState(counted, 'Move Read up'), { disabled: true, why: '' }, 'the first mark still has nowhere to go')

      await sleep(500)
      assert.equal(await counted.lastWrite(KEY), null, 'no sort and no inert press writes a thing')

      await sortBy(counted, 'Works')
      await counted.page.reload({ waitUntil: 'networkidle2' })
      await sleep(1500)
      assert.equal(await counted.name(await sortButton(counted)), 'Sort: Your order', 'a visit starts in your order')
      assert.deepEqual(await counted.listRowIds(LIST), yourOrder)
      assert.deepEqual(counted.problems(), [])
    }
    finally {
      await counted.close()
    }
  })

  test('Clear asks again in its own place, and only the second press clears', async () => {
    const counted = await session.open({ seed: COUNTED, hash: HASH })
    try {
      const clear = async id => counted.control(await counted.listRow(LIST, id), 'button', /^Clear /)
      assert.equal(await counted.name(await clear('favorite')), 'Clear Favorite marks')
      assert.equal(await (await clear('good')).evaluate(el => el.disabled), true, 'a mark on no works has nothing to clear')

      await counted.press(await clear('favorite'))
      await sleep(300)
      assert.equal(await counted.text(await clear('favorite')), 'Clear 3?', 'armed, saying how many it would clear')
      assert.equal(await counted.lastWrite(KEY), null, 'nothing cleared on the first press')

      await counted.press(await clear('read'))
      await sleep(300)
      assert.equal(await counted.text(await clear('read')), 'Clear 2?')
      assert.equal(await counted.name(await clear('favorite')), 'Clear Favorite marks', 'arming one disarms the other')

      await counted.press(await clear('read'))
      await sleep(1000)
      const stored = await counted.lastWrite(KEY)
      assert.equal(stored.marks.read.items, '', 'cleared on the second press')
      assert.equal(stored.marks.favorite.items, '3,1,1', 'and nothing else')
      assert.match(await counted.text(await counted.listRow(LIST, 'read')), /0 works/)
      assert.equal(await (await clear('read')).evaluate(el => el.disabled), true)
      assert.equal(await counted.listCount(LIST), '5 · 8 works')
    }
    finally {
      await counted.close()
    }
  })

  test('at a phone\'s width every mark keeps its name whole and its controls inside the frame', async () => {
    const narrow = await session.open({ seed: COUNTED, hash: HASH, viewport: { width: 390, height: 844 } })
    try {
      const layout = await narrow.page.evaluate((id) => {
        const frame = document.querySelector(`[data-list="${id}"]`).getBoundingClientRect()
        return {
          frame: { left: frame.left, right: frame.right },
          scroll: document.documentElement.scrollWidth - window.innerWidth,
          rows: [...document.querySelectorAll(`[data-list="${id}"] [data-list-row]`)].map((row) => {
            const name = row.querySelector('[title^="id: "]')
            const boxes = [...row.querySelectorAll('button')].map(b => b.getBoundingClientRect())
            return {
              mark: row.dataset.listRow,
              clipped: name.scrollWidth > name.clientWidth,
              left: Math.min(...boxes.map(b => b.left)),
              right: Math.max(...boxes.map(b => b.right)),
            }
          }),
        }
      }, LIST)
      assert.ok(layout.scroll <= 0, `no sideways scroll: ${layout.scroll}`)
      for (const row of layout.rows) {
        assert.ok(!row.clipped, `${row.mark}'s name is shown whole`)
        assert.ok(row.left >= layout.frame.left && row.right <= layout.frame.right, `${row.mark}'s controls are inside the frame: ${JSON.stringify({ row, frame: layout.frame })}`)
      }
    }
    finally {
      await narrow.close()
    }
  })
})
