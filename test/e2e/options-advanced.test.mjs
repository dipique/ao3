import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { captureDownloads, skip, startOptions, until } from './optionsPage.mjs'

const WIDE = { width: 1280, height: 800 }
const IMPORT_EXPORT = 'your-data-import-export-your-settings'
const FANDOM_IDS = 'your-data-learned-fandom-ids'

const learned = names => Object.fromEntries(names.map((name, i) => [name.toLowerCase(), { id: i + 1, name }]))

/** A key of every kind the export variants sort between. */
const SEED = {
  'option.verbose': false,
  'option.compressSearchUrls': false,
  'cache.searchLists': {},
  'blurbIndex': {},
  'workTextIndex': {},
  'workText.12': 'The text of work 12',
  'fandomCache.fandoms': learned(['Good Omens (TV)', 'Discworld - Terry Pratchett']),
  'fandomCache.characters': learned(['Crowley (Good Omens)']),
}

/** Each variant in the Export menu, as its item is named and described, with the file it saves and what that file holds. */
const VARIANTS = [
  {
    item: 'Export all',
    note: 'Recommended for backup',
    file: /^AO3-Enhancements_\d{4}-\d{2}-\d{2}_[\d-]{8}\.json$/,
    keeps: key => !key.startsWith('workText'),
  },
  {
    item: 'Export options only',
    note: 'Recommended for sharing with others',
    file: /^AO3-Enhancements_options_\d{4}-\d{2}-\d{2}_[\d-]{8}\.json$/,
    keeps: key => key.startsWith('option.'),
  },
  {
    item: 'Export cache only',
    note: 'Not generally useful/recommended',
    file: /^AO3-Enhancements_cache_\d{4}-\d{2}-\d{2}_[\d-]{8}\.json$/,
    keeps: key => key.startsWith('cache.') || key.startsWith('blurb'),
  },
]

const NEVER_IN_AN_EXPORT = 'Cached work text is never in any of the three: it is an order of magnitude larger than everything else, and can always be fetched again.'

/**
 * Advanced in the settings row: *Your data*'s buttons are the row's 28 px
 * controls, Export opens its three variants (and says what none of them
 * carries), each saving the keys it names, and *Learned fandom ids* exports and
 * clears what was learned. *Under the hood* is two switch rows.
 */
describe('options UI — Advanced', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  const open = () => session.open({
    seed: SEED,
    hash: '#your-data',
    viewport: WIDE,
    prepare: page => page.evaluateOnNewDocument(captureDownloads),
  })

  test('Your data\'s buttons are the row\'s 28 px controls', async () => {
    const options = await open()
    try {
      const buttons = [
        await options.control(await options.row(IMPORT_EXPORT), 'button', 'Import'),
        await options.control(await options.row(IMPORT_EXPORT), 'button', 'Export'),
        await options.control(await options.row(FANDOM_IDS), 'button', 'Export ids'),
        await options.control(await options.row(FANDOM_IDS), 'button', 'Clear'),
      ]
      for (const button of buttons) {
        const drawn = await button.evaluate((el) => {
          const style = getComputedStyle(el)
          return { height: el.getBoundingClientRect().height, fontSize: style.fontSize, radius: style.borderTopLeftRadius, disabled: el.disabled }
        })
        assert.deepEqual(drawn, { height: 28, fontSize: '12.5px', radius: '7px', disabled: false }, await options.name(button))
      }
    }
    finally {
      await options.close()
    }
  })

  test('Export offers its three variants, says what none of them carries, and each saves the keys it names', async () => {
    const options = await open()
    try {
      const all = Object.keys(SEED)
      for (const { item, file, keeps } of VARIANTS) {
        await options.press(await options.control(await options.row(IMPORT_EXPORT), 'button', 'Export'))
        await options.page.waitForSelector('[role="menu"]')
        const menu = await options.page.$('[role="menu"]')
        const items = await options.controls(menu, 'menuitem')
        assert.deepEqual(await Promise.all(items.map(handle => options.name(handle))), VARIANTS.map(variant => variant.item))
        assert.deepEqual(await Promise.all(items.map(handle => options.description(handle))), VARIANTS.map(variant => variant.note))
        assert.equal(await options.description(menu), NEVER_IN_AN_EXPORT)

        const before = await options.page.evaluate(() => window.__downloads.length)
        await (await options.control(menu, 'menuitem', item)).click()
        await until(`${item} to hand over its file`, () => options.page.evaluate(n => window.__downloads.length > n, before))
        const saved = await options.lastDownload()
        assert.ok(saved, `${item}: nothing was saved`)
        assert.match(saved.name, file)
        assert.deepEqual(Object.keys(JSON.parse(saved.text)).filter(key => all.includes(key)).sort(), all.filter(keeps).sort(), item)
      }
      assert.deepEqual(options.problems(), [])
    }
    finally {
      await options.close()
    }
  })

  test('Learned fandom ids exports what was learned, and Clear forgets it', async () => {
    const options = await open()
    try {
      const row = await options.row(FANDOM_IDS)
      await until('the learned ids to be counted', () => options.control(row, 'button', 'Export ids').then(button => button.evaluate(el => !el.disabled)))
      await options.press(await options.control(row, 'button', 'Export ids'))
      await until('the ids to be handed over', () => options.page.evaluate(() => window.__downloads.length > 0))
      const saved = await options.lastDownload()
      assert.match(saved.name, /^AO3-Enhancements_fandom-ids_\d{4}-\d{2}-\d{2}_[\d-]{8}\.json$/)
      assert.deepEqual(JSON.parse(saved.text), {
        fandoms: [{ name: 'Discworld - Terry Pratchett', id: 2 }, { name: 'Good Omens (TV)', id: 1 }],
        characters: [{ name: 'Crowley (Good Omens)', id: 1 }],
        relationships: [],
      })

      await options.press(await options.control(row, 'button', 'Clear'))
      await until('the clear to be said', async () => (await options.toasts()).includes('Cleared learned fandom ids'))
      assert.deepEqual(await options.stored('fandomCache.fandoms'), {})
      assert.deepEqual(await options.stored('fandomCache.characters'), {})
      assert.equal(await (await options.control(row, 'button', 'Export ids')).evaluate(el => el.disabled), true)
      assert.equal(await (await options.control(row, 'button', 'Clear')).evaluate(el => el.disabled), true)
    }
    finally {
      await options.close()
    }
  })

  test('Under the hood is two switch rows, each storing its option', async () => {
    const options = await session.open({ hash: '#under-the-hood', viewport: WIDE })
    try {
      const rows = await options.page.$$eval('[data-category="advanced"] [data-row-part="title"]', els => els
        .map(el => el.closest('[id]').id)
        .filter(id => id.startsWith('under-the-hood-')))
      assert.deepEqual(rows, ['under-the-hood-compress-filter-urls', 'under-the-hood-debug-mode'])
      for (const [id, key] of [['under-the-hood-compress-filter-urls', 'option.compressSearchUrls'], ['under-the-hood-debug-mode', 'option.verbose']]) {
        await options.press(await options.control(await options.row(id), 'switch'))
        await until(`${key} to be written`, async () => await options.lastWrite(key) !== null)
        assert.equal(await options.stored(key), true, id)
      }
    }
    finally {
      await options.close()
    }
  })
})
