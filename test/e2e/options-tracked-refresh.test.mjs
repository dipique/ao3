import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { copyKeyOf } from '../../src/common/listLinks.ts'
import { copyQuery, packRows } from '../../src/common/trackedReads.ts'
import { SCAN_REFRESH_TIP } from '../../src/options_ui/model/savedListRows.ts'
import { mentions, skip, startOptions, stubArchive, until } from './optionsPage.mjs'
import { archiveAnswers, listing, readsOf, resetWorkIds, series, TODAY, trackedOption } from './trackedReview.mjs'

/**
 * A tracked list's Refresh list, from its row under Saved lists: it reads the
 * list's offline copy by date, from the first day the copy isn't complete for,
 * and merges what it finds into the copy. Nothing it already holds is read
 * again, and nothing is taken off.
 */
describe('options UI — a tracked list\'s Refresh list', { skip }, () => {
  let session

  resetWorkIds(15000)
  const since = TODAY - 8
  const alpha = listing('alpha', Array.from({ length: 8 }, (_, i) => [since + i, 2]), { entry: { alias: 'Alpha', since } })
  const key = copyKeyOf(alpha.entry)
  const sid = work => Number(work.id).toString(36)
  /** The copy as an earlier read left it: complete through three days ago, plus a work AO3 no longer lists. */
  const held = alpha.works.filter(work => work.filed <= TODAY - 3)
  const copy = {
    v: 3,
    scrapedAt: Date.now() - 86_400_000,
    ids: ['gone1', ...held.map(sid)].join(','),
    descriptor: { sourceId: 'works-filter', label: 'Alpha', listUrl: 'https://archiveofourown.org/tags/alpha/works' },
    dated: { query: copyQuery([alpha.entry]), from: since, through: TODAY - 3, readAt: Date.now() - 86_400_000, rows: packRows([{ sid: 'gone1', day: since }, ...held.map(work => ({ sid: sid(work), day: work.filed }))]) },
  }
  const fetched = []

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  test('reads only the days the copy isn\'t complete for, and keeps what it held', async () => {
    const options = await session.open({
      seed: {
        'option.user': { userId: 'me' },
        'option.trackedLists': trackedOption([alpha], { reviewedThrough: since - 1 }),
        'cache.searchLists': { [key]: copy },
      },
      hash: '#saved-lists',
      viewport: { width: 1440, height: 900 },
      prepare: page => stubArchive(page, async url => archiveAnswers({ fixtures: [alpha], fetched })(new URL(url))),
    })
    try {
      const row = await options.savedListDetails('alpha')
      await options.press(await options.action(row, 'refresh'))
      const stored = () => options.page.evaluate(async k => (await window.browser.storage.local.get('cache.searchLists'))['cache.searchLists'][k], key)
      await until('the copy to be complete through yesterday', async () => (await stored())?.dated.through === TODAY - 1)
      const asked = readsOf(fetched).filter(read => read.list === '/tags/alpha/works')
      assert.deepEqual(asked.map(read => [read.from, read.page]), [[TODAY - 2, 1]], 'read from the day after the copy is complete through')
      const ids = (await stored()).ids.split(',')
      assert.equal(ids.length, alpha.works.length + 1)
      assert.ok(ids.includes('gone1'), 'a work AO3 no longer lists stays')
      assert.deepEqual(options.problems(), [])
    }
    finally {
      await options.close()
    }
  })

  /** The options page on Saved lists, over `seed`, with the stand-in archive answering for `fixtures`. */
  const openWith = (seed, fixtures = [alpha]) => session.open({
    seed: { 'option.user': { userId: 'me' }, 'option.trackedLists': trackedOption(fixtures, { reviewedThrough: since - 1 }), ...seed },
    hash: '#saved-lists',
    viewport: { width: 1440, height: 900 },
    prepare: page => stubArchive(page, async url => archiveAnswers({ fixtures, fetched })(new URL(url))),
  })
  const storedCopy = (options, k = key) => options.page.evaluate(async one => (await window.browser.storage.local.get('cache.searchLists'))['cache.searchLists']?.[one], k)
  const askedSince = (from, list = '/tags/alpha/works') => readsOf(fetched.slice(from)).filter(read => read.list === list)

  test('Full refresh reads the list again from the day it is tracked from, keeping every work', async () => {
    const options = await openWith({ 'cache.searchLists': { [key]: copy } })
    try {
      const before = fetched.length
      const row = await options.savedListDetails('alpha')
      await options.press(await options.action(row, 'full-refresh'))
      await until('the copy to be read again', async () => (await storedCopy(options))?.dated.readAt > copy.dated.readAt)
      assert.deepEqual(askedSince(before).map(read => read.from), [since], 'from the day it is tracked from')
      const stored = await storedCopy(options)
      assert.equal(stored.dated.through, TODAY - 1)
      assert.ok(stored.ids.split(',').includes('gone1'), 'a work AO3 no longer lists stays')
    }
    finally {
      await options.close()
    }
  })

  test('a tracked list with no copy can be refreshed from its row, which keeps one', async () => {
    const options = await openWith({})
    try {
      const row = await options.savedListDetails('alpha')
      await options.press(await options.action(row, 'refresh'))
      await until('a copy to be kept', async () => (await storedCopy(options))?.dated?.through === TODAY - 1)
      assert.equal((await storedCopy(options)).dated.from, since)
    }
    finally {
      await options.close()
    }
  })

  test('a tracked series is read whole: its Refresh says so, and it has no Full refresh', async () => {
    const parts = series('91', [[since + 1, 2]], { entry: { since } })
    const options = await openWith({}, [parts])
    try {
      const row = await options.savedListDetails('91')
      const title = await (await options.action(row, 'refresh')).evaluate(el => el.title)
      assert.ok(mentions(title, SCAN_REFRESH_TIP), title)
      assert.equal(await row.$('[data-action="full-refresh"]'), null)
    }
    finally {
      await options.close()
    }
  })

  test('Reset list data deletes the copy, and the next refresh reads the list from the day it is tracked from', async () => {
    const options = await openWith({ 'cache.searchLists': { [key]: copy } })
    try {
      const row = await options.savedListDetails('alpha')
      const reset = await options.action(row, 'remove-copy')
      await options.press(reset)
      await until('it to ask', () => reset.evaluate(el => el.hasAttribute('data-armed')))
      await options.press(reset)
      await until('the copy to go', async () => (await storedCopy(options)) === undefined)
      const before = fetched.length
      await options.press(await options.action(await options.savedListDetails('alpha'), 'refresh'))
      await until('a copy to be kept again', async () => (await storedCopy(options))?.dated?.through === TODAY - 1)
      assert.deepEqual(askedSince(before).map(read => read.from), [since])
      assert.equal((await storedCopy(options)).ids.split(',').includes('gone1'), false, 'what the reset deleted is gone')
    }
    finally {
      await options.close()
    }
  })
})
