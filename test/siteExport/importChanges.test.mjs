import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { ARCHIVE_UNAVAILABLE, NO_ARCHIVE_TAB } from '../../src/common/markedForLater.ts'
import { createDefaultMarks, markItems, packIds, setMark } from '../../src/common/workMarks.ts'
import { MAX_WAIT_MS, WAIT_BUDGET } from '../../src/content_script/archiveFetch.ts'
import { NO_LONGER_READ } from '../../src/content_script/siteExport/replay.ts'
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
 * storage, `fetch` and `browser.tabs` stubbed under it, and the pacing of
 * requests to AO3 waiting on a clock that moves when it is asked to sleep, so a
 * refusal costs no real time. The end-to-end version of the same round trip
 * lives in `test/e2e/`, and it can only ever afford one pass through the happy
 * path; the ways it goes wrong are here.
 */

const skip = skipWithoutChrome

const AT = Date.UTC(2026, 8, 7, 12)
/** A scrape from after the ops — the only kind that can excuse an archive act. */
const SCRAPED = AT + 60_000

/**
 * How far the clock moves between tests. The pause in requests to AO3 is
 * module state, so each test starts far enough past the last that whatever it
 * left behind — a refusal being sat out, a climb up the blind ladder — is over.
 */
const APART = 2 * (WAIT_BUDGET.interactive + MAX_WAIT_MS)

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
    'cache.owedArchiveActs': [],
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
 * `archive` is what AO3 answers a mark request with — `'ok'`, a status, a
 * `{ status, retryAfter }` for a refusal that says how long to wait, or
 * `'network'` for a request that never gets an answer at all — and `token` the
 * same for the token it hands out first. `queue` and `tokenQueue` are answers
 * given first, one per request, before those take over. `reachable` is whether
 * AO3 answers anything at all, which is what a `HEAD` asks. `tabs` is the
 * reader's open AO3 tabs and what each would say if asked: an answer, its
 * `answers` one per message before that, or `'silent'` for a tab with no
 * content script under it.
 *
 * Each request is noted with the time on the pacing's clock, and with every
 * storage key written before it went out. `duringMark` is storage something
 * else writes while the first mark request is out, such as a scrape landing,
 * and `stopOnMark` the mark request, counting from one, during which the
 * reader presses Stop.
 */
function installArchive() {
  const state = { fetches: [], sent: [], sentAt: [], archive: 'ok', token: 'ok', queue: [], tokenQueue: [], reachable: true, tabs: [], duringMark: null, stopOnMark: 0, marks: 0 }
  window.__archive = state

  const answer = (outcome, body = '') => {
    if (outcome === 'network')
      throw new TypeError('Failed to fetch')
    if (outcome === 'ok')
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    const { status, retryAfter } = typeof outcome === 'number' ? { status: outcome } : outcome
    return new Response('', { status, headers: retryAfter ? { 'Retry-After': retryAfter } : {} })
  }

  window.fetch = async (url, init = {}) => {
    const href = String(url)
    state.fetches.push({
      url: href,
      method: init.method ?? 'GET',
      body: String(init.body ?? ''),
      at: window.__now,
      written: window.__writes.flatMap(Object.keys),
    })
    if (init.method === 'HEAD') {
      if (!state.reachable)
        throw new TypeError('Failed to fetch')
      return new Response(null, { status: 200 })
    }
    if (href.includes('token_dispenser'))
      return answer(state.tokenQueue.length ? state.tokenQueue.shift() : state.token, '{"token":"a-token"}')
    if (state.duringMark) {
      await window.browser.storage.local.set(state.duringMark)
      state.duringMark = null
    }
    if (++state.marks === state.stopOnMark)
      window.__stop.abort()
    return answer(state.queue.length ? state.queue.shift() : state.archive)
  }

  const tabs = {
    query: async () => state.tabs.map(tab => ({ id: tab.id, discarded: false })),
    sendMessage: async (tabId, message) => {
      state.sent.push({ tabId, message })
      state.sentAt.push(window.__now)
      const tab = state.tabs.find(entry => entry.id === tabId)
      const said = tab?.answers?.length ? tab.answers.shift() : tab?.answer
      if (!tab || said === 'silent')
        throw new Error('Could not establish connection. Receiving end does not exist.')
      return said
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
      'test/siteExport/importChangesEntry.ts',
      'ImportChanges',
      {
        async prepare(blank) {
          await blank.evaluate(installMock, {})
          await blank.evaluate(installArchive)
        },
      },
    ))
    await page.evaluate((start) => {
      window.__now = start
      window.ImportChanges.useArchiveClock({
        now: () => window.__now,
        sleep: async (ms, signal) => {
          if (signal?.aborted)
            throw signal.reason
          window.__now += ms
        },
      })
    }, AT)
  }, { timeout: 120000 })

  after(async () => close?.())

  /**
   * Put the page back to a known device. `ledger` is a count rather than a list
   * because the only test that wants a big one wants twenty thousand.
   */
  const reset = async ({ store = seed(), archive = 'ok', token = 'ok', queue = [], tokenQueue = [], reachable = true, tabs = [], duringMark = null, stopOnMark = 0, ledger = 0 } = {}) => {
    await page.evaluate(async (items, archiveState, ledgerSize, apart) => {
      await window.browser.storage.local.clear()
      await window.browser.storage.local.set({
        ...items,
        ...ledgerSize ? { 'cache.appliedChangeOps': Array.from({ length: ledgerSize }, (_, i) => `old-${i}`) } : {},
      })
      window.__writes.length = 0
      window.__now += apart
      Object.assign(window.__archive, { fetches: [], sent: [], sentAt: [], marks: 0 }, archiveState)
    }, store, { archive, token, queue, tokenQueue, reachable, tabs, duringMark, stopOnMark }, ledger, APART)
  }

  /** AO3 answering again, with nothing recorded yet of what this run asks of it. */
  const archiveBack = () => page.evaluate(() => {
    window.__archive.archive = 'ok'
    window.__archive.token = 'ok'
    window.__archive.reachable = true
    window.__archive.fetches.length = 0
    window.__writes.length = 0
  })

  const run = (text, opts = { tellArchive: true }) => page.evaluate(
    (t, o) => {
      window.__progress = []
      window.__stop = new AbortController()
      return window.ImportChanges.importChanges(t, {
        ...o,
        signal: window.__stop.signal,
        onProgress: step => window.__progress.push(structuredClone(step)),
      })
    },
    text,
    opts,
  )

  /** Everything the last run told the page about how far it had got, in order. */
  const progress = () => page.evaluate(() => window.__progress)

  /** The work a request was about. */
  const workOf = request => request.url.match(/works\/(\d+)/)[1]

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

  test('a scrape that lands while AO3 is being told is corrected, not overwritten', async () => {
    const scrape = { userId: 'reader', updatedAt: SCRAPED, ids: packIds(new Set(['11', '12', '99'])) }
    await reset({ store: seed({ listed: ['11', '12'] }), duringMark: { 'cache.markedForLater': scrape } })
    await run(file([op('a', AT, '11', 'markAsRead')]))

    const { 'cache.markedForLater': index } = await page.evaluate(() => window.browser.storage.local.get('cache.markedForLater'))
    assert.equal(index.updatedAt, SCRAPED, 'the newer scrape is kept')
    assert.equal(index.ids, packIds(new Set(['12', '99'])), 'with the work AO3 just took off it removed')
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
   * The two halves of an op are recorded apart: the mark is ledgered as soon as
   * it is in the table, and what AO3 still has to do is kept as an act owed,
   * which the next import pays.
   */
  test('an op AO3 refused is ledgered, its archive half stays owed, and a later import pays it', async () => {
    await reset({ archive: 403 })
    const first = await run(file([op('a', AT, '11', 'markAsRead')]))

    assert.equal(first.applied, 1, 'the local half happened')
    assert.equal(first.toldArchive, 0)
    assert.equal(first.archiveFailed.length, 1)
    assert.equal(first.archiveFailed[0].workId, '11')
    assert.ok(first.archiveFailed[0].reason, 'with a reason the reader is given')
    assert.equal((await writes('option.workMarks')).length, 1)
    assert.deepEqual(await writes('cache.appliedChangeOps'), [['a']])
    assert.deepEqual(await writes('cache.owedArchiveActs'), [[{ workId: '11', opId: 'a', at: AT }]])

    await archiveBack()
    const second = await run(file([op('a', AT, '11', 'markAsRead')]))
    assert.equal(second.duplicates, 1, 'the mark is not applied twice')
    assert.equal(second.toldArchive, 1, 'but what AO3 was owed is paid')
    assert.deepEqual(await writes('option.workMarks'), [])
    assert.deepEqual(await writes('cache.owedArchiveActs'), [[]])
  })

  test('what is owed is paid by the next import, whichever file it brings', async () => {
    await reset({ archive: 403 })
    await run(file([op('a', AT, '11', 'markAsRead')]))

    await archiveBack()
    const report = await run(file([op('b', AT + 1000, '12', 'setMark')]))
    assert.equal(report.applied, 1)
    assert.equal(report.toldArchive, 1)
    assert.deepEqual((await posted()).map(request => request.url.match(/works\/(\d+)/)[1]), ['11'])
  })

  /**
   * Re-importing a file is how the reader retries what AO3 would not take, so
   * it must not also put back a mark they have changed since by hand — nor take
   * a work they have since unmarked off Marked for Later.
   */
  test('a re-import leaves a mark changed by hand since alone, and asks AO3 nothing for it', async () => {
    await reset({ archive: 503 })
    const readOp = op('a', AT, '11', 'markAsRead')
    await run(file([readOp]))

    await page.evaluate(async (marks) => {
      const stored = (await window.browser.storage.local.get('option.workMarks'))['option.workMarks']
      await window.browser.storage.local.set({ 'option.workMarks': { ...stored, marks } })
    }, setMark(createDefaultMarks(), '11', 'continue', true))
    await archiveBack()

    const report = await run(file([readOp]))
    assert.deepEqual(await writes('option.workMarks'), [], 'the table is as the reader left it')
    assert.deepEqual(await posted(), [])
    assert.equal(report.toldArchive, 0)
    assert.deepEqual(report.skipped, [{ workId: '11', reason: NO_LONGER_READ }])
    assert.deepEqual(await writes('cache.owedArchiveActs'), [[]], 'and nothing is owed for it any more')
  })

  test('holding the archive half defers it rather than dropping it', async () => {
    await reset()
    const report = await run(file([op('a', AT, '11', 'markAsRead')]), { tellArchive: false })

    assert.equal(report.applied, 1)
    assert.equal(report.archiveHeld, 1)
    assert.equal(report.toldArchive, 0)
    assert.deepEqual(await page.evaluate(() => window.__archive.fetches), [], 'nothing was asked of AO3, not even a token')
    assert.deepEqual(await writes('cache.appliedChangeOps'), [['a']])
    assert.deepEqual(await writes('cache.owedArchiveActs'), [[{ workId: '11', opId: 'a', at: AT }]])
    assert.equal((await writes('option.workMarks')).length, 1, 'the local half still happened')
  })

  /**
   * The half that is true whatever AO3 says goes down before AO3 is asked
   * anything. An import sitting out AO3's refusals can run for many minutes,
   * and neither a mark the reader makes meanwhile nor a page closed halfway
   * through may cost them what was in the file.
   */
  test('the table, the ledger and what AO3 is owed are all written before AO3 is asked', async () => {
    await reset()
    await run(file([op('a', AT, '11', 'markAsRead')]))

    const [request] = await posted()
    assert.ok(request.written.includes('option.workMarks'), 'the mark table')
    assert.ok(request.written.includes('cache.appliedChangeOps'), 'the ledger')
    assert.ok(request.written.includes('cache.owedArchiveActs'), 'and the request, as owed')
  })

  test('each work AO3 takes off the list stops being owed as it goes', async () => {
    await reset()
    await run(file([op('a', AT, '11', 'markAsRead'), op('b', AT + 1, '12', 'markAsRead')]))

    const owed = (await writes('cache.owedArchiveActs')).map(acts => acts.map(act => act.workId))
    assert.deepEqual(owed, [['11', '12'], ['12'], []])
  })

  test('the page hears how far AO3 has got: each work as it settles, out of every work it is to be asked about', async () => {
    await reset({ queue: ['ok', 403, 'ok'] })
    await run(file(['11', '12', '13'].map((workId, i) => op(`op-${i}`, AT + i, workId, 'markAsRead'))))

    const steps = (await progress()).map(({ step, done, total }) => `${step} ${done}/${total}`)
    assert.deepEqual(steps.filter((line, i) => line !== steps[i - 1]), [
      'applying 0/0',
      'archive 0/3',
      'archive 1/3',
      'archive 2/3',
      'archive 3/3',
    ], 'a work AO3 would not take is settled too')
  })

  test('holding the archive half gives the page no requests to count', async () => {
    await reset()
    await run(file([op('a', AT, '11', 'markAsRead')]), { tellArchive: false })

    assert.deepEqual((await progress()).map(({ step, total }) => `${step} ${total}`), ['applying 0'])
  })

  /**
   * A 429 is the archive pacing everyone, not a verdict on the work: the run
   * sits it out with the page counting down beside it, and asks again for the
   * same work.
   */
  describe('when AO3 asks us to slow down', () => {
    test('the wait it names is sat out, shown, and the same work asked again', async () => {
      await reset({ queue: [{ status: 429, retryAfter: '3' }] })
      const report = await run(file([op('a', AT, '11', 'markAsRead')]))

      assert.equal(report.toldArchive, 1)
      assert.deepEqual(report.archiveFailed, [])
      assert.equal(report.rateLimited, false)
      const requests = await posted()
      assert.deepEqual(requests.map(workOf), ['11', '11'])
      assert.equal(requests[1].at - requests[0].at, 3000)

      const [wait] = (await progress()).filter(step => step.waitReason === 'refused')
      assert.equal(wait?.waitingUntil, requests[0].at + 3000, 'the page is told when it ends, to count down to')
      assert.deepEqual((await progress()).at(-1), { step: 'archive', done: 1, total: 1, waitingUntil: null, waitReason: null })
    })

    test('a token refused is waited out the same way', async () => {
      await reset({ tokenQueue: [{ status: 429, retryAfter: '5' }] })
      const report = await run(file([op('a', AT, '11', 'markAsRead')]))

      assert.equal(report.toldArchive, 1)
      const tokens = (await page.evaluate(() => window.__archive.fetches)).filter(request => request.url.includes('token_dispenser'))
      assert.equal(tokens.length, 2)
      assert.equal(tokens[1].at - tokens[0].at, 5000)
    })

    test('a tab told to slow down is waited out too', async () => {
      const slowDown = { ok: false, error: 'Mark request failed (429)', status: 429, retryAfter: '4' }
      await reset({ archive: 403, tabs: [{ id: 7, answers: [slowDown], answer: { ok: true } }] })
      const report = await run(file([op('a', AT, '11', 'markAsRead')]))

      assert.equal(report.toldArchive, 1)
      assert.equal(report.viaTab, 1)
      assert.deepEqual(report.archiveFailed, [])
      const sentAt = await page.evaluate(() => window.__archive.sentAt)
      assert.equal(sentAt.length, 2)
      assert.equal(sentAt[1] - sentAt[0], 4000)
    })

    test('still refused once the wait has run long enough, the run stops, the rest stay owed, and the report says why', async () => {
      await reset({ archive: 429, tabs: [{ id: 7, answer: { ok: true } }] })
      const ops = ['11', '12', '13'].map((workId, i) => op(`op-${i}`, AT + i, workId, 'markAsRead'))
      const report = await run(file(ops))

      assert.equal(report.rateLimited, true)
      assert.equal(report.toldArchive, 0)
      assert.deepEqual(report.archiveFailed, [], 'a refusal is about the minute, not the work')
      assert.equal(report.archiveHeld, 3)
      assert.deepEqual([...new Set((await posted()).map(workOf))], ['11'], 'the works after it were never asked about')
      assert.deepEqual(await delegated(), [], 'a tab is the same machine AO3 just paced')
      const owed = (await writes('cache.owedArchiveActs')).at(-1)
      assert.deepEqual(owed.map(act => act.workId), ['11', '12', '13'])
    })
  })

  /**
   * Stop ends the run where it stands. What AO3 was already being asked is let
   * finish — it may have done it — and counted for what it came to; nothing
   * after it is asked, and every work not taken off the list stays owed for the
   * next import.
   */
  describe('when the reader presses Stop', () => {
    const three = () => file(['11', '12', '13'].map((workId, i) => op(`op-${i}`, AT + i, workId, 'markAsRead')))

    test('the request already out is let finish and counted, nothing more is asked, and the rest stay owed', async () => {
      await reset({ stopOnMark: 1 })
      const report = await run(three())

      assert.equal(report.stopped, true)
      assert.equal(report.rateLimited, false)
      assert.equal(report.toldArchive, 1, 'AO3 took the work it was being asked about')
      assert.equal(report.archiveHeld, 2)
      assert.deepEqual((await posted()).map(workOf), ['11'])
      const owed = (await writes('cache.owedArchiveActs')).at(-1)
      assert.deepEqual(owed.map(act => act.workId), ['12', '13'])
    })

    test('a stop while a refusal is being sat out ends the run at once', async () => {
      await reset({ queue: [{ status: 429, retryAfter: '600' }], stopOnMark: 1 })
      const report = await run(three())

      assert.equal(report.stopped, true)
      assert.equal(report.toldArchive, 0)
      assert.equal(report.archiveHeld, 3)
      const requests = await posted()
      assert.equal(requests.length, 1, 'the refused work was not asked about again')
      assert.equal(await page.evaluate(() => window.__now), requests[0].at, 'and none of the wait was sat out')
    })
  })

  test('three refusals in a row leave the rest for another day', async () => {
    await reset({ archive: 500 })
    const ops = ['11', '12', '13', '14', '15'].map((workId, i) => op(`op-${i}`, AT + i, workId, 'markAsRead'))
    const report = await run(file(ops))

    assert.equal(report.archiveFailed.length, 3)
    assert.equal(report.archiveHeld, 2)
    assert.equal((await posted()).length, 3, 'the last two were never sent')
    const [owed] = await writes('cache.owedArchiveActs')
    assert.deepEqual(owed.map(act => act.workId), ['11', '12', '13', '14', '15'], 'all five are still owed')
  })

  /**
   * AO3 being down is not a refusal another origin could get past, and it is
   * not something an open AO3 tab would fix: the reader is told to come back
   * once it is up, and no tab is asked.
   */
  describe('when AO3 is down', () => {
    test('a server error answering the request says AO3 is unavailable', async () => {
      await reset({ archive: 503, tabs: [{ id: 7, answer: { ok: true } }] })
      const report = await run(file([op('a', AT, '11', 'markAsRead')]))

      assert.equal(report.archiveFailed[0].reason, ARCHIVE_UNAVAILABLE)
      assert.deepEqual(await delegated(), [])
    })

    test('a server error answering the token is the archive\'s answer, not a lost connection', async () => {
      await reset({ token: 503, tabs: [{ id: 7, answer: { ok: true } }] })
      const report = await run(file([op('a', AT, '11', 'markAsRead')]))

      assert.equal(report.toldArchive, 0)
      assert.equal(report.archiveFailed[0].reason, ARCHIVE_UNAVAILABLE)
      assert.deepEqual(await delegated(), [])
    })

    test('with nothing answering at all, the reader is not sent to open a tab', async () => {
      await reset({ token: 'network', archive: 'network', reachable: false })
      const report = await run(file([op('a', AT, '11', 'markAsRead')]))

      assert.equal(report.archiveFailed[0].reason, ARCHIVE_UNAVAILABLE)
      assert.deepEqual(await delegated(), [])
    })
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
      assert.equal(report.archiveFailed[0].reason, NO_ARCHIVE_TAB.none)
      assert.deepEqual(await delegated(), [])
    })

    test('a request that never got an answer is worth asking a tab about', async () => {
      await reset({ archive: 'network', tabs: [{ id: 7, answer: { ok: true } }] })
      const report = await run(file([op('a', AT, '11', 'markAsRead')]))

      assert.equal(report.viaTab, 1, 'an extension origin losing its privilege looks like this')
    })
  })
})
