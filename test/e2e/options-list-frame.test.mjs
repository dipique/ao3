import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { sleep } from './helpers.mjs'
import { skip, startOptions } from './optionsPage.mjs'

/** The Word count menu's ranges: a list inside a setting, so it shows seven rows before it scrolls. */
const RANGES = 'word-count-ranges'
const CAP = 7

/** The Word count menu, on, with `count` distinct ranges. */
function seed(count) {
  const ranges = Array.from({ length: count }, (_, i) => ({ from: (i + 1) * 1000, to: (i + 1) * 1000 + 500 }))
  return { 'option.wordCountToolbar': { enabled: true, ranges } }
}

/** The list's body and its rows, as boxes in the window. */
function frameBoxes(id) {
  const frame = document.querySelector(`[data-list="${id}"]`)
  const body = frame.querySelector('[data-list-body]')
  const box = (el) => {
    const { top, bottom, left, right, width, height } = el.getBoundingClientRect()
    return { top, bottom, left, right, width, height }
  }
  return {
    body: {
      ...box(body),
      scrollTop: body.scrollTop,
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
      gutter: body.offsetWidth - body.clientWidth,
    },
    rows: [...frame.querySelectorAll('[data-list-row]')].map(box),
  }
}

/** The sum of these numbers. */
const total = heights => heights.reduce((sum, height) => sum + height, 0)

/** Within half a pixel, as boxes measure. */
function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= 0.5, `${message}: ${actual} against ${expected}`)
}

/**
 * The list frame, on its first list, the Word count menu's ranges: as tall as
 * its rows up to its cap and seven rows past it, however tall a row is; room
 * kept for the scrollbar from the start, so no row moves when the list starts
 * to scroll; a shadow at an edge only while there is more past it; and the
 * header and a row's error legible in both themes.
 *
 * Scrollbars are drawn, and take room, as they do outside a test.
 */
describe('options UI — list frame', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions({ scrollbars: true })
  }, { timeout: 180000 })

  after(() => session?.close())

  const open = (count, viewport = { width: 1440, height: 900 }) =>
    session.open({ seed: seed(count), hash: '#filter-defaults', viewport })

  test('below its cap, the body is exactly as tall as its rows, and does not scroll', async () => {
    const options = await open(2)
    try {
      const { body, rows } = await options.page.evaluate(frameBoxes, RANGES)
      assert.equal(rows.length, 2)
      near(body.height, total(rows.map(row => row.height)), 'the body against its rows')
      assert.equal(body.scrollHeight, body.clientHeight, 'nothing to scroll')
      for (const row of rows)
        near(row.height, 32, 'a row')
    }
    finally {
      await options.close()
    }
  })

  test('an open bound\'s placeholder fits its field, at a row\'s full width and in a narrow frame', async () => {
    const ranges = [{ from: null, to: 1000 }, { from: 5000, to: null }]
    for (const width of [1440, 390]) {
      const options = await session.open({
        seed: { 'option.wordCountToolbar': { enabled: true, ranges } },
        hash: '#filter-defaults',
        viewport: { width, height: 900 },
      })
      try {
        const clipped = await options.page.evaluate(id => [...document.querySelectorAll(`[data-list="${id}"] input`)]
          .filter(input => !input.value)
          .flatMap((input) => {
            input.value = input.placeholder
            const overflows = input.scrollWidth > input.clientWidth
            input.value = ''
            return overflows ? [input.placeholder] : []
          }), RANGES)
        assert.deepEqual(clipped, [], `at ${width} px`)
      }
      finally {
        await options.close()
      }
    }
  })

  test('past its cap, the body shows seven rows and scrolls the rest', async () => {
    const options = await open(12)
    try {
      const { body, rows } = await options.page.evaluate(frameBoxes, RANGES)
      assert.equal(rows.length, 12)
      near(body.height, total(rows.slice(0, CAP).map(row => row.height)), 'the body against its first seven rows')
      assert.ok(body.scrollHeight > body.clientHeight, 'the rest scrolls')
    }
    finally {
      await options.close()
    }
  })

  test('at a phone\'s width a row takes two lines, and the cap still counts seven rows', async () => {
    const options = await open(12, { width: 390, height: 844 })
    try {
      const { body, rows } = await options.page.evaluate(frameBoxes, RANGES)
      assert.ok(rows.every(row => row.height > 40), `each range wraps its label under its bounds: ${rows.map(row => row.height)}`)
      near(body.height, total(rows.slice(0, CAP).map(row => row.height)), 'the body against its first seven rows')
      assert.ok(body.scrollHeight > body.clientHeight, 'the rest scrolls')
    }
    finally {
      await options.close()
    }
  })

  test('growing past the cap moves no row: the scrollbar\'s room is kept from the start', async () => {
    const options = await open(CAP)
    try {
      const before = await options.page.evaluate(frameBoxes, RANGES)
      assert.equal(before.body.scrollHeight, before.body.clientHeight, 'at the cap, nothing scrolls yet')
      assert.ok(before.body.gutter > 0, 'room is kept for a scrollbar before there is one')

      await options.press(await options.control(await options.list(RANGES), 'button', 'Add a range'))
      await sleep(300)
      const after = await options.page.evaluate(frameBoxes, RANGES)
      assert.equal(after.rows.length, CAP + 1)
      assert.ok(after.body.scrollHeight > after.body.clientHeight, 'past the cap, it scrolls')
      assert.equal(after.body.gutter, before.body.gutter, 'the scrollbar fills the room kept for it')
      assert.deepEqual(
        after.rows.slice(0, CAP).map(row => [row.left, row.width]),
        before.rows.map(row => [row.left, row.width]),
        'no row moves or narrows',
      )
    }
    finally {
      await options.close()
    }
  })

  for (const [count, where] of [[CAP, 'the first range past the cap'], [12, 'a range added past the cap']]) {
    test(`${where} scrolls into sight, its first bound ready to type in`, async () => {
      const options = await open(count)
      try {
        await options.press(await options.control(await options.list(RANGES), 'button', 'Add a range'))
        await sleep(600)
        const { body, rows } = await options.page.evaluate(frameBoxes, RANGES)
        const added = rows.at(-1)
        const height = await options.page.evaluate(() => window.innerHeight)
        assert.equal(rows.length, count + 1)
        assert.ok(added.top >= body.top - 0.5 && added.bottom <= body.bottom + 0.5, `the new row is in the body's sight: ${JSON.stringify({ added, body })}`)
        assert.ok(added.top >= 0 && added.bottom <= height, `the new row is in the window: ${JSON.stringify({ added, height })}`)
        const focused = await options.page.evaluate(id => [...document.querySelector(`[data-list="${id}"]`).querySelectorAll('[data-list-row]')]
          .at(-1)
          .contains(document.activeElement), RANGES)
        assert.ok(focused, 'the focus is in the new row')
        assert.equal(await options.page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Lowest word count')
      }
      finally {
        await options.close()
      }
    })
  }

  test('an edge shows a shadow only while there is more past it', async () => {
    /**
     * The colour just inside the body's top and bottom edges, half way across,
     * with its rows scrolled `rows` rows down. Rows are scrolled by whole rows,
     * so both edges fall where one row meets the next, clear of the bounds and
     * the label drawn in the middle of each row.
     */
    const edges = async (options, rows) => {
      const box = await options.page.evaluate((id, by) => {
        const body = document.querySelector(`[data-list="${id}"] [data-list-body]`)
        body.scrollIntoView({ block: 'center', behavior: 'instant' })
        const heights = [...body.querySelectorAll('[data-list-row]')].map(row => row.getBoundingClientRect().height)
        body.scrollTop = by === 'end' ? body.scrollHeight : heights.slice(0, by).reduce((sum, h) => sum + h, 0)
        const { top, bottom, left, width } = body.getBoundingClientRect()
        return { top, bottom, middle: left + body.clientWidth / 2, width }
      }, RANGES, rows)
      await sleep(100)
      const x = Math.round(box.middle)
      return {
        top: await options.colourAt(x, Math.ceil(box.top) + 1),
        bottom: await options.colourAt(x, Math.floor(box.bottom) - 2),
      }
    }

    const ground = async options => options.token('default')
    const plain = (colour, ground, where) => assert.deepEqual(colour, ground, `no shadow ${where}`)
    const shaded = (colour, ground, where) => assert.ok(
      colour.every((channel, i) => channel <= ground[i] - 8),
      `a shadow ${where}: ${colour} against the ground ${ground}`,
    )

    const short = await open(2)
    try {
      const bare = await ground(short)
      const still = await edges(short, 0)
      plain(still.top, bare, 'at the top of a list that doesn\'t scroll')
      plain(still.bottom, bare, 'at the bottom of a list that doesn\'t scroll')
    }
    finally {
      await short.close()
    }

    const long = await open(14)
    try {
      const bare = await ground(long)

      const atTop = await edges(long, 0)
      plain(atTop.top, bare, 'at the top, scrolled to the top')
      shaded(atTop.bottom, bare, 'at the bottom, with more below')

      const between = await edges(long, 3)
      shaded(between.top, bare, 'at the top, with more above')
      shaded(between.bottom, bare, 'at the bottom, with more below')

      const atEnd = await edges(long, 'end')
      shaded(atEnd.top, bare, 'at the top, with more above')
      plain(atEnd.bottom, bare, 'at the bottom, scrolled to the end')
    }
    finally {
      await long.close()
    }
  })

  for (const theme of ['light', 'dark']) {
    test(`the header's title and count read at AA, ${theme}`, async () => {
      const options = await session.open({ seed: seed(2), hash: '#filter-defaults', viewport: { width: 1440, height: 900 }, theme })
      try {
        const list = await options.list(RANGES)
        const title = await list.$(`[id="${await list.evaluate(el => el.getAttribute('aria-labelledby'))}"]`)
        for (const [part, handle] of [['title', title], ['count', await list.$('[data-list-count]')]]) {
          const ratio = await options.contrast(handle)
          assert.ok(ratio >= 4.5, `the ${part}: ${ratio.toFixed(2)}:1`)
        }
      }
      finally {
        await options.close()
      }
    })

    test(`a row's error is in the text colour beside a destructive glyph, ${theme}`, async () => {
      const ranges = [{ from: 1000, to: 2000 }, { from: 1000, to: 2000 }]
      const options = await session.open({
        seed: { 'option.wordCountToolbar': { enabled: true, ranges } },
        hash: '#filter-defaults',
        viewport: { width: 1440, height: 900 },
        theme,
      })
      try {
        for (const row of await options.listRows(RANGES)) {
          const error = await row.$('[data-list-error]')
          assert.ok(error, 'the row shows its error')
          assert.ok((await options.text(error)).endsWith('This range is already in the list.'))
          assert.deepEqual(await options.colour(error), await options.token('default-fg'), 'the words are in the text colour')
          const ratio = await options.contrast(error)
          assert.ok(ratio >= 4.5, `the words read at AA: ${ratio.toFixed(2)}:1`)
          const glyph = await error.$('[aria-hidden="true"]')
          assert.ok(glyph, 'a glyph marks the line')
          assert.deepEqual(await options.colour(glyph), await options.token('destructive'), 'the glyph carries the red')
        }
      }
      finally {
        await options.close()
      }
    })
  }
})
