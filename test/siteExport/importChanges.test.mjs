import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { markItems, packIds } from '../../src/common/workMarks.ts'
import { installMock } from '../e2e/helpers.mjs'
import { loadModuleInPage, skipWithoutChrome } from './helpers.mjs'

/**
 * The impure half of the round trip: what an ingest *writes*, and what it asks
 * of AO3.
 *
 * The decidable half is already covered with nothing under it —
 * {@link file://./replay.test.mjs} for what an op means and
 * {@link file://./changeOps.test.mjs} for the file it travels in — and what is
 * left is everything those two deliberately hand back as a value instead of
 * doing: one write to the mark table however many works were marked, a ledger
 * that only records an op once both its halves have happened, a saved-works
 * index corrected for what the archive accepted, and the archive request itself
 * with its fallback through an open AO3 tab.
 *
 * None of that is pure, but none of it needs an extension either. So this uses
 * the same rig the sanitizer does — one module bundled into a blank page — with
 * storage, `fetch` and `browser.tabs` stubbed under it. The end-to-end version
 * of the same round trip lives in `test/e2e/`, and it can only ever afford one
 * pass through the happy path; the ways it goes wrong are here.
 */

const skip = skipWithoutChrome

const AT = Date.UTC(2026, 8, 7, 12)
/** A scrape from after the ops — the only kind that can excuse an archive act. */
const SCRAPED = AT + 60_000

/**
 * Storage as a device that has scraped its own list once would hold it.
 *
 * The default index predates the ops, which is the case that says nothing: a
 * work missing from it is unknown rather than already off the list, so every
 * `markAsRead` still has something for AO3 to do.
 */
function seed({ listed = [], listedAt = AT - 60_000, owner = 'reader' } = {}) {
  return {
    'option.user': { userId: 'reader' },
    'cache.markedForLater': { userId: owner, updatedAt: listedAt, ids: packIds(new Set(listed)) },
    'cache.appliedChangeOps': [],
  }
}

/** One op, with the boilerplate filled in. */
function op(id, at, workId, kind, payload = { markId: 'boring', on: true }) {
  return { id, at, workId, op: kind, payload }
}

/** The file the exported page hands back. */
function file(ops, { sourceId = 'marked-for-later', exportedAt = AT, v = 1 } = {}) {
  return JSON.stringify({ v, sourceId, exportedAt, ops })
}

/**
 * Everything the module reaches that isn't storage, installed in the page after
 * {@link installMock} and before the bundle.
 *
 * `archive` is what AO3 answers a mark request with — `'ok'`, a status, or
 * `'network'` for a request that never gets an answer at all. `tabs` is the
 * reader's open AO3 tabs and what each would say if asked: an answer, or
 * `'silent'` for a tab with no content script under it.
 */
function installArchive() {
  const state = { fetches: [], sent: [], archive: 'ok', tabs: [] }
  window.__archive = state

  window.fetch = async (url, init = {}) => {
    const href = String(url)
    state.fetches.push({ url: href, method: init.method ?? 'GET', body: String(init.body ?? '') })
    if (href.includes('token_dispenser'))
      return new Response('{"token":"a-token"}', { status: 200, headers: { 'content-type': 'application/json' } })
    if (state.archive === 'network')
      throw new TypeError('Failed to fetch')
    return new Response('', { status: state.archive === 'ok' ? 200 : state.archive })
  }

  const tabs = {
    query: async () => state.tabs.map(tab => ({ id: tab.id, discarded: false })),
    sendMessage: async (tabId, message) => {
      state.sent.push({ tabId, message })
      const tab = state.tabs.find(entry => entry.id === tabId)
      if (!tab || tab.answer === 'silent')
        throw new Error('Could not establish connection. Receiving end does not exist.')
      return tab.answer
    },
  }

  // Layered over the mock rather than folded into it: `browser.tabs` is the one
  // API this module needs that no other test in the rig does.
  const patched = new Proxy(window.browser, {
    get: (target, prop) => (prop === 'tabs' ? tabs : target[prop]),
  })
  window.browser = patched
  window.chrome = patched
}

describe('siteExport/importChanges', { skip }, () => {
  let page
  let close

  before(async () => {
    ({ page, close } = await loadModuleInPage(
      'src/content_script/siteExport/importChanges.ts',
      'ImportChanges',
      {
        async prepare(blank) {
          await blank.evaluate(installMock, {})
          await blank.evaluate(installArchive)
        },
      },
    ))
  }, { timeout: 120000 })

  after(async () => close?.())

  /**
   * Put the page back to a known device. `ledger` is a count rather than a list
   * because the only test that wants a big one wants twenty thousand.
   */
  const reset = async ({ store = seed(), archive = 'ok', tabs = [], ledger = 0 } = {}) => {
    await page.evaluate(async (items, outcome, openTabs, ledgerSize) => {
      await window.browser.storage.local.clear()
      await window.browser.storage.local.set({
        ...items,
        ...ledgerSize ? { 'cache.appliedChangeOps': Array.from({ length: ledgerSize }, (_, i) => `old-${i}`) } : {},
      })
      window.__writes.length = 0
      window.__archive.fetches.length = 0
      window.__archive.sent.length = 0
      window.__archive.archive = outcome
      window.__archive.tabs = openTabs
    }, store, archive, tabs, ledger)
  }

  const run = (text, opts = { tellArchive: true }) => page.evaluate(
    (t, o) => window.ImportChanges.importChanges(t, o),
    text,
    opts,
  )

  /** Every value written to one storage key over the run, oldest first. */
  const writes = key => page.evaluate(
    k => window.__writes.filter(entry => k in entry).map(entry => entry[k]),
    key,
  )

  /** The mark requests the page made itself, and the ones it asked a tab to make. */
  const posted = () => page.evaluate(
    () => window.__archive.fetches.filter(entry => entry.url.includes('/mark_as_read')),
  )
  const delegated = () => page.evaluate(() => window.__archive.sent)

  test('the mark table is written once, however many works were marked', async () => {
    await reset()
    const report = await run(file([
      op('a', AT, '11', 'setMark'),
      op('b', AT + 1, '12', 'setMark'),
      op('c', AT + 2, '13', 'setMark'),
    ]))

    assert.equal(report.applied, 3)
    const tables = await writes('option.workMarks')
    assert.equal(tables.length, 1, 'one write, not one per op')
    assert.deepEqual([...markItems(tables[0].marks, 'boring')].sort(), ['11', '12', '13'])
    assert.deepEqual(await posted(), [], 'a plain mark is nothing to do with AO3')
  })

  /**
   * The one op with a half only the archive can do, and the two records that
   * have to agree with it afterwards.
   */
  test('a work AO3 was told about leaves the saved index, which keeps its date', async () => {
    await reset({ store: seed({ listed: ['11', '12'] }) })
    const report = await run(file([op('a', AT, '11', 'markAsRead')]))

    assert.equal(report.toldArchive, 1)
    assert.equal(report.viaTab, 0)
    const requests = await posted()
    assert.equal(requests.length, 1)
    assert.match(requests[0].url, /\/works\/11\/mark_as_read$/)
    assert.equal(requests[0].method, 'POST')
    assert.match(requests[0].body, /_method=patch/)
    assert.match(requests[0].body, /authenticity_token=a-token/)

    const [index] = await writes('cache.markedForLater')
    assert.ok(index, 'the index should have been corrected')
    assert.equal(index.updatedAt, AT - 60_000, 'a correction is not a fresh scrape')
    assert.equal(index.ids, packIds(new Set(['12'])))
  })

  test('an index belonging to another account is neither read nor written', async () => {
    // Listed, and scraped after the op — which for the reader's own index would
    // be grounds to skip the request as already done.
    await reset({ store: seed({ listed: ['11'], listedAt: SCRAPED, owner: 'someone-else' }) })
    const report = await run(file([op('a', AT, '11', 'markAsRead')]))

    assert.equal(report.toldArchive, 1, 'someone else\'s list says nothing about this one')
    assert.equal(report.skipped.length, 0)
    assert.deepEqual(await writes('cache.markedForLater'), [])
  })

  /**
   * The file is the queue: an op whose archive half didn't happen is not written
   * down as done, so the same file picks it up next time and nothing else.
   */
  test('an op AO3 refused stays owed, and a later import pays it', async () => {
    await reset({ archive: 403 })
    const first = await run(file([op('a', AT, '11', 'markAsRead')]))

    assert.equal(first.applied, 1, 'the local half happened')
    assert.equal(first.toldArchive, 0)
    assert.equal(first.archiveFailed.length, 1)
    assert.equal(first.archiveFailed[0].workId, '11')
    assert.match(first.archiveFailed[0].reason, /open AO3 in a tab/)
    assert.equal((await writes('option.workMarks')).length, 1)
    assert.deepEqual(await writes('cache.appliedChangeOps'), [], 'nothing is owed and ledgered at once')

    await page.evaluate(() => {
      window.__archive.archive = 'ok'
      window.__archive.fetches.length = 0
      window.__writes.length = 0
    })
    const second = await run(file([op('a', AT, '11', 'markAsRead')]))
    assert.equal(second.duplicates, 0, 'an unpaid op is not a duplicate')
    assert.equal(second.toldArchive, 1)
    const [ledger] = await writes('cache.appliedChangeOps')
    assert.deepEqual(ledger, ['a'])
  })

  test('holding the archive half defers it rather than dropping it', async () => {
    await reset()
    const report = await run(file([op('a', AT, '11', 'markAsRead')]), { tellArchive: false })

    assert.equal(report.applied, 1)
    assert.equal(report.archiveHeld, 1)
    assert.equal(report.toldArchive, 0)
    assert.deepEqual(await page.evaluate(() => window.__archive.fetches), [], 'nothing was asked of AO3, not even a token')
    assert.deepEqual(await writes('cache.appliedChangeOps'), [])
    assert.equal((await writes('option.workMarks')).length, 1, 'the local half still happened')
  })

  test('three refusals in a row leave the rest for another day', async () => {
    await reset({ archive: 500 })
    const ops = ['11', '12', '13', '14', '15'].map((workId, i) => op(`op-${i}`, AT + i, workId, 'markAsRead'))
    const report = await run(file(ops))

    assert.equal(report.archiveFailed.length, 3)
    assert.equal(report.archiveHeld, 2)
    assert.equal((await posted()).length, 3, 'the last two were never sent')
    assert.deepEqual(await writes('cache.appliedChangeOps'), [], 'all five are still owed')
  })

  test('an entry that is not an op is counted rather than fatal', async () => {
    await reset()
    const report = await run(file([op('a', AT, '11', 'setMark'), { id: 'b', at: 'soon' }]))

    assert.equal(report.total, 2)
    assert.equal(report.applied, 1)
    assert.equal(report.unreadable, 1)
  })

  test('the ledger keeps its cap, dropping the oldest ids first', async () => {
    await reset({ ledger: 20_000 })
    await run(file([op('new', AT, '11', 'setMark')]))

    const [ledger] = await writes('cache.appliedChangeOps')
    assert.equal(ledger.length, 20_000)
    assert.equal(ledger.at(-1), 'new')
    assert.equal(ledger[0], 'old-1', 'the oldest id made room')
  })

  /**
   * The fallback for the one thing this page cannot do for itself if AO3 stops
   * accepting a POST that arrives with no `Origin` and no `Referer`. Everything
   * below is what happens when the direct request comes back refused.
   */
  describe('when AO3 will only take it from one of its own pages', () => {
    test('an open AO3 tab makes the request instead', async () => {
      await reset({ archive: 403, tabs: [{ id: 7, answer: { ok: true } }] })
      const report = await run(file([op('a', AT, '11', 'markAsRead')]))

      assert.equal(report.toldArchive, 1)
      assert.equal(report.viaTab, 1)
      assert.equal(report.archiveFailed.length, 0)
      assert.deepEqual(await delegated(), [{ tabId: 7, message: { submitMark: ['11', false] } }])
      const [ledger] = await writes('cache.appliedChangeOps')
      assert.deepEqual(ledger, ['a'], 'both halves happened, so it is done')
    })

    test('once a tab has done it, the rest of the run goes the same way', async () => {
      await reset({ archive: 403, tabs: [{ id: 7, answer: { ok: true } }] })
      const ops = ['11', '12', '13'].map((workId, i) => op(`op-${i}`, AT + i, workId, 'markAsRead'))
      const report = await run(file(ops))

      assert.equal(report.toldArchive, 3)
      assert.equal(report.viaTab, 3)
      assert.equal((await posted()).length, 1, 'the refusal is not re-proved per work')
      assert.equal((await delegated()).length, 3)
    })

    test('a tab with nothing listening is passed over for one that answers', async () => {
      await reset({ archive: 403, tabs: [{ id: 1, answer: 'silent' }, { id: 2, answer: { ok: true } }] })
      const report = await run(file([op('a', AT, '11', 'markAsRead')]))

      assert.equal(report.toldArchive, 1)
      assert.deepEqual((await delegated()).map(entry => entry.tabId), [1, 2])
    })

    test('a tab that reached AO3 and was refused there settles it', async () => {
      await reset({
        archive: 403,
        tabs: [{ id: 1, answer: { ok: false, error: 'Mark request failed (422)' } }, { id: 2, answer: { ok: true } }],
      })
      const report = await run(file([op('a', AT, '11', 'markAsRead')]))

      assert.equal(report.toldArchive, 0)
      assert.equal(report.archiveFailed.length, 1)
      assert.match(report.archiveFailed[0].reason, /422/)
      assert.deepEqual((await delegated()).map(entry => entry.tabId), [1], 'the second tab is the same tab')
    })

    test('with no AO3 tab open, the reader is told what to do about it', async () => {
      await reset({ archive: 403 })
      const report = await run(file([op('a', AT, '11', 'markAsRead')]))

      assert.equal(report.archiveFailed.length, 1)
      assert.match(report.archiveFailed[0].reason, /open AO3 in a tab and import this file again/)
      assert.deepEqual(await delegated(), [])
    })

    test('a request that never got an answer is worth asking a tab about', async () => {
      await reset({ archive: 'network', tabs: [{ id: 7, answer: { ok: true } }] })
      const report = await run(file([op('a', AT, '11', 'markAsRead')]))

      assert.equal(report.viaTab, 1, 'an extension origin losing its privilege looks like this')
    })

    test('being told to slow down is not re-asked from somewhere else', async () => {
      await reset({ archive: 429, tabs: [{ id: 7, answer: { ok: true } }] })
      const report = await run(file([op('a', AT, '11', 'markAsRead')]))

      assert.equal(report.toldArchive, 0)
      assert.match(report.archiveFailed[0].reason, /429/)
      assert.deepEqual(await delegated(), [], 'a tab is the same machine AO3 just paced')
    })
  })
})
