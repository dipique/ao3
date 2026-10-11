import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// Node strips the TS types on import; archiveFetch.ts imports nothing at all, so
// it loads under a plain `node --test`. `fetch` is stubbed per test and the
// clock is mocked, which is the only way an hours-long budget is testable.
import { archivePause, archiveWaitRemaining, BLIND_WAIT_STEP_MS, countdown, fetchWithRetry, MAX_WAIT_MS, onArchiveWait, PACE_EVERY, PACE_IDLE_RESET_MS, PACE_PAUSE_MS, PATIENCE, retryAfterMs, WAIT_WORDS } from '../../src/content_script/archiveFetch.ts'

const MINUTE = 60_000

/** The wait the blind ladder's nth refusal in a row is given, one-based. */
function rung(n) {
  return Math.min(n * BLIND_WAIT_STEP_MS, MAX_WAIT_MS)
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a
}

/**
 * The mocked clock moves in whole steps, and whatever a wait releases happens at
 * the end of the step it ends in. So a wait is measured exactly only in steps
 * that divide it: a tenth of what divides both the ladder's step and its
 * ceiling divides every rung.
 */
const RUNG_STEP = gcd(BLIND_WAIT_STEP_MS, MAX_WAIT_MS) / 10

/**
 * Patience enough for the blind ladder to climb all the way to its ceiling and
 * then wait there twice over, so a test can see it stop climbing — more than
 * anything real is given, `PATIENCE.bulk` included.
 */
const LADDER_PATIENCE = (Math.ceil(MAX_WAIT_MS / BLIND_WAIT_STEP_MS) + 2) * MAX_WAIT_MS

/** The longest any test here runs the clock: the most patience one is given, and the wait it may leave behind. */
const LONGEST_RUN = Math.max(PATIENCE.bulk, LADDER_PATIENCE) + MAX_WAIT_MS

/**
 * Each test gets its own stretch of the clock.
 *
 * The pause is module state and holds an absolute time, so a test that started
 * its clock back at zero would sit out the pause the previous test left behind.
 * Moving forward instead means every earlier pause is already in the past — and
 * the step has to clear the *simulated* hours a ladder test runs through, not
 * just the wall-clock time it took. Twice the longest run clears that run, the
 * pause it left, and far enough past its last refusal that the next one starts
 * the ladder over.
 *
 * The clock starts in the present rather than in 1970, so a `Retry-After` read
 * as a date lands where it would in use: `Date.parse` takes even `0` for a day
 * in 2000, which a 1970 clock puts decades ahead rather than long past.
 */
let clock = Date.UTC(2026, 0, 1)

function useClock(t) {
  clock += 2 * LONGEST_RUN
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: clock })
  return {
    now: () => Date.now(),
    /** Let pending promises settle, move the clock, let them settle again. */
    async tick(ms) {
      await new Promise(setImmediate)
      t.mock.timers.tick(ms)
      await new Promise(setImmediate)
    },
    /** Run the clock forward in steps until `done()` — or give up, past the longest run any test makes. */
    async until(done, step = 1000) {
      for (let ran = 0; ran <= LONGEST_RUN && !done(); ran += step)
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

  test('waits a long first step when told nothing at all', async (t) => {
    const clk = useClock(t)
    const calls = stubFetch(t, [{ status: 429 }, { status: 200 }])

    const pending = fetchWithRetry(url, undefined, PATIENCE.bulk)
    await clk.until(() => calls.length === 2, RUNG_STEP)
    await pending

    // AO3's other 429 carries no `Retry-After`, so there is nothing to read and
    // a second or two would just be walking back into it.
    assert.equal(calls[1].at - calls[0].at, rung(1))
  })

  test('adds another step each time the wait was not enough', async (t) => {
    const clk = useClock(t)
    const calls = stubFetch(t, [
      { status: 429 },
      { status: 429 },
      { status: 429 },
      { status: 200 },
    ])

    const pending = fetchWithRetry(url, undefined, PATIENCE.bulk)
    await clk.until(() => calls.length === 4, RUNG_STEP)
    await pending

    assert.equal(calls[1].at - calls[0].at, rung(1))
    assert.equal(calls[2].at - calls[1].at, rung(2))
    assert.equal(calls[3].at - calls[2].at, rung(3))
  })

  test('stops climbing at the ceiling', async (t) => {
    const clk = useClock(t)
    const calls = stubFetch(t, [{ status: 429 }])

    const state = watch(fetchWithRetry(url, undefined, LADDER_PATIENCE))
    await clk.until(() => state.done, RUNG_STEP)

    const waits = calls.slice(1).map((call, i) => call.at - calls[i].at)
    assert.deepEqual(waits.slice(0, 3), [rung(1), rung(2), rung(3)])
    assert.ok(waits.every(wait => wait <= MAX_WAIT_MS), 'no wait may exceed the ceiling')
    assert.deepEqual(waits.slice(-2), [MAX_WAIT_MS, MAX_WAIT_MS], 'and the ladder should reach it and stay there')
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

  /**
   * A refusal that says to come straight back has not said how long the archive
   * needs, and asking again at once is the hammering a refusal exists to stop.
   */
  test('a `Retry-After` of zero, or a date already past, is waited out as if AO3 had said nothing', async (t) => {
    const clk = useClock(t)
    const past = new Date(Date.now() - MINUTE).toUTCString()
    const calls = stubFetch(t, [
      { status: 429, retryAfter: 0 },
      { status: 429, retryAfter: past },
      { status: 200 },
    ])

    const pending = fetchWithRetry(url, undefined, PATIENCE.bulk)
    await clk.until(() => calls.length === 3, RUNG_STEP)
    await pending

    assert.equal(calls[1].at - calls[0].at, rung(1))
    assert.equal(calls[2].at - calls[1].at, rung(2), 'and climbs the same ladder')
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
   * take a pause one step of the ladder long to three steps for no reason at all.
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
    await clk.until(() => states.every(state => state.done), RUNG_STEP)

    assert.equal(calls.length, 6, 'each work is refused once, then served')
    // One step of the ladder, not three.
    assert.equal(calls[3].at - calls[0].at, rung(1))
  })

  test('reports the pause, so a quiet run can say why it is quiet', async (t) => {
    const clk = useClock(t)
    stubFetch(t, [{ status: 429, retryAfter: 5 }, { status: 200 }])

    const seen = []
    const unwatch = onArchiveWait((until, reason) => seen.push({ until, reason }))
    const pending = fetchWithRetry(url)
    await clk.until(() => seen.length >= 2)
    await pending
    unwatch()

    assert.ok(seen[0].until > 0, 'the first report names when the wait ends')
    assert.equal(seen[0].reason, 'refused', 'and says whose idea the wait was')
    assert.equal(seen.at(-1).until, 0, 'the last one says it is over')
  })
})

/**
 * A set of requests back-to-back, then a short breather. A rate limit is AO3
 * telling us we were already going too fast; a steady breather is the cheaper
 * way of never being told. It comes out of the same shared pause, so the whole
 * pool breathes at once rather than each worker keeping its own count.
 */
describe('archiveFetch — pacing ourselves', () => {
  /** A step that divides the breather, so it is measured exactly. */
  const BREATHER_STEP = PACE_PAUSE_MS / 5

  test('a set goes out back-to-back, and the next request waits', async (t) => {
    const clk = useClock(t)
    const calls = stubFetch(t, [{ status: 200 }])

    for (let i = 0; i < PACE_EVERY; i++)
      await fetchWithRetry(url)
    assert.equal(calls.length, PACE_EVERY)
    assert.ok(calls.every(call => call.at === calls[0].at), 'nothing inside the set is held up')

    const next = watch(fetchWithRetry(url))
    await clk.tick(PACE_PAUSE_MS - BREATHER_STEP)
    assert.equal(calls.length, PACE_EVERY, 'the first of the next set waits for the breather')

    await clk.until(() => next.done, BREATHER_STEP)
    assert.equal(calls[PACE_EVERY].at - calls[PACE_EVERY - 1].at, PACE_PAUSE_MS)
  })

  test('and the set after that gets its own breather, not a longer one', async (t) => {
    const clk = useClock(t)
    const calls = stubFetch(t, [{ status: 200 }])

    for (let i = 0; i < 2 * PACE_EVERY + 1; i++) {
      const pending = watch(fetchWithRetry(url))
      await clk.until(() => pending.done, BREATHER_STEP)
    }

    // Two breathers in two sets and a request, each of them one breather long.
    assert.equal(calls[PACE_EVERY].at - calls[PACE_EVERY - 1].at, PACE_PAUSE_MS)
    assert.equal(calls[2 * PACE_EVERY].at - calls[2 * PACE_EVERY - 1].at, PACE_PAUSE_MS)
  })

  test('the breather is announced as ours, not as AO3 complaining', async (t) => {
    const clk = useClock(t)
    stubFetch(t, [{ status: 200 }])

    for (let i = 0; i < PACE_EVERY; i++)
      await fetchWithRetry(url)

    const seen = []
    const unwatch = onArchiveWait((until, reason) => seen.push({ until, reason }))
    const next = watch(fetchWithRetry(url))
    await clk.until(() => next.done)
    unwatch()

    assert.equal(seen[0].reason, 'pacing')
    assert.equal(seen.at(-1).until, 0)
  })

  test('a burst that stops long enough starts counting again', async (t) => {
    const clk = useClock(t)
    const calls = stubFetch(t, [{ status: 200 }])

    const short = PACE_EVERY - 1
    for (let i = 0; i < short; i++)
      await fetchWithRetry(url)
    // Long enough that the burst those requests belonged to is over; whatever
    // comes next is a new one and should not inherit their count.
    await clk.tick(PACE_IDLE_RESET_MS + 1)
    for (let i = 0; i < short; i++)
      await fetchWithRetry(url)

    assert.equal(calls.length, 2 * short)
    assert.equal(calls.at(-1).at, calls[short].at, 'no breather inside the second burst')
  })

  test('a refusal during a breather is still written down', async (t) => {
    const clk = useClock(t)
    // Longer than the breather, so the two waits tell apart.
    const retryAfter = 2 * PACE_PAUSE_MS / 1000
    // A set to earn the breather, then a refusal for the first of the next.
    const calls = stubFetch(t, [
      ...Array.from({ length: PACE_EVERY }, () => ({ status: 200 })),
      { status: 429, retryAfter },
      { status: 200 },
    ])

    for (let i = 0; i < PACE_EVERY; i++)
      await fetchWithRetry(url)

    const next = watch(fetchWithRetry(url, undefined, PATIENCE.bulk))
    await clk.until(() => calls.length === PACE_EVERY + 2, BREATHER_STEP)
    await next.done

    // The breather was in force when the 429 arrived. If that had counted as
    // "a pause is already running", the archive's own answer would have been
    // swallowed and the retry would have gone out when the breather ended.
    assert.equal(calls[PACE_EVERY + 1].at - calls[PACE_EVERY].at, retryAfter * 1000, 'AO3 said how long; that is the answer')
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
    const retryAfter = 60
    const calls = stubFetch(t, [{ status: 429, retryAfter }])

    const state = watch(fetchWithRetry(url))
    await clk.until(() => state.done, 30_000)

    assert.equal(state.value.status, 429, 'the caller gets the refusal to act on')
    assert.ok(calls.at(-1).at - calls[0].at <= PATIENCE.interactive + retryAfter * 1000)
  })

  test('a bulk fetch settles in for hours before it gives up', async (t) => {
    const clk = useClock(t)
    const retryAfter = 600
    const calls = stubFetch(t, [{ status: 429, retryAfter }])

    const state = watch(fetchWithRetry(url, undefined, PATIENCE.bulk))
    await clk.until(() => state.done, MINUTE)

    assert.equal(state.value.status, 429)
    // The budget is a ceiling, not a stopwatch: it keeps going back for hours,
    // and stops one pause short rather than sitting through a wait it already
    // knows it cannot afford.
    const spent = calls.at(-1).at - calls[0].at
    assert.ok(spent <= PATIENCE.bulk, `waited ${spent}ms, which is past the budget`)
    assert.ok(
      spent > PATIENCE.bulk - retryAfter * 1000 - 1,
      `waited ${spent}ms, expected to have used nearly all of ${PATIENCE.bulk}ms`,
    )
  })

  /**
   * The case a reader actually meets: press the search button, and AO3 answers
   * with the kind of 429 that names no `Retry-After` at all. The blind ladder's
   * first step is more than the whole interactive budget — so the request must
   * hand the refusal straight back instead of disappearing into a wait it cannot
   * afford. The scrape above it is what waits, where the reader can see a
   * countdown and press Cancel.
   */
  test('a wait it cannot afford is not one it starts', async (t) => {
    assert.ok(BLIND_WAIT_STEP_MS > PATIENCE.interactive, 'the case under test: a reader cannot afford the blind ladder\'s first step')
    const clk = useClock(t)
    const calls = stubFetch(t, [{ status: 429 }])

    const state = watch(fetchWithRetry(url))
    await clk.until(() => state.done)

    assert.equal(state.value.status, 429)
    assert.equal(calls.length, 1, 'asked once, and did not sit through the blind wait to ask again')
    // Handed back at once — but with the blind wait written down, so whatever
    // decides to come back knows exactly how long it has to stay away.
    assert.deepEqual(archivePause(), { reason: 'refused', until: calls[0].at + rung(1) })
  })

  test('told to come straight back, a reader\'s request does not ask again any sooner than if told nothing', async (t) => {
    const clk = useClock(t)
    const calls = stubFetch(t, [{ status: 429, retryAfter: 0 }])

    const state = watch(fetchWithRetry(url))
    await clk.until(() => state.done)

    assert.equal(state.value.status, 429)
    const waits = calls.slice(1).map((call, i) => call.at - calls[i].at)
    assert.ok(waits.every(wait => wait >= BLIND_WAIT_STEP_MS), `asked ${calls.length} times, after waits of ${waits.slice(0, 3)}…`)
    assert.equal(archivePause()?.reason, 'refused', 'and the refusal is written down for everyone')
  })

  /**
   * The refusal that ends a request is still the archive's answer to everyone.
   * Handing it back without writing it down is how a queue of pages used to fail
   * one at a time: each one found the pause expired, went out, was refused, and
   * paid the whole wait again to learn what the one before it already knew.
   */
  test('giving up still records the pause, so the next caller knows', async (t) => {
    const clk = useClock(t)
    stubFetch(t, [{ status: 429, retryAfter: 30 }])

    const state = watch(fetchWithRetry(url))
    await clk.until(() => state.done, 10_000)

    assert.equal(state.value.status, 429)
    assert.ok(archiveWaitRemaining() > 0, 'the refusal that ended it is still in force')
  })

  test('a stop during a wait is a stop, not a slow retry', async (t) => {
    const clk = useClock(t)
    const retryAfter = PATIENCE.interactive / 1000
    const calls = stubFetch(t, [{ status: 429, retryAfter }])
    const controller = new AbortController()

    // The patient budget, so there is a wait to interrupt at all: a wait the
    // whole of the interactive one long is one an interactive request would
    // hand back rather than start.
    const pending = fetchWithRetry(url, controller.signal, PATIENCE.bulk)
    await new Promise(setImmediate)
    assert.equal(calls.length, 1)

    controller.abort()
    await assert.rejects(pending, err => err.name === 'AbortError')

    // And nothing is asked of AO3 after the reader said stop, even once the
    // wait it was in is long over.
    await clk.tick(2 * retryAfter * 1000)
    assert.equal(calls.length, 1)
  })
})

describe('archiveFetch — for a request that won\'t wait', () => {
  test('with nothing paused, there is no pause to report', (t) => {
    useClock(t)
    assert.equal(archivePause(), null)
  })

  test('a suggestion\'s patience is none: the first refusal comes straight back, and is everyone\'s pause', async (t) => {
    useClock(t)
    const calls = stubFetch(t, [{ status: 429, retryAfter: 3 }, { status: 200 }])

    const res = await fetchWithRetry(url, undefined, PATIENCE.suggestion)

    assert.equal(res.status, 429)
    assert.equal(calls.length, 1, 'asked once, not again')
    assert.deepEqual(archivePause(), { reason: 'refused', until: calls[0].at + 3000 })
  })

  test('a breather is a pause of its own kind', async (t) => {
    useClock(t)
    const calls = stubFetch(t, [{ status: 200 }])

    for (let i = 0; i < PACE_EVERY; i++)
      await fetchWithRetry(url)

    assert.deepEqual(archivePause(), { reason: 'pacing', until: calls[PACE_EVERY - 1].at + PACE_PAUSE_MS })
  })

  test('a refusal outranks a breather, and the pause lasts until both are over', async (t) => {
    useClock(t)
    // Shorter than the breather, so the pause runs to the breather's end.
    const retryAfter = PACE_PAUSE_MS / 2 / 1000
    const calls = stubFetch(t, [...Array.from({ length: PACE_EVERY - 1 }, () => ({ status: 200 })), { status: 429, retryAfter }])

    for (let i = 0; i < PACE_EVERY; i++)
      await fetchWithRetry(url, undefined, PATIENCE.suggestion)

    assert.deepEqual(archivePause(), { reason: 'refused', until: calls[PACE_EVERY - 1].at + PACE_PAUSE_MS })
  })
})

describe('archiveFetch — reading `Retry-After`', () => {
  // On a whole second, since an HTTP date carries no finer.
  const now = Date.UTC(2026, 9, 11, 12)

  test('a count of seconds is that many seconds', () => {
    assert.equal(retryAfterMs('30', now), 30_000)
  })

  test('a date is the time left until it', () => {
    assert.equal(retryAfterMs(new Date(now + 90_000).toUTCString(), now), 90_000)
  })

  test('nothing, or nothing readable, names no wait', () => {
    for (const header of [null, '', 'soon'])
      assert.equal(retryAfterMs(header, now), null, header)
  })

  test('nor does being told to come straight back: zero, less, or a date that is not still ahead', () => {
    for (const header of ['0', '-5', new Date(now).toUTCString(), new Date(now - MINUTE).toUTCString()])
      assert.equal(retryAfterMs(header, now), null, header)
  })
})

describe('archiveFetch — a pause, as a reader watches it', () => {
  test('each kind of pause has words of its own, so the reader can tell them apart', () => {
    assert.deepEqual(WAIT_WORDS, { refused: 'AO3 asked us to slow down', pacing: 'Giving AO3 a moment' })
  })

  test('the time left reads in seconds under a minute, and in minutes and seconds from one', () => {
    assert.equal(countdown(8_100), '9s')
    assert.equal(countdown(59_000), '59s')
    assert.equal(countdown(60_000), '1:00')
    assert.equal(countdown(296_000), '4:56')
    assert.equal(countdown(0), '0s')
  })
})
