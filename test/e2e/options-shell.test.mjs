import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { numbers } from '../facts.mjs'
import { mentions, skip, startOptions, until } from './optionsPage.mjs'

const SEARCH = '[data-settings-search]'
const WIDE = { width: 1280, height: 800 }
const NARROW = { width: 390, height: 844 }

const THEME_ROW = 'appearance-extension-theme'

/** A query no setting answers to, whatever the settings say: the pane holds nothing while it stands. */
const NO_SUCH_SETTING = 'qqzxqqzx'

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
        const description = await (await options.row(THEME_ROW)).$('[data-row-part="description"]')
        assert.ok(description, 'the row has a description')
        assert.ok(await description.evaluate(el => el.checkVisibility() && el.textContent.trim() !== ''), 'and shows it')
        assert.equal(await options.page.evaluate(key => localStorage.getItem(key), DESCRIPTIONS_KEY), null)
      }
      try {
        await holds()
        await options.reload()
        await holds()
      }
      finally {
        await options.close()
      }
    })
  })

  describe('the theme switch', () => {
    const themeSwitch = options => options.action(options.page, 'switch-theme')
    /** The theme the switch would switch to. */
    const switchesTo = async options => (await themeSwitch(options)).evaluate(el => el.dataset.switchTo)
    /** The choice Appearance's own control shows, by its value. */
    const appearanceChoice = async (options) => {
      const radios = await options.controls(await options.row(THEME_ROW), 'radio')
      for (const radio of radios) {
        if (await radio.evaluate(el => el.getAttribute('aria-checked') === 'true'))
          return radio.evaluate(el => el.getAttribute('value'))
      }
      return null
    }
    const bodyTheme = options => options.page.evaluate(() => document.body.classList.contains('dark') ? 'dark' : 'light')

    test('names the theme it switches to, and a press writes that choice, which Appearance shows', async () => {
      const options = await session.open({ hash: '#appearance', viewport: WIDE, theme: 'light' })
      try {
        const button = await themeSwitch(options)
        assert.equal(await switchesTo(options), 'dark')
        assert.ok(mentions(await options.name(button), 'dark'), 'it is named for the theme it switches to')
        assert.equal(await appearanceChoice(options), 'light')

        await options.press(button)
        await until('the choice to be written', async () => (await options.stored('option.theme')).chosen === 'dark')
        assert.equal(await bodyTheme(options), 'dark')
        assert.equal(await switchesTo(options), 'light')
        assert.ok(mentions(await options.name(await themeSwitch(options)), 'light'))
        assert.equal(await appearanceChoice(options), 'dark')
      }
      finally {
        await options.close()
      }
    })

    test('follows a change made in Appearance', async () => {
      const options = await session.open({ hash: '#appearance', viewport: WIDE, theme: 'dark' })
      try {
        assert.equal(await switchesTo(options), 'light')
        await options.press(await (await options.row(THEME_ROW)).$('[role="radio"][value="light"]'))
        await until('the choice to be written', async () => (await options.stored('option.theme')).chosen === 'light')
        assert.equal(await switchesTo(options), 'dark')
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
        assert.equal(await switchesTo(options), 'light')
        assert.equal(await appearanceChoice(options), 'inherit')

        await options.press(await themeSwitch(options))
        await until('the choice to be written', async () => (await options.stored('option.theme')).chosen === 'light')
        assert.deepEqual(await options.stored('option.theme'), { chosen: 'light', current: 'dark' })
        assert.equal(await appearanceChoice(options), 'light')
      }
      finally {
        await options.close()
      }
    })
  })

  describe('the settings count', () => {
    test('is in the search field\'s prompt and the rail\'s foot, with the version and where to report bugs', async () => {
      const options = await session.open({ viewport: WIDE })
      try {
        const prompt = await (await options.page.$(SEARCH)).evaluate(el => el.placeholder)
        const [count] = numbers(prompt)
        assert.ok(count > 0, `the search field's prompt was ${JSON.stringify(prompt)}`)
        const foot = (await options.lines(await options.rail())).join('\n')
        assert.ok(numbers(foot).includes(count), `the foot read ${JSON.stringify(foot)}`)
        assert.ok(mentions(foot, '0.0.0'), 'the version the manifest gives')
        assert.ok(await (await options.rail()).$('a[href="https://github.com/dipique/ao3"]'), 'where to report a bug')
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

    test('the categories are a row of chips', async () => {
      const chips = await options.railItems()
      assert.deepEqual(chips.map(c => c.kind), ['category', 'category', 'category', 'category', 'category', 'category'], 'no sub-sections on the chip row')
      assert.deepEqual(chips.map(c => c.id), ['site-features-appearance', 'search', 'lists', 'reading', 'sync-backups', 'advanced'])
      assert.deepEqual(chips.filter(c => c.current).map(c => c.id), ['reading'])
    })

    test('a chip opens its category', async () => {
      const chip = await (await options.rail()).$('[data-rail-item][href="#sync-backups"]')
      await options.land(() => options.press(chip))
      assert.deepEqual(await options.shownCategories(), ['sync-backups'])
      assert.deepEqual((await options.railItems()).filter(c => c.current).map(c => c.id), ['sync-backups'])
    })

    test('the search is an icon that opens the field, and Escape closes it again', async () => {
      const field = await options.page.$(SEARCH)
      assert.equal(await field.evaluate(el => el.checkVisibility()), false)

      await (await options.action(options.page, 'open-search')).click()
      await until('the field to show, with the focus', () => field.evaluate(el => el.checkVisibility() && el === document.activeElement))

      await field.type(NO_SUCH_SETTING)
      await until('the query to filter the pane', async () => (await options.shownCategories()).length === 0)

      await options.page.keyboard.press('Escape')
      await until('the field to close', () => field.evaluate(el => !el.checkVisibility()))
      assert.equal(await field.evaluate(el => el.value), '')
      assert.deepEqual(await options.shownCategories(), ['sync-backups'])
    })

    /** What the control that has the focus does, by its `data-action`, or null when nothing has it. */
    const focused = () => options.page.evaluate(() => document.activeElement?.dataset?.action ?? null)

    test('closing the search hands the focus back to the icon that opened it', async () => {
      const field = await options.page.$(SEARCH)
      const opened = () => until('the field to show, with the focus', () => field.evaluate(el => el.checkVisibility() && el === document.activeElement))

      await (await options.action(options.page, 'open-search')).click()
      await opened()
      await options.page.keyboard.press('Escape')
      await until('the focus back on the icon after Escape', async () => await focused() === 'open-search')

      await (await options.action(options.page, 'open-search')).click()
      await opened()
      await (await options.action(options.page, 'close-search')).click()
      await until('the focus back on the icon after the close button', async () => await focused() === 'open-search')
    })

    test('a query typed on a wide window keeps its field in view when the window narrows', async () => {
      const wide = await session.open({ hash: '#reading', viewport: WIDE })
      try {
        const field = await wide.page.$(SEARCH)
        await field.type(NO_SUCH_SETTING)
        await until('the query to filter the pane', async () => (await wide.shownCategories()).length === 0)
        await wide.page.setViewport(NARROW)
        await until('the narrow layout, with no rail beside the pane', () => wide.page.evaluate(() => matchMedia('(max-width: 767.98px)').matches))
        assert.deepEqual(await wide.shownCategories(), [], 'the query still filters the pane')
        assert.equal(await field.evaluate(el => el.value), NO_SUCH_SETTING)
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
        assert.equal(await chip.evaluate(a => a.hash), '#advanced')
        const { left, right } = await chip.evaluate(el => el.getBoundingClientRect().toJSON())
        assert.ok(left >= 0 && right <= NARROW.width, `the chip spans ${left}–${right} px of a ${NARROW.width} px window`)
      }
      finally {
        await last.close()
      }
    })
  })
})
