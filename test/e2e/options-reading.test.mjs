import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { skip, startOptions, until } from './optionsPage.mjs'

/** The rows with a slider beside their number, the option each edits, and the slider's far end. */
const SLIDER_ROWS = {
  'work-statistics-reading-speed': { key: 'option.wordsPerMinute', max: 1000 },
  'work-text-narrow-the-work-text': { key: 'option.styleWidth', max: 100 },
}
const ALIGNMENT = 'work-text-force-text-alignment'

/** Where a slider row's parts are drawn, as rounded boxes, and which part holds the slider. */
function sliderRow(id) {
  const row = document.getElementById(id)
  const box = (el) => {
    if (!el || !el.checkVisibility())
      return null
    const { top, bottom, left, right, width } = el.getBoundingClientRect()
    return { top: Math.round(top), bottom: Math.round(bottom), left: Math.round(left), right: Math.round(right), width: Math.round(width) }
  }
  const part = name => row.querySelector(`[data-row-part="${name}"]`)
  const thumb = row.querySelector('[role="slider"]')
  const slider = thumb?.parentElement ?? null
  const inset = row.querySelector('[data-row-inset]')
  return {
    title: box(part('title')),
    description: box(part('description')),
    control: box(part('control')),
    field: box(part('control').querySelector('input[type="number"]')),
    slider: box(slider),
    inset: box(inset),
    insetGround: inset && getComputedStyle(inset).backgroundColor,
    sunken: (() => {
      const [r, g, b] = getComputedStyle(document.body).getPropertyValue('--color-sunken').trim().split(/\s+/)
      return `rgb(${r}, ${g}, ${b})`
    })(),
    in: slider ? (part('control').contains(slider) ? 'control' : inset?.contains(slider) ? 'inset' : 'elsewhere') : null,
  }
}

/**
 * Reading in the settings row: *Reading speed* and *Narrow the work text* keep
 * their slider in the control cell, beside the number, where the row's parts
 * share a line (from 1024 px), and in an inset under the row below that; either
 * way it writes the option. *Force text alignment* is the row's 28 px select.
 */
describe('options UI — Reading', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  for (const width of [1440, 1024]) {
    test(`at ${width} px each slider sits in the control cell, before its number`, async () => {
      const options = await session.open({ hash: '#reading', viewport: { width, height: 900 } })
      try {
        for (const id of Object.keys(SLIDER_ROWS)) {
          const row = await options.page.evaluate(sliderRow, id)
          const layout = JSON.stringify(row)
          assert.equal(row.in, 'control', `${id}: ${layout}`)
          assert.equal(row.inset, null, `${id} has no inset: ${layout}`)
          assert.ok(row.slider.right <= row.field.left, `${id}: the slider before the number: ${layout}`)
          assert.ok(row.slider.left >= row.control.left && row.slider.left >= row.description.right, `${id}: and within the control cell, clear of the description: ${layout}`)
          assert.ok(row.slider.width >= 100, `${id}: a slider wide enough to drag: ${layout}`)
          assert.ok(Math.abs((row.slider.top + row.slider.bottom) - (row.field.top + row.field.bottom)) <= 2, `${id}: on the number's line: ${layout}`)
          assert.ok(row.description.width >= 10 * 16, `${id}: the description keeps 10rem: ${layout}`)
        }
      }
      finally {
        await options.close()
      }
    })
  }

  for (const width of [768, 390]) {
    test(`at ${width} px each slider sits in an inset across the row, under it`, async () => {
      const options = await session.open({ hash: '#reading', viewport: { width, height: 900 } })
      try {
        for (const id of Object.keys(SLIDER_ROWS)) {
          const row = await options.page.evaluate(sliderRow, id)
          const layout = JSON.stringify(row)
          assert.equal(row.in, 'inset', `${id}: ${layout}`)
          assert.ok(row.field, `${id}: the number stays in the control cell: ${layout}`)
          assert.equal(row.insetGround, row.sunken, `${id}: the inset is sunken`)
          assert.equal(row.inset.left, row.title.left, `${id}: the inset starts at the row's left edge: ${layout}`)
          assert.equal(row.inset.right, row.control.right, `${id}: and ends at its right edge: ${layout}`)
          assert.ok(row.inset.top >= Math.max(row.description.bottom, row.control.bottom), `${id}: below the row: ${layout}`)
        }
      }
      finally {
        await options.close()
      }
    })
  }

  for (const width of [1440, 390]) {
    test(`at ${width} px dragging a slider to its end stores the end, and leaves the focus alone`, async () => {
      const options = await session.open({ hash: '#reading', viewport: { width, height: 900 } })
      try {
        for (const [id, { key, max }] of Object.entries(SLIDER_ROWS)) {
          const row = await options.row(id)
          const thumb = await row.$('[role="slider"]')
          await thumb.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }))
          await options.frame()
          const track = await thumb.evaluate((el) => {
            const { left, right, top, bottom } = el.parentElement.getBoundingClientRect()
            return { left, right, y: (top + bottom) / 2 }
          })
          const x = (track.left + track.right) / 2
          await options.page.mouse.move(x, track.y)
          await options.page.mouse.down()
          await options.page.mouse.move(track.right + 200, track.y, { steps: 5 })
          await options.page.mouse.up()
          await until(`${id} to store its end`, async () => await options.stored(key) === max)

          assert.equal(await options.stored(key), max, id)
          assert.equal(await (await options.control(row, 'spinbutton')).evaluate(el => Number(el.value)), max, `${id} shows it`)
          assert.equal(await options.page.evaluate(() => document.activeElement?.type ?? null), null, `${id}: the drag moved the focus`)
        }
      }
      finally {
        await options.close()
      }
    })
  }

  test('Force text alignment is the row\'s 28 px select, and stores the alignment picked', async () => {
    const options = await session.open({ hash: '#work-text', viewport: { width: 1280, height: 800 } })
    try {
      const select = await options.control(await options.row(ALIGNMENT), 'combobox')
      const drawn = await select.evaluate((el) => {
        const style = getComputedStyle(el)
        return { height: el.getBoundingClientRect().height, fontSize: style.fontSize, radius: style.borderTopLeftRadius }
      })
      assert.deepEqual(drawn, { height: 28, fontSize: '12.5px', radius: '7px' })
      const shown = () => select.evaluate(el => el.getAttribute('data-value'))
      assert.equal(await shown(), null, 'no alignment forced')

      await select.evaluate(el => window.scrollBy({ top: el.getBoundingClientRect().top - window.innerHeight / 2, behavior: 'instant' }))
      await select.click()
      await options.page.waitForSelector('[role="option"]')
      await options.calm()
      const justify = await options.page.$('[role="option"][data-value="justify"]')
      const label = await options.text(justify)
      await justify.click()
      await options.saved()
      assert.equal(await options.lastWrite('option.forceAlignment'), 'justify')
      assert.equal(await shown(), 'justify')
      assert.equal(await options.text(select), label, 'the select shows the choice')
      assert.deepEqual(options.problems(), [])
    }
    finally {
      await options.close()
    }
  })

  test('at 390 px the select stays beside its text', async () => {
    const options = await session.open({ hash: '#work-text', viewport: { width: 390, height: 800 } })
    try {
      const row = await options.page.evaluate(sliderRow, ALIGNMENT)
      assert.ok(row.control.left >= row.description.right, `the select beside the text: ${JSON.stringify(row)}`)
    }
    finally {
      await options.close()
    }
  })
})
