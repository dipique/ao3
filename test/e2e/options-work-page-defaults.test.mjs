import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { skip, startOptions } from './optionsPage.mjs'

/** The switch rows, the option each writes, and the section they are under. */
const SWITCH_ROWS = {
  'show-full-work': { key: 'option.showFullWork', hash: '#work-text' },
  'show-comments': { key: 'option.showComments', hash: '#work-text' },
  'opportunistic-blurbs': { key: 'option.opportunisticBlurbs', hash: '#offline-reading' },
}
const CACHE_ROW = 'opportunistic-cache'

/**
 * The work page's defaults under Reading → Work text, and what a visit to a
 * work keeps under Lists → Offline reading: each switch writes its option, and
 * the caching row's select writes which works it keeps, or none.
 */
describe('options UI — what a work page does', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  for (const [id, { key, hash }] of Object.entries(SWITCH_ROWS)) {
    test(`${id} switches its option on and off`, async () => {
      const options = await session.open({ hash, viewport: { width: 1280, height: 800 } })
      try {
        const toggle = async () => {
          await options.press(await options.control(await options.row(id), 'switch'))
          await options.saved()
        }
        await toggle()
        assert.equal(await options.lastWrite(key), true)
        await toggle()
        assert.equal(await options.lastWrite(key), false)
        assert.deepEqual(options.problems(), [])
      }
      finally {
        await options.close()
      }
    })
  }

  test('the caching row\'s select stores the works it keeps, and none', async () => {
    const options = await session.open({ hash: '#offline-reading', viewport: { width: 1280, height: 800 } })
    try {
      const select = await options.control(await options.row(CACHE_ROW), 'combobox')
      const pick = async (value) => {
        await select.evaluate(el => window.scrollBy({ top: el.getBoundingClientRect().top - window.innerHeight / 2, behavior: 'instant' }))
        await select.click()
        await options.page.waitForSelector('[role="option"]')
        await options.calm()
        await (await options.page.$(`[role="option"][data-value="${value}"]`)).click()
        await options.saved()
      }
      assert.equal(await select.evaluate(el => el.getAttribute('data-value')), null, 'off to begin with')
      await pick('tracked')
      assert.equal(await options.lastWrite('option.opportunisticCache'), 'tracked')
      await pick('markedForLater')
      assert.equal(await options.lastWrite('option.opportunisticCache'), 'markedForLater')
      assert.deepEqual(options.problems(), [])
    }
    finally {
      await options.close()
    }
  })
})
