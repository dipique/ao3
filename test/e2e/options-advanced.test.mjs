import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { captureDownloads, skip, startOptions, until } from './optionsPage.mjs'
import { toastTypes } from './trackedPages.mjs'

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

/** Each variant in the Export menu, by what its item does, with the file it saves and what that file holds. */
const VARIANTS = [
  {
    item: 'all',
    file: /^AO3-Enhancements_\d{4}-\d{2}-\d{2}_[\d-]{8}\.json$/,
    keeps: key => !key.startsWith('workText'),
  },
  {
    item: 'options',
    file: /^AO3-Enhancements_options_\d{4}-\d{2}-\d{2}_[\d-]{8}\.json$/,
    keeps: key => key.startsWith('option.'),
  },
  {
    item: 'cache',
    file: /^AO3-Enhancements_cache_\d{4}-\d{2}-\d{2}_[\d-]{8}\.json$/,
    keeps: key => key.startsWith('cache.') || key.startsWith('blurb'),
  },
]

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
        await options.action(await options.row(IMPORT_EXPORT), 'import'),
        await options.action(await options.row(IMPORT_EXPORT), 'export'),
        await options.action(await options.row(FANDOM_IDS), 'export'),
        await options.action(await options.row(FANDOM_IDS), 'clear'),
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
        await options.press(await options.action(await options.row(IMPORT_EXPORT), 'export'))
        await options.page.waitForSelector('[role="menu"]')
        const menu = await options.page.$('[role="menu"]')
        assert.deepEqual(await options.menuActions(), VARIANTS.map(variant => variant.item))
        for (const handle of await options.controls(menu, 'menuitem')) {
          assert.ok(await options.name(handle), 'each variant is named')
          assert.ok(await options.description(handle), 'and says who it is for')
        }
        assert.ok(await options.description(menu), 'the menu says what none of them carries')

        const before = await options.page.evaluate(() => window.__downloads.length)
        await (await options.menuItem(item)).click()
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
      await until('the learned ids to be counted', () => options.action(row, 'export').then(button => button.evaluate(el => !el.disabled)))
      await options.press(await options.action(row, 'export'))
      await until('the ids to be handed over', () => options.page.evaluate(() => window.__downloads.length > 0))
      const saved = await options.lastDownload()
      assert.match(saved.name, /^AO3-Enhancements_fandom-ids_\d{4}-\d{2}-\d{2}_[\d-]{8}\.json$/)
      assert.deepEqual(JSON.parse(saved.text), {
        fandoms: [{ name: 'Discworld - Terry Pratchett', id: 2 }, { name: 'Good Omens (TV)', id: 1 }],
        characters: [{ name: 'Crowley (Good Omens)', id: 1 }],
        relationships: [],
      })

      await options.press(await options.action(row, 'clear'))
      await until('the clear to be said', async () => (await toastTypes(options.page)).includes('success'))
      assert.deepEqual(await options.stored('fandomCache.fandoms'), {})
      assert.deepEqual(await options.stored('fandomCache.characters'), {})
      assert.equal(await (await options.action(row, 'export')).evaluate(el => el.disabled), true)
      assert.equal(await (await options.action(row, 'clear')).evaluate(el => el.disabled), true)
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
