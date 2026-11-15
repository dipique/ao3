import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { skip, startOptions, until } from './optionsPage.mjs'

const RULES = 'rules'
const READER_MODE = 'reader-mode'

/**
 * Bookmarking a setting: the bookmark beside a row's title lists the row on
 * the rail, under its sub-section in the current category and under its
 * category in any other, and the rail's link jumps to it. Which rows are
 * bookmarked is stored with the options, so it outlasts a reload.
 */
describe('options UI — bookmarked settings', { skip }, () => {
  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({ hash: '#search', viewport: { width: 1280, height: 800 } })
  }, { timeout: 180000 })

  after(() => session?.close())

  const bookmarkOf = async (id) => {
    const handle = await (await options.row(id)).$('[data-bookmark]')
    assert.ok(handle, `no bookmark on #${id}`)
    return handle
  }
  const pressed = async id => (await bookmarkOf(id)).evaluate(el => el.getAttribute('aria-pressed'))
  /** The rail's links, in order, as `kind:id`. */
  const railOrder = async () => (await options.railItems()).map(item => `${item.kind}:${item.id}`)
  const stored = async () => (await options.stored('option.bookmarkedSettings'))?.ids ?? []

  test('no row is bookmarked to begin with, and the rail lists no bookmark', async () => {
    assert.equal(await pressed(RULES), 'false')
    assert.ok(!(await railOrder()).some(item => item.startsWith('bookmark:')))
  })

  test('bookmarking a row lists it on the rail under its sub-section, and stores it', async () => {
    const before = await options.stored('option.rules')
    await options.press(await bookmarkOf(RULES))
    await until('the bookmark to show as set', async () => (await pressed(RULES)) === 'true')

    const order = await railOrder()
    const at = order.indexOf(`bookmark:${RULES}`)
    assert.ok(at > 0, JSON.stringify(order))
    assert.equal(order[at - 1], 'subsection:customize-search-results')

    await options.saved()
    assert.deepEqual(await stored(), [RULES])
    assert.deepEqual(await options.stored('option.rules'), before, 'the row\'s own switch is left alone')
  })

  test('the bookmark is not part of the name of the row\'s control', async () => {
    const control = await (await options.row(RULES)).$('[role="switch"]')
    const name = await options.name(control)
    const bookmark = await options.name(await bookmarkOf(RULES))
    assert.ok(bookmark, 'the bookmark is named')
    assert.ok(!name.includes(bookmark), `the switch is named "${name}"`)
  })

  test('in another category, the bookmark is listed under its category', async () => {
    await options.goTo('#reading')
    const order = await railOrder()
    const at = order.indexOf(`bookmark:${RULES}`)
    assert.ok(at > 0, JSON.stringify(order))
    assert.equal(order[at - 1], 'category:search')
  })

  test('the rail\'s link jumps to the setting, in its category', async () => {
    const link = await (await options.rail()).$(`[data-rail-item="bookmark"][href="#${RULES}"]`)
    await options.land(() => options.press(link))
    assert.deepEqual(await options.shownCategories(), ['search'])
    const top = await (await options.row(RULES)).evaluate(el => el.getBoundingClientRect().top)
    assert.ok(top >= 0 && top < 800, `the row was at ${top}px`)
  })

  test('a name too long for the rail is cut short there, and given whole in its tooltip', async () => {
    const link = await (await options.rail()).$(`[data-rail-item="bookmark"][href="#${RULES}"]`)
    const label = await link.$('[data-rail-label]')
    const { title, overflow } = await label.evaluate(el => ({ title: el.closest('[title]')?.title, overflow: getComputedStyle(el).textOverflow }))
    assert.equal(overflow, 'ellipsis')
    assert.equal(title, await options.text(label))
  })

  test('a second bookmark is stored after the first', async () => {
    await options.goTo('#reading')
    await options.press(await bookmarkOf(READER_MODE))
    await until('the bookmark to show as set', async () => (await pressed(READER_MODE)) === 'true')
    await options.saved()
    assert.deepEqual(await stored(), [RULES, READER_MODE])
  })

  test('a page opened with bookmarks stored shows them', async () => {
    const opened = await session.open({
      seed: { 'option.bookmarkedSettings': { ids: [RULES, READER_MODE] } },
      hash: '#advanced',
      viewport: { width: 1280, height: 800 },
    })
    try {
      for (const id of [RULES, READER_MODE]) {
        const bookmark = await (await opened.row(id)).$('[data-bookmark]')
        assert.equal(await bookmark.evaluate(el => el.getAttribute('aria-pressed')), 'true', id)
      }
      const order = (await opened.railItems()).map(item => `${item.kind}:${item.id}`)
      assert.equal(order[order.indexOf(`bookmark:${RULES}`) - 1], 'category:search', JSON.stringify(order))
      assert.equal(order[order.indexOf(`bookmark:${READER_MODE}`) - 1], 'category:reading', JSON.stringify(order))
    }
    finally {
      await opened.close()
    }
  })

  test('pressing a set bookmark takes the row off the rail, and out of storage', async () => {
    const before = await options.stored('option.readerMode')
    await options.press(await bookmarkOf(READER_MODE))
    await until('the bookmark to show as unset', async () => (await pressed(READER_MODE)) === 'false')
    assert.ok(!(await railOrder()).includes(`bookmark:${READER_MODE}`))
    await options.saved()
    assert.deepEqual(await stored(), [RULES])
    assert.equal(await options.stored('option.readerMode'), before, 'the row\'s own switch is left alone')
  })

  test('nothing went wrong on the page', () => {
    assert.deepEqual(options.problems(), [])
  })
})
