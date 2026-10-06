import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { sleep } from './helpers.mjs'
import { skip, startOptions } from './optionsPage.mjs'

const SEARCH = 'Search settings by name or description'
const WIDE = { width: 1280, height: 800 }
const NARROW = { width: 390, height: 844 }

const THEME_ROW = 'appearance-extension-theme'
const THEME_DESCRIPTION = /^Light or dark for the extension's own pages/

/** The legacy per-device choice to hide descriptions, which the page deletes on load. */
const DESCRIPTIONS_KEY = 'ao3e:options:descriptions'

/**
 * The page's frame: the top bar (name, settings search, theme switch) and the
 * rail, at the two widths they change shape between, and descriptions, which
 * always show.
 */
describe('options UI — the top bar and the rail', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  describe('descriptions', () => {
    test('always show, and the stored choice to hide them is deleted on load', async () => {
      const options = await session.open({
        hash: '#appearance',
        viewport: WIDE,
        // Once per tab, so that the reload below finds whatever the page left.
        prepare: page => page.evaluateOnNewDocument((key) => {
          if (!sessionStorage.getItem('seeded')) {
            localStorage.setItem(key, '0')
            sessionStorage.setItem('seeded', '1')
          }
        }, DESCRIPTIONS_KEY),
      })
      const holds = async () => {
        const lines = await options.lines(await options.row(THEME_ROW))
        assert.ok(lines.some(line => THEME_DESCRIPTION.test(line)), `the row read ${JSON.stringify(lines)}`)
        assert.deepEqual(await options.controls(options.page, 'switch', 'Descriptions'), [])
        assert.equal(await options.page.evaluate(key => localStorage.getItem(key), DESCRIPTIONS_KEY), null)
      }
      try {
        await holds()
        await options.page.reload({ waitUntil: 'networkidle2' })
        await sleep(1500)
        await holds()
      }
      finally {
        await options.close()
      }
    })
  })

  describe('the theme switch', () => {
    const themeSwitch = options => options.control(options.page, 'button', /^Switch to (?:light|dark) theme$/)
    /** The choice Appearance's own control shows, by its accessible name. */
    const appearanceChoice = async (options) => {
      const radios = await options.controls(await options.row(THEME_ROW), 'radio')
      for (const radio of radios) {
        if (await radio.evaluate(el => el.getAttribute('aria-checked') === 'true'))
          return options.name(radio)
      }
      return null
    }
    const bodyTheme = options => options.page.evaluate(() => document.body.classList.contains('dark') ? 'dark' : 'light')

    test('names the theme it switches to, and a press writes that choice, which Appearance shows', async () => {
      const options = await session.open({ hash: '#appearance', viewport: WIDE, theme: 'light' })
      try {
        const button = await themeSwitch(options)
        assert.equal(await options.name(button), 'Switch to dark theme')
        assert.equal(await appearanceChoice(options), 'Light')

        await options.press(button)
        await sleep(600)
        assert.equal((await options.stored('option.theme')).chosen, 'dark')
        assert.equal(await bodyTheme(options), 'dark')
        assert.equal(await options.name(await themeSwitch(options)), 'Switch to light theme')
        assert.equal(await appearanceChoice(options), 'Dark')
      }
      finally {
        await options.close()
      }
    })

    test('follows a change made in Appearance', async () => {
      const options = await session.open({ hash: '#appearance', viewport: WIDE, theme: 'dark' })
      try {
        assert.equal(await options.name(await themeSwitch(options)), 'Switch to light theme')
        await options.press(await options.control(await options.row(THEME_ROW), 'radio', 'Light'))
        await sleep(600)
        assert.equal((await options.stored('option.theme')).chosen, 'light')
        assert.equal(await options.name(await themeSwitch(options)), 'Switch to dark theme')
      }
      finally {
        await options.close()
      }
    })

    test('from following AO3, shows the theme AO3 resolved to and makes the opposite explicit', async () => {
      const options = await session.open({
        hash: '#appearance',
        viewport: WIDE,
        seed: { 'option.theme': { chosen: 'inherit', current: 'dark' } },
      })
      try {
        assert.equal(await bodyTheme(options), 'dark')
        assert.equal(await options.name(await themeSwitch(options)), 'Switch to light theme')
        assert.equal(await appearanceChoice(options), 'AO3')

        await options.press(await themeSwitch(options))
        await sleep(600)
        assert.deepEqual(await options.stored('option.theme'), { chosen: 'light', current: 'dark' })
        assert.equal(await appearanceChoice(options), 'Light')
      }
      finally {
        await options.close()
      }
    })
  })

  describe('the settings count', () => {
    test('is in the search field\'s prompt and the rail\'s foot, with the version and the line about reporting bugs', async () => {
      const options = await session.open({ viewport: WIDE })
      try {
        const prompt = await (await options.control(options.page, 'textbox', SEARCH)).evaluate(el => el.placeholder)
        const found = /^Search (\d+) settings$/.exec(prompt)
        assert.ok(found, `the search field's prompt was ${JSON.stringify(prompt)}`)
        const foot = (await options.lines(await options.rail())).join('\n')
        assert.match(foot, new RegExp(`\\b${found[1]} settings\\b`))
        assert.match(foot, /\bv0\.0\.0\b/, 'the version the manifest gives')
        assert.match(foot, /If you find a bug or have a feature request/)
        assert.ok(await options.control(await options.rail(), 'link', 'github repository'))
      }
      finally {
        await options.close()
      }
    })
  })

  describe('on a narrow window', () => {
    let options

    before(async () => {
      options = await session.open({ hash: '#reading', viewport: NARROW })
    })

    after(() => options?.close())

    test('the categories are a row of chips, with their shortest names', async () => {
      const chips = await options.railItems()
      assert.deepEqual(chips.map(c => c.kind), ['category', 'category', 'category', 'category', 'category'], 'no sub-sections on the chip row')
      assert.deepEqual(chips.map(c => c.name), ['Site features', 'Search', 'Reading', 'Sync', 'Advanced'])
      assert.deepEqual(chips.filter(c => c.current).map(c => c.name), ['Reading'])
    })

    test('a chip opens its category', async () => {
      await options.press(await (await options.rail()).$('[data-rail-item][href="#sync-backups"]'))
      await sleep(1600)
      assert.deepEqual(await options.shownCategories(), ['sync-backups'])
      assert.deepEqual((await options.railItems()).filter(c => c.current).map(c => c.name), ['Sync'])
    })

    test('the search is an icon that opens the field, and Escape closes it again', async () => {
      const field = await options.control(options.page, 'textbox', SEARCH)
      assert.equal(await field.evaluate(el => el.checkVisibility()), false)

      await (await options.control(options.page, 'button', 'Search settings')).click()
      await sleep(300)
      assert.equal(await field.evaluate(el => el.checkVisibility()), true)
      assert.equal(await field.evaluate(el => el === document.activeElement), true, 'the field takes the focus')

      await field.type('collapse')
      await sleep(400)
      assert.deepEqual(await options.shownCategories(), ['site-features-appearance', 'search'])

      await options.page.keyboard.press('Escape')
      await sleep(400)
      assert.equal(await field.evaluate(el => el.value), '')
      assert.equal(await field.evaluate(el => el.checkVisibility()), false)
      assert.deepEqual(await options.shownCategories(), ['sync-backups'])
    })

    /** The accessible name of whatever has the focus, or null when nothing does. */
    const focused = () => options.page.evaluate(() => {
      const el = document.activeElement
      return el && el !== document.body ? el.getAttribute('aria-label') ?? el.textContent.trim() : null
    })

    test('closing the search hands the focus back to the icon that opened it', async () => {
      await (await options.control(options.page, 'button', 'Search settings')).click()
      await sleep(300)
      await options.page.keyboard.press('Escape')
      await sleep(400)
      assert.equal(await focused(), 'Search settings', 'after Escape')

      await (await options.control(options.page, 'button', 'Search settings')).click()
      await sleep(300)
      await (await options.control(options.page, 'button', 'Close the settings search')).click()
      await sleep(400)
      assert.equal(await focused(), 'Search settings', 'after the close button')
    })

    test('a query typed on a wide window keeps its field in view when the window narrows', async () => {
      const wide = await session.open({ hash: '#reading', viewport: WIDE })
      try {
        const field = await wide.control(wide.page, 'textbox', SEARCH)
        await field.type('collapse')
        await sleep(400)
        await wide.page.setViewport(NARROW)
        await sleep(400)
        assert.deepEqual(await wide.shownCategories(), ['site-features-appearance', 'search'], 'the query still filters the pane')
        assert.equal(await field.evaluate(el => el.checkVisibility()), true, 'so the field that holds it shows')
      }
      finally {
        await wide.close()
      }
    })

    test('the current category\'s chip is scrolled into view', async () => {
      const last = await session.open({ hash: '#advanced', viewport: NARROW })
      try {
        const chip = await (await last.rail()).$('[data-rail-item][aria-current="true"]')
        assert.equal(await last.name(chip), 'Advanced')
        const { left, right } = await chip.evaluate(el => el.getBoundingClientRect().toJSON())
        assert.ok(left >= 0 && right <= NARROW.width, `the chip spans ${left}–${right} px of a ${NARROW.width} px window`)
      }
      finally {
        await last.close()
      }
    })
  })
})
