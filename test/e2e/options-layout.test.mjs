import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { sleep } from './helpers.mjs'
import { skip, startOptions } from './optionsPage.mjs'

const WIDTHS = [1440, 1024, 768, 390]
const THEMES = ['light', 'dark']

/** A plain switch row, outside any group. */
const PLAIN_ROW = 'page-controls-reveal-filtered-works'
/** A row inside the master group's bracket. */
const GROUPED_ROW = 'link-menus-menu-on-tags'
/** A switch that reveals more, seeded on so its inset shows. */
const INSET_ROW = 'filter-defaults-default-language'
const SEED = { 'option.searchLanguage': { enabled: true, language: null } }
/** A row whose control is two buttons, too wide to sit beside the text in a phone's width. */
const WIDE_CONTROL_ROW = 'your-data-import-export-your-settings'

/** The title, description and control of a settings row, and its inset panel if it has one, as rounded boxes. */
function rowBoxes(id) {
  const row = document.getElementById(id)
  const box = (el) => {
    if (!el || !el.checkVisibility())
      return null
    const { top, bottom, left, right, width } = el.getBoundingClientRect()
    return { top: Math.round(top), bottom: Math.round(bottom), left: Math.round(left), right: Math.round(right), width: Math.round(width) }
  }
  const part = name => box(row.querySelector(`[data-row-part="${name}"]`))
  return { title: part('title'), description: part('description'), control: part('control'), inset: box(row.querySelector('[data-row-inset]')) }
}

/** A colour token as `getComputedStyle` writes a colour. */
function token(name) {
  const [r, g, b] = getComputedStyle(document.body).getPropertyValue(`--color-${name}`).trim().split(/\s+/)
  return `rgb(${r}, ${g}, ${b})`
}

/**
 * The page's frame at the widths it is drawn for, in both themes: one category
 * in the pane, the rail beside it or, below 768 px, a row of chips over it, the
 * foot's wrapping text spaced to be read, and nothing wider than the window.
 *
 * And the settings row: from 1024 px its title, description and control side
 * by side, in a 264 px title column and a control column of at least 180 px;
 * narrower, the description under the title with the control beside both, or
 * under them where it is too wide to leave the text room. Rows are parted by
 * `hair` lines, and what a switch reveals sits in a `sunken` inset across the
 * whole row.
 */
describe('options UI — layout', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test(`${width} px, ${theme}`, async () => {
        const options = await session.open({ viewport: { width, height: 900 }, theme, seed: SEED })
        const noSidewaysScroll = async () => {
          const { scrollWidth, innerWidth } = await options.page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
          }))
          assert.ok(scrollWidth <= innerWidth, `the page is ${scrollWidth} px wide in a ${innerWidth} px window`)
        }
        try {
          assert.equal(await options.page.evaluate(() => document.body.classList.contains('dark') ? 'dark' : 'light'), theme)

          assert.equal((await options.shownCategories()).length, 1, 'one category in the pane')

          const links = await (await options.rail()).$$eval('[data-rail-item="category"]', els => els
            .filter(el => el.checkVisibility())
            .map((el) => {
              const { top, left } = el.getBoundingClientRect()
              return { top: Math.round(top), left: Math.round(left) }
            }))
          assert.equal(links.length, 5, 'every category is on the rail')
          const tops = new Set(links.map(link => link.top))
          const lefts = new Set(links.map(link => link.left))
          if (width < 768) {
            assert.equal(tops.size, 1, `a single row of chips: ${JSON.stringify(links)}`)
          }
          else {
            assert.equal(lefts.size, 1, `a column down the rail: ${JSON.stringify(links)}`)
            assert.equal(tops.size, links.length, `a column down the rail: ${JSON.stringify(links)}`)
          }

          const foot = await options.page.$$eval('footer p', els => els
            .filter(el => el.checkVisibility())
            .map((el) => {
              const style = getComputedStyle(el)
              return { size: Number.parseFloat(style.fontSize), leading: Number.parseFloat(style.lineHeight) }
            }))
          assert.ok(foot.length, 'the foot is on the page')
          for (const { size, leading } of foot)
            assert.ok(leading >= size * 1.3, `the foot's lines are ${leading} px apart for ${size} px text`)

          await noSidewaysScroll()

          const { title, description, control } = await options.page.evaluate(rowBoxes, PLAIN_ROW)
          const layout = JSON.stringify({ title, description, control })
          assert.ok(title && description && control, `the row's parts: ${layout}`)
          if (width >= 1024) {
            assert.equal(title.width, 264, `a 264 px title column: ${layout}`)
            assert.ok(control.width >= 180, `a control column of at least 180 px: ${layout}`)
            assert.ok(title.right < description.left && description.right < control.left, `title, description and control side by side: ${layout}`)
            assert.ok(Math.abs(title.top - description.top) <= 2, `the description beside the title: ${layout}`)

            const grouped = await options.page.evaluate(rowBoxes, GROUPED_ROW)
            assert.equal(grouped.description.left, description.left, 'a grouped row\'s description lines up with the rows outside the group')
            assert.equal(grouped.control.right, control.right, 'and so does its control')
          }
          else {
            assert.equal(description.left, title.left, `the description under the title: ${layout}`)
            assert.ok(description.top >= title.bottom - 1, `the description under the title: ${layout}`)
            assert.ok(control.left >= Math.max(title.right, description.right), `the control beside both: ${layout}`)
          }

          const separator = await options.page.evaluate((id) => {
            const style = getComputedStyle(document.getElementById(id))
            return { width: style.borderTopWidth, style: style.borderTopStyle, color: style.borderTopColor }
          }, PLAIN_ROW)
          assert.deepEqual(separator, { width: '1px', style: 'solid', color: await options.page.evaluate(token, 'hair') }, 'a hair line between rows')

          await options.page.evaluate((hash) => {
            location.hash = hash
          }, '#filter-defaults')
          await sleep(600)
          const revealed = await options.page.evaluate(rowBoxes, INSET_ROW)
          assert.ok(revealed.inset, `the inset shows: ${JSON.stringify(revealed)}`)
          assert.equal(revealed.inset.left, revealed.title.left, `the inset starts at the row's left edge: ${JSON.stringify(revealed)}`)
          assert.equal(revealed.inset.right, revealed.control.right, `and ends at its right edge: ${JSON.stringify(revealed)}`)
          assert.ok(revealed.inset.top >= Math.max(revealed.description.bottom, revealed.control.bottom), `below the row: ${JSON.stringify(revealed)}`)
          const insetColour = await options.page.evaluate(id => getComputedStyle(document.getElementById(id).querySelector('[data-row-inset]')).backgroundColor, INSET_ROW)
          assert.equal(insetColour, await options.page.evaluate(token, 'sunken'), 'the inset is sunken')

          await noSidewaysScroll()

          await options.page.evaluate((hash) => {
            location.hash = hash
          }, '#advanced')
          await sleep(600)
          const wide = await options.page.evaluate(rowBoxes, WIDE_CONTROL_ROW)
          const wideLayout = JSON.stringify(wide)
          if (width < 768) {
            assert.ok(wide.control.top >= wide.description.bottom, `a wide control drops under the text: ${wideLayout}`)
            assert.ok(wide.title.width >= 13 * 16, `leaving the text its width: ${wideLayout}`)
          }
          else {
            assert.ok(wide.control.left >= wide.description.right, `a wide control beside the text: ${wideLayout}`)
          }
          if (width >= 1024) {
            const narrowest = await options.page.$$eval('[data-category="advanced"] [data-row-part="description"]', els => Math.min(...els
              .filter(el => el.checkVisibility())
              .map(el => el.getBoundingClientRect().width)))
            assert.ok(narrowest >= 10 * 16, `every description in Advanced, beside its wide controls, keeps 10rem: the narrowest is ${narrowest} px`)
          }

          await noSidewaysScroll()
        }
        finally {
          await options.close()
        }
      })
    }
  }
})
