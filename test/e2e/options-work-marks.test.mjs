import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { MARK_ORDER_OFF } from '../../src/options_ui/model/listView.ts'
import { numbers } from '../facts.mjs'
import { mentions, skip, startOptions } from './optionsPage.mjs'

const LIST = 'work-marks'
const ROW = 'marks-status-work-marks'
const KEY = 'option.workMarks'
const HASH = '#marks-status'

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

/** {@link SEED} with read on 600 works: over a kilobyte packed, where the cost to store them is worth a figure. */
const HEAVY = structuredClone(SEED)
HEAVY[KEY].marks.read.items = Array.from({ length: 600 }).fill('1').join(',')

/**
 * The work-marks row is built entirely from the stored mark table — one row per
 * mark that holds ids, its icon and colour from the table, and its "hide in
 * listings" toggle reading through the trigger alias. Nothing about `favorite`
 * or `gross` is written into the component, so a table with different marks in
 * it renders different rows.
 *
 * The list is a list frame: Add mark and a sort in its header, and each row a
 * mark's order buttons (or its pin), icon, name, count, Hide and In menus
 * toggles, and Clear, which asks again in its own place. A foot under the rows
 * says where the marks are kept and what they cost to store.
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

  /** The rendered rows: the mark's name, what its meta line says, and whether the hide toggle is on. */
  const rows = async () => Promise.all((await options.listRows(LIST)).map(async row => ({
    mark: await options.text(await row.$('[data-mark-name]')),
    on: await (await options.action(row, 'hide')).evaluate(el => el.getAttribute('aria-pressed') === 'true'),
    meta: await options.text(await row.$('[data-list-meta]')),
  })))

  /** Whether the mark's move button that does `action` is disabled, or null when it has none. */
  const moveButton = async (id, action) => {
    const [button] = await options.actions(await options.listRow(LIST, id), action)
    return button ? button.evaluate(el => el.disabled) : null
  }

  /** Press the control that does `action` in the mark's row. */
  const pressIn = async (id, action) => options.press(await options.action(await options.listRow(LIST, id), action))

  /**
   * Add mark, pressed the way a click that doesn't focus its button presses it
   * (Safari's, Firefox's on macOS), so focus is wherever an earlier dialog left
   * it.
   */
  const openAddDialog = async () => options.openDialog(await options.action(await options.list(LIST), 'add'))

  /** Press the open dialog's button that does `action`. */
  const clickDialogButton = action => page.evaluate(
    a => document.querySelector(`[role="dialog"] [data-action="${a}"]`)?.click(),
    action,
  )

  /** What the dialog currently shows: whether it adds or edits, the name, the key preview, and any error. */
  const dialogState = () => page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog)
      return null
    return {
      mode: dialog.dataset.markDialog ?? null,
      name: dialog.querySelector('input[name="mark-name"]')?.value ?? '',
      key: dialog.querySelector('code')?.textContent.trim() ?? null,
      error: dialog.querySelector('[role="alert"]')?.textContent.trim() ?? null,
      saveDisabled: dialog.querySelector('[data-action="save"]')?.disabled ?? null,
    }
  })

  /** Replace the dialog's name field, the way a reader would, and wait until it holds `text`. */
  const typeName = async (text) => {
    await page.click('[role="dialog"] input[name="mark-name"]', { clickCount: 3 })
    await page.keyboard.press('Backspace')
    await page.type('[role="dialog"] input[name="mark-name"]', text)
    await page.waitForFunction(value => document.querySelector('[role="dialog"] input[name="mark-name"]')?.value === value, {}, text)
  }

  /** Press the open dialog's Save, and wait until the dialog has closed and what it saved is written. */
  const saveDialog = async () => {
    await clickDialogButton('save')
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    await options.saved()
  }

  /** The last mark table written to storage. */
  const storedMarks = () => options.lastWrite('option.workMarks')

  test('renders one row per mark that holds ids, in table order', async () => {
    const got = await rows()
    assert.deepEqual(got.map(r => r.mark), ['Read', 'Favorite', 'Good', 'Gross', 'Ongoing'])
  })

  test('the frame is headed by the marks, and the works they are on', async () => {
    assert.deepEqual(numbers(await options.listCount(LIST)), [5, 4], 'five marks; read and favorite hold two works each')
  })

  /** The frame's foot, and where it is drawn against the frame and its scrolling rows. */
  const footOf = view => view.page.evaluate((id) => {
    const frame = document.querySelector(`[data-list="${id}"]`)
    const foot = frame.querySelector('[data-list-foot]')
    const body = frame.querySelector('[data-list-body]')
    if (!foot)
      return null
    return {
      text: foot.textContent.replace(/\s+/g, ' ').trim(),
      inBody: body.contains(foot),
      underBody: foot.getBoundingClientRect().top >= body.getBoundingClientRect().bottom - 0.5,
      inFrame: foot.getBoundingClientRect().bottom <= frame.getBoundingClientRect().bottom + 0.5,
    }
  }, LIST)

  test('a foot inside the frame, under its rows, says where the marks are kept', async () => {
    const foot = await footOf(options)
    assert.ok(foot, 'the frame has a foot')
    const { text, ...where } = foot
    assert.deepEqual(where, { inBody: false, underBody: true, inFrame: true }, 'outside the scrolling rows, under them, inside the frame')
    assert.ok(text, 'it says where they are kept')
    assert.deepEqual(numbers(text), [], 'a few marks take too little to be worth a figure')
  })

  test('past a kilobyte the foot says what the marks take of the sync budget', async () => {
    const heavy = await session.open({ seed: HEAVY, hash: HASH })
    try {
      const foot = await footOf(heavy)
      assert.ok(foot, 'the frame has a foot')
      assert.deepEqual(numbers(foot.text), [1.2, 100], 'what they take, in kilobytes, of the sync budget')
    }
    finally {
      await heavy.close()
    }
  })

  test('each control says what it does that its name doesn\'t', async () => {
    /** What the control says beyond its name: its tooltip, or its title. */
    const saysMore = async (control, said) => {
      assert.ok(said, `${await options.name(control)} has a tooltip`)
      assert.notEqual(said, await options.name(control), `${await options.name(control)}'s tooltip says more than its name`)
    }
    const ongoing = await options.listRow(LIST, 'continue')
    const read = await options.listRow(LIST, 'read')
    const readHide = await options.action(read, 'hide')
    const ongoingHide = await options.action(ongoing, 'hide')
    await saysMore(ongoingHide, await options.tooltip(ongoingHide))
    assert.notEqual(await options.tooltip(ongoingHide), await options.tooltip(readHide), 'a progress mark\'s hiding is its own')
    assert.ok(await ongoing.$eval('[data-mark-pin]', el => el.title), 'the pin says why Ongoing doesn\'t move')
    const offer = await options.action(await options.listRow(LIST, 'gross'), 'offer')
    await saysMore(offer, await options.tooltip(offer))
    for (const action of ['move-down', 'icon']) {
      const control = await options.action(read, action)
      await saysMore(control, await control.evaluate(el => el.title))
    }
  })

  test('shows each mark\'s count, and what it counts as', async () => {
    const got = await rows()
    assert.deepEqual(numbers(got[0].meta), [2])
    assert.deepEqual(numbers(got[1].meta), [2])
    assert.ok(mentions(got[1].meta, 'Read'), 'an aliased mark says what it behaves as')
    assert.deepEqual(numbers(got[2].meta), [0])
    assert.ok(!mentions(got[0].meta, 'Read'), 'the root mark aliases nothing')
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
    await pressIn('favorite', 'hide')
    await options.saved()
    const stored = await storedMarks()
    assert.equal(stored?.marks?.favorite?.hideSearchResult, false, 'diverging from the root is stored')
    assert.equal(stored?.marks?.read?.hideSearchResult, true, 'the root is untouched')
  })

  test('the ends of the run, and the ongoing mark, cannot be moved', async () => {
    assert.equal(await moveButton('read', 'move-up'), true, 'nothing above the first mark')
    assert.equal(await moveButton('read', 'move-down'), false)
    assert.equal(await moveButton('gross', 'move-down'), true, 'the last verdict cannot pass Ongoing')
    assert.equal(await moveButton('continue', 'move-up'), null, 'Ongoing has no move buttons at all')
    assert.equal(await moveButton('continue', 'move-down'), null)
  })

  test('moving a mark reorders the rows and stores the new order', async () => {
    await pressIn('favorite', 'move-up')
    await options.saved()

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
    const names = await (await options.list(LIST)).$$eval('[data-list-row]', els =>
      els.map(row => [row.dataset.listRow, row.querySelector('[data-mark-name]')]).map(([id, name]) => [id, name.getAttribute('title'), name.textContent.trim()]))
    assert.deepEqual(names.map(([id, , name]) => [id, name]), [
      ['favorite', 'Favorite'],
      ['read', 'Read'],
      ['good', 'Good'],
      ['gross', 'Gross'],
      ['continue', 'Ongoing'],
    ])
    for (const [id, title] of names)
      assert.ok(mentions(title, id), `${id}'s name carries its key for hovering`)
  })

  test('"in menus" writes the disabled flag, and clearing it removes the field', async () => {
    const offer = async () => options.action(await options.listRow(LIST, 'gross'), 'offer')
    const pressed = async () => (await offer()).evaluate(el => el.getAttribute('aria-pressed') === 'true')
    assert.equal(await pressed(), true, 'offered until it says otherwise')
    await options.press(await offer())
    await options.saved()
    assert.equal((await storedMarks())?.marks?.gross?.disabled, true)
    assert.equal((await storedMarks())?.marks?.gross?.items, '', 'the mark itself is untouched')
    assert.equal(await pressed(), false)

    await options.press(await offer())
    await options.saved()
    assert.ok(!('disabled' in (await storedMarks()).marks.gross), 'back to the shape it shipped as')
    assert.equal(await pressed(), true)
  })

  test('the pencil renames a mark without moving the key its works are filed under', async () => {
    await options.openDialog(await options.action(await options.listRow(LIST, 'good'), 'rename'))
    assert.deepEqual(await dialogState(), {
      mode: 'edit',
      name: 'Good',
      key: 'good',
      error: null,
      saveDisabled: false,
    })

    await typeName('Great')
    await saveDialog()

    const stored = await storedMarks()
    assert.equal(stored.marks.good.label, 'Great', 'the display name moved')
    assert.ok(!stored.marks.great, 'and nothing else did')
    assert.deepEqual((await rows()).map(r => r.mark), ['Favorite', 'Read', 'Great', 'Gross', 'Ongoing'])
  })

  test('the row icon opens the same dialog, where the palette sets the icon', async () => {
    await options.openDialog(await options.action(await options.listRow(LIST, 'good'), 'icon'))
    assert.deepEqual(await dialogState().then(state => [state.mode, state.name]), ['edit', 'Great'])

    await page.evaluate(() => {
      [...document.querySelectorAll('[role="dialog"] button')].find(b => b.title === 'mdi/star')?.click()
    })
    await saveDialog()

    assert.equal((await storedMarks()).marks.good.icon, 'mdi/star')
  })

  test('a name whose key is taken is refused rather than merged', async () => {
    await openAddDialog()
    assert.equal((await dialogState()).mode, 'add')

    await typeName('read')
    const state = await dialogState()
    assert.ok(state.error, 'the name is refused, saying why')
    assert.equal(state.saveDisabled, true, 'and there is no way to save it anyway')
    const error = await page.$('[role="dialog"] [role="alert"]')
    assert.deepEqual(await options.colour(error), await options.token('default-fg'), 'the error\'s words are in the text colour')
    const glyph = await error.$('[data-glyph]')
    assert.ok(glyph, 'a glyph marks the error')
    assert.deepEqual(await options.colour(glyph), await options.token('destructive'), 'and carries the red')

    await clickDialogButton('cancel')
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    assert.ok(
      await (await options.action(await options.list(LIST), 'add')).evaluate(el => document.activeElement === el),
      'focus goes back to the button that opened the dialog',
    )
  })

  test('adding a mark files it under a key worked out from the name', async () => {
    await openAddDialog()

    await typeName('Did Not Finish')
    assert.equal((await dialogState()).key, 'did-not-finish', 'shown before it is committed to')

    await saveDialog()

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
    mode: await (await modeBox()).evaluate(el => el.dataset.value),
    priority: await (await priorityBox()).evaluate(el => el.value),
  })

  test('the mode and priority fall back to their defaults on a table that predates them', async () => {
    // SEED stores neither field, which is every table written before they
    // existed — the row has to answer with the shipped defaults rather than
    // with nothing.
    const got = await hideSettings()
    assert.equal(got.mode, 'collapse', 'collapsed to a reason line')
    assert.equal(got.priority, '9', 'above an "always show" rule at its own default of 4')
  })

  test('typing a priority stores it against the whole table, not one mark', async () => {
    await (await priorityBox()).evaluate((box) => {
      box.focus()
      box.select()
    })
    await page.keyboard.press('Backspace')
    await page.keyboard.type('3')
    await options.saved()

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

  /** The sort in the list's header. */
  const sortButton = async view => view.action(await view.list(LIST), 'sort')
  /** The sort the list shows, by its value. */
  const shownSort = async view => (await sortButton(view)).evaluate(el => el.dataset.sort)

  /** Choose a sort, by its value, from the header's menu. */
  const sortBy = async (view, choice) => {
    await view.press(await sortButton(view))
    await view.page.waitForSelector('[role="menuitemradio"]')
    await view.page.evaluate(value => document.querySelector(`[role="menuitemradio"][data-sort="${value}"]`).click(), choice)
    await view.page.waitForFunction(() => !document.querySelector('[role="menuitemradio"]'))
  }

  /** Whether the mark's move button that does `action` is inert, and what it is described by. */
  const moveState = async (view, id, action) => {
    const button = await view.action(await view.listRow(LIST, id), action)
    return { disabled: await button.evaluate(el => el.disabled), why: await view.description(button) }
  }

  test('a sort shows the marks another way, writes nothing, and holds the order still until your order is back', async () => {
    const counted = await session.open({ seed: COUNTED, hash: HASH })
    try {
      const yourOrder = ['read', 'favorite', 'good', 'gross', 'continue']
      assert.equal(await shownSort(counted), 'order', 'the list starts in your order')
      assert.deepEqual(await counted.listRowIds(LIST), yourOrder)
      assert.deepEqual(await moveState(counted, 'favorite', 'move-up'), { disabled: false, why: '' })

      await sortBy(counted, 'works')
      assert.equal(await shownSort(counted), 'works')
      assert.deepEqual(await counted.listRowIds(LIST), ['continue', 'favorite', 'read', 'gross', 'good'], 'most works first')
      for (const [id, action] of [['read', 'move-up'], ['favorite', 'move-up'], ['favorite', 'move-down'], ['gross', 'move-down']])
        assert.deepEqual(await moveState(counted, id, action), { disabled: true, why: MARK_ORDER_OFF }, `${id} ${action}`)
      await counted.press(await counted.action(await counted.listRow(LIST, 'favorite'), 'move-up'))

      await sortBy(counted, 'name')
      assert.deepEqual(await counted.listRowIds(LIST), ['favorite', 'good', 'gross', 'continue', 'read'], 'Favorite, Good, Gross, Ongoing, Read')
      assert.deepEqual(await moveState(counted, 'favorite', 'move-down'), { disabled: true, why: MARK_ORDER_OFF })

      await sortBy(counted, 'order')
      assert.deepEqual(await counted.listRowIds(LIST), yourOrder)
      assert.deepEqual(await moveState(counted, 'favorite', 'move-up'), { disabled: false, why: '' })
      assert.deepEqual(await moveState(counted, 'read', 'move-up'), { disabled: true, why: '' }, 'the first mark still has nowhere to go')

      await counted.saved()
      assert.equal(await counted.lastWrite(KEY), null, 'no sort and no inert press writes a thing')

      await sortBy(counted, 'works')
      await counted.reload()
      assert.equal(await shownSort(counted), 'order', 'a visit starts in your order')
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
      const clear = async id => counted.action(await counted.listRow(LIST, id), 'clear')
      const armed = async id => (await clear(id)).evaluate(el => el.dataset.armed !== undefined)
      assert.equal(await armed('favorite'), false)
      assert.equal(await (await clear('good')).evaluate(el => el.disabled), true, 'a mark on no works has nothing to clear')

      await counted.press(await clear('favorite'))
      await counted.saved()
      assert.equal(await armed('favorite'), true, 'armed')
      assert.deepEqual(numbers(await counted.text(await clear('favorite'))), [3], 'saying how many it would clear')
      assert.equal(await counted.lastWrite(KEY), null, 'nothing cleared on the first press')

      await counted.press(await clear('read'))
      assert.deepEqual(numbers(await counted.text(await clear('read'))), [2])
      assert.equal(await armed('favorite'), false, 'arming one disarms the other')

      await counted.press(await clear('read'))
      await counted.saved()
      const stored = await counted.lastWrite(KEY)
      assert.equal(stored.marks.read.items, '', 'cleared on the second press')
      assert.equal(stored.marks.favorite.items, '3,1,1', 'and nothing else')
      assert.deepEqual(numbers(await counted.text(await (await counted.listRow(LIST, 'read')).$('[data-list-meta]'))), [0])
      assert.equal(await (await clear('read')).evaluate(el => el.disabled), true)
      assert.deepEqual(numbers(await counted.listCount(LIST)), [5, 8])
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
            const name = row.querySelector('[data-mark-name]')
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
