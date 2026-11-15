import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { ANCHOR_ALIASES, isAnchorKey } from '../../src/options_ui/model/anchors.ts'
import { skip, startOptions, until } from './optionsPage.mjs'

/** An alias of the row `key`, which the table must have. */
function aliasOf(key) {
  const alias = Object.entries(ANCHOR_ALIASES).find(([, to]) => to === key)?.[0]
  assert.ok(alias, `#${key} has an alias`)
  return alias
}

/**
 * What a category, sub-section or settings row is known by: a key written
 * beside it, never its title, so renaming a setting moves no link, bookmark
 * or test. A row's other ids still find it: a link written with one lands on
 * it, and a bookmark stored under one is the row's bookmark.
 */
describe('options UI — anchor keys', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  test('every category, sub-section and settings row has a key of its own, written as a hash is read', async () => {
    const options = await session.open({ viewport: { width: 1280, height: 800 } })
    try {
      const ids = await options.page.evaluate(() => [
        ...document.querySelectorAll('[data-category]'),
        ...document.querySelectorAll('main section[id]:not([data-category])'),
        ...document.querySelectorAll('.option-row'),
      ].map(el => el.id))
      assert.ok(ids.length > 60, `${ids.length} anchors`)
      assert.deepEqual(ids.filter(id => !isAnchorKey(id)), [], 'each key is written as a hash is read')
      assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'no two share a key')
      const missing = await options.page.evaluate(keys => keys.filter(key => !document.getElementById(key)), Object.values(ANCHOR_ALIASES))
      assert.deepEqual(missing, [], 'every alias leads to something on the page')
      assert.deepEqual(options.problems(), [])
    }
    finally {
      await options.close()
    }
  })

  test('a link naming a row by one of its other ids lands on the row', async () => {
    const options = await session.open({ hash: `#${aliasOf('hide-author-toolbar')}`, viewport: { width: 1280, height: 800 } })
    try {
      assert.deepEqual(await options.shownCategories(), ['site-features-appearance'])
      const onScreen = await (await options.row('hide-author-toolbar')).evaluate((el) => {
        const { top, bottom } = el.getBoundingClientRect()
        return el.checkVisibility() && top >= 0 && bottom <= innerHeight
      })
      assert.ok(onScreen, 'the row is in view')
    }
    finally {
      await options.close()
    }
  })

  test('a bookmark stored under one of a row\'s other ids is the row\'s, and a change stores bookmarks by key', async () => {
    const seed = { 'option.bookmarkedSettings': { ids: [aliasOf('reader-mode'), 'rules'] } }
    const options = await session.open({ seed, hash: '#search', viewport: { width: 1280, height: 800 } })
    try {
      const bookmarks = async () => (await options.railItems()).filter(item => item.kind === 'bookmark').map(item => item.id)
      assert.deepEqual((await bookmarks()).sort(), ['reader-mode', 'rules'])
      const pressed = async id => (await (await options.row(id)).$('[data-bookmark]')).evaluate(el => el.getAttribute('aria-pressed'))
      assert.equal(await pressed('reader-mode'), 'true')

      await options.press(await (await options.row('rules')).$('[data-bookmark]'))
      await until('the bookmark to be taken off', async () => (await pressed('rules')) === 'false')
      await options.saved()
      assert.deepEqual((await options.stored('option.bookmarkedSettings')).ids, ['reader-mode'])
    }
    finally {
      await options.close()
    }
  })
})
