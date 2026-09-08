import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// Node strips the TS types on import; archiveFetch.ts imports nothing at all, so
// it loads under a plain `node --test`. `fetch` is stubbed per test and the
// clock is mocked, which is the only way a fifteen-minute budget is testable.
import { archiveWaitRemaining, fetchWithRetry, onArchiveWait, PATIENCE } from '../../src/content_script/archiveFetch.ts'

const MINUTE = 60_000

/**
 * Each test gets its own day on the clock.
 *
 * The pause is module state and holds an absolute time, so a test that started
 * its clock back at zero would sit out the pause the previous test left behind.
 * Moving forward instead means every earlier pause is already in the past — and
 * the step has to clear the *simulated* hours a ladder test runs through, not
 * just the wall-clock time it took.
 */
let clock = 0

function useClock(t) {
  clock += 48 * 60 * MINUTE
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: clock })
  return {
    now: () => Date.now(),
    /** Let pending promises settle, move the clock, let them settle again. */
    async tick(ms) {
      await new Promise(setImmediate)
      t.mock.timers.tick(ms)
      await new Promise(setImmediate)
    },
    /** Run the clock forward in steps until `done()` — or give up. */
    async until(done, step = 1000, limit = 2000) {
      for (let i = 0; i < limit && !done(); i++)
        await this.tick(step)
      assert.ok(done(), 'timed out advancing the mocked clock')
    },
  }
}

/**
 * Watch a promise without awaiting it.
 *
 * Nothing here can be awaited directly: the clock only moves when a test moves
 * it, so `await pending` on a request that is still waiting would stop the one
 * thing that could ever resolve it.
 */
function watch(promise) {
  const state = { done: false, value: undefined, error: undefined }
  promise.then(
    (value) => { Object.assign(state, { done: true, value }) },
    (error) => { Object.assign(state, { done: true, error }) },
  )
  return state
}

/** A `fetch` that answers from a script of responses, recording when each was asked. */
function stubFetch(t, script) {
  const calls = []
  let i = 0
  t.mock.method(globalThis, 'fetch', async (url) => {
    const step = script[Math.min(i++, script.length - 1)]
    calls.push({ url, at: Date.now() })
    const { status = 200, retryAfter } = typeof step === 'number' ? { status: step } : step
    const headers = new Headers()
    if (retryAfter !== undefined)
      headers.set('Retry-After', String(retryAfter))
    return new Response('', { status, headers })
  })
  return calls
}

const url = 'https://archiveofourown.org/works/11'

describe('archiveFetch — waiting out a 429', () => {
  test('waits the time it was told to, then asks again', async (t) => {
    const clk = useClock(t)
    const calls = stubFetch(t, [{ status: 429, retryAfter: 2 }, { status: 200 }])

    const pending = fetchWithRetry(url)
    await clk.until(() => calls.length === 2)
    const res = await pending

    assert.equal(res.status, 200)
    assert.equal(calls.length, 2)
    // Waited what the header asked for, not a guess of our own.
    assert.equal(calls[1].at - calls[0].at, 2000)
  })

  test('understands `Retry-After` as an HTTP date too', async (t) => {
    const clk = useClock(t)
    const when = new Date(Date.now() + 90_000).toUTCString()
    const calls = stubFetch(t, [{ status: 429, retryAfter: when }, { status: 200 }])

    const pending = fetchWithRetry(url)
    await clk.until(() => calls.length === 2)
    await pending

    // To the second: a date header only carries whole seconds.
    assert.ok(Math.abs((calls[1].at - calls[0].at) - 90_000) <= 1000)
  })

  test('waits five minutes when told nothing at all', async (t) => {
    const clk = useClock(t)
    const calls = stubFetch(t, [{ status: 429 }, { status: 200 }])

    const pending = fetchWithRetry(url, undefined, PATIENCE.bulk)
    await clk.until(() => calls.length === 2, 30_000)
    await pending

    // AO3's other 429 carries no `Retry-After`, so there is nothing to read and
    // a second or two would just be walking back into it.
    assert.equal(calls[1].at - calls[0].at, 5 * MINUTE)
  })

  test('adds another five minutes each time the wait was not enough', async (t) => {
    const clk = useClock(t)
    const calls = stubFetch(t, [
      { status: 429 },
      { status: 429 },
      { status: 429 },
      { status: 200 },
    ])

    const pending = fetchWithRetry(url, undefined, PATIENCE.bulk)
    await clk.until(() => calls.length === 4, 30_000)
    await pending

    assert.equal(calls[1].at - calls[0].at, 5 * MINUTE)
    assert.equal(calls[2].at - calls[1].at, 10 * MINUTE)
    assert.equal(calls[3].at - calls[2].at, 15 * MINUTE)
  })

  test('stops climbing at an hour', async (t) => {
    const clk = useClock(t)
    const calls = stubFetch(t, [{ status: 429 }])

    // More patience than anything real is given, because the ladder's own
    // ceiling is what is under test: climbing 5, 10, 15 … 60 costs six and a
    // half hours, which is past where `PATIENCE.bulk` gives up.
    const state = watch(fetchWithRetry(url, undefined, 12 * 60 * MINUTE))
    await clk.until(() => state.done, 5 * MINUTE)

    const waits = calls.slice(1).map((call, i) => call.at - calls[i].at)
    assert.deepEqual(waits.slice(0, 3), [5 * MINUTE, 10 * MINUTE, 15 * MINUTE])
    assert.ok(waits.every(wait => wait <= 60 * MINUTE), 'no wait may exceed the ceiling')
    assert.ok(waits.includes(60 * MINUTE), 'and the ladder should reach it')
  })

  test('an explicit `Retry-After` is obeyed as given, not escalated', async (t) => {
    const clk = useClock(t)
    const calls = stubFetch(t, [
      { status: 429, retryAfter: 30 },
      { status: 429, retryAfter: 30 },
      { status: 200 },
    ])

    const pending = fetchWithRetry(url, undefined, PATIENCE.bulk)
    await clk.until(() => calls.length === 3, 10_000)
    await pending

    assert.equal(calls[1].at - calls[0].at, 30_000)
    assert.equal(calls[2].at - calls[1].at, 30_000, 'AO3 said how long; that is the answer')
  })

  test('a work that answers normally is not delayed at all', async (t) => {
    useClock(t)
    const calls = stubFetch(t, [{ status: 200 }])
    const res = await fetchWithRetry(url)

    assert.equal(res.status, 200)
    assert.equal(calls.length, 1)
    assert.equal(archiveWaitRemaining(), 0)
  })

  test('every other status is the caller\'s business, not ours', async (t) => {
    useClock(t)
    for (const status of [403, 404, 500]) {
      const calls = stubFetch(t, [{ status }])
      const res = await fetchWithRetry(url)
      assert.equal(res.status, status)
      assert.equal(calls.length, 1, `${status} should not be retried`)
      t.mock.restoreAll()
    }
  })
})

describe('archiveFetch — the pause is shared', () => {
  /**
   * The pool that makes a bulk fetch quick is what walks it into a rate limit;
   * if each request backed off privately they would take turns hitting the same
   * wall. One request being told to wait has to hold the others too.
   */
  test('a request that arrives during a pause waits it out as well', async (t) => {
    const clk = useClock(t)
    const calls = stubFetch(t, [{ status: 429, retryAfter: 30 }, { status: 200 }])

    const first = fetchWithRetry(url)
    await new Promise(setImmediate)
    assert.equal(calls.length, 1, 'the first request has been refused')
    assert.ok(archiveWaitRemaining() > 0, 'and a pause is in force')

    // A second request, started while the pause is on, must not go out yet.
    const started = Date.now()
    const second = fetchWithRetry('https://archiveofourown.org/works/12')
    await clk.tick(10_000)
    assert.equal(calls.length, 1, 'nothing may be asked of AO3 while it is refusing')

    await clk.until(() => calls.length >= 3)
    await Promise.all([first, second])

    for (const call of calls.slice(1))
      assert.ok(call.at - started >= 30_000, 'both waited out the whole pause')
  })

  /**
   * The ladder counts refusals, not requests. Three workers turned away in the
   * same instant have met one refusal between them; stepping per worker would
   * take a five-minute pause to a quarter of an hour for no reason at all.
   */
  test('workers refused together have met one refusal, not three', async (t) => {
    const clk = useClock(t)
    const calls = stubFetch(t, [
      { status: 429 },
      { status: 429 },
      { status: 429 },
      { status: 200 },
    ])

    const states = ['11', '12', '13'].map(id =>
      watch(fetchWithRetry(`https://archiveofourown.org/works/${id}`, undefined, PATIENCE.bulk)))
    await clk.until(() => states.every(state => state.done), MINUTE)

    assert.equal(calls.length, 6, 'each work is refused once, then served')
    // One step of the ladder, not three.
    assert.equal(calls[3].at - calls[0].at, 5 * MINUTE)
  })

  test('reports the pause, so a quiet run can say why it is quiet', async (t) => {
    const clk = useClock(t)
    stubFetch(t, [{ status: 429, retryAfter: 5 }, { status: 200 }])

    const seen = []
    const unwatch = onArchiveWait(until => seen.push(until))
    const pending = fetchWithRetry(url)
    await clk.until(() => seen.length >= 2)
    await pending
    unwatch()

    assert.ok(seen[0] > 0, 'the first report names when the wait ends')
    assert.equal(seen.at(-1), 0, 'and the last one says it is over')
  })
})

describe('archiveFetch — when waiting stops being sensible', () => {
  /**
   * Someone pressed a button and is watching a progress bar. Five minutes of
   * silence is worse for them than being told it didn't work, so the reader's
   * paths give up where a caching run would settle in and wait.
   */
  test('an interactive fetch gives up in minutes, not hours', async (t) => {
    const clk = useClock(t)
    const calls = stubFetch(t, [{ status: 429, retryAfter: 60 }])

    const state = watch(fetchWithRetry(url))
    await clk.until(() => state.done, 30_000)

    assert.equal(state.value.status, 429, 'the caller gets the refusal to act on')
    assert.ok(calls.at(-1).at - calls[0].at <= PATIENCE.interactive + 60_000)
  })

  test('a bulk fetch settles in for hours before it gives up', async (t) => {
    const clk = useClock(t)
    const calls = stubFetch(t, [{ status: 429, retryAfter: 600 }])

    const state = watch(fetchWithRetry(url, undefined, PATIENCE.bulk))
    await clk.until(() => state.done, MINUTE)

    assert.equal(state.value.status, 429)
    const spent = calls.at(-1).at - calls[0].at
    assert.ok(spent >= PATIENCE.bulk, `waited ${spent}ms, expected at least ${PATIENCE.bulk}ms`)
  })

  test('a stop during a wait is a stop, not a slow retry', async (t) => {
    const clk = useClock(t)
    const calls = stubFetch(t, [{ status: 429, retryAfter: 120 }])
    const controller = new AbortController()

    const pending = fetchWithRetry(url, controller.signal)
    await new Promise(setImmediate)
    assert.equal(calls.length, 1)

    controller.abort()
    await assert.rejects(pending, err => err.name === 'AbortError')

    // And nothing is asked of AO3 after the reader said stop.
    await clk.tick(5 * MINUTE)
    assert.equal(calls.length, 1)
  })
})
