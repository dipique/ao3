import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { skip, startOptions, until } from './optionsPage.mjs'

/** Rows editing options that sync: a switch inside the row, a slider row, and a row whose option is read around it. */
const SYNCED = ['under-the-hood-compress-filter-urls', 'work-statistics-reading-speed', 'customize-search-results-rules']
/** Rows that don't: one editing an option kept on this device, one badged as this device's, and one editing no option. */
const UNSYNCED = ['under-the-hood-debug-mode', 'work-text-reader-mode', 'your-data-import-export-your-settings']

/**
 * While sync is on, a row whose setting syncs carries a sync mark beside its
 * title, before the bookmark; with sync off, no row does.
 */
describe('options UI — which settings sync', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  const open = seed => session.open({ seed, hash: '#advanced', viewport: { width: 1280, height: 800 } })
  const marked = async (options, id) => !!(await (await options.row(id)).$('[data-synced]'))

  test('with sync off, no row is marked', async () => {
    const options = await open({ 'sync.enabled': false })
    try {
      assert.deepEqual(await options.page.$$('[data-synced]'), [])
    }
    finally {
      await options.close()
    }
  })

  describe('with sync on', () => {
    let options

    before(async () => {
      options = await open({ 'sync.enabled': true })
      await until('sync to be read as on', () => options.page.$('[data-synced]'))
    })

    after(() => options?.close())

    test('marks each row whose setting syncs, and no other', async () => {
      for (const id of SYNCED)
        assert.equal(await marked(options, id), true, id)
      for (const id of UNSYNCED)
        assert.equal(await marked(options, id), false, id)
    })

    test('the mark comes before the bookmark, and explains itself in a tooltip', async () => {
      const row = await options.row('under-the-hood-compress-filter-urls')
      const before = await row.evaluate(el => !!(el.querySelector('[data-synced]').compareDocumentPosition(el.querySelector('[data-bookmark]')) & Node.DOCUMENT_POSITION_FOLLOWING))
      assert.ok(before)
      assert.ok(await options.tooltip(await row.$('[data-synced]')))
    })

    test('turning sync off takes every mark away', async () => {
      await options.page.evaluate(() => window.browser.storage.local.set({ 'sync.enabled': false }))
      await until('the marks to go', async () => (await options.page.$$('[data-synced]')).length === 0)
    })

    test('nothing went wrong on the page', () => {
      assert.deepEqual(options.problems(), [])
    })
  })
})
