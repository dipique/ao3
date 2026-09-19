import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { dayOf, planWindow } from '../../src/common/trackedLists.ts'
import { ideal, queryOf, random, run, works } from './harness.mjs'

const TODAY = dayOf('19 Sep 2026')
const YESTERDAY = TODAY - 1
const S = dayOf('5 Sep 2026')

/**
 * A list's progress written out by hand: `groups` are `[day, n, counts?]`, each
 * n rows dated `day`, in query order.
 */
function progress(id, groups, extra = {}) {
  const items = []
  for (const [day, n, counts = true] of groups) {
    for (let i = 0; i < n; i++)
      items.push({ sid: `${id}${items.length}`, day, counts })
  }
  return {
    id,
    base: S - 1,
    items,
    total: items.length + 100,
    bounds: new Map(),
    exhausted: false,
    failed: false,
    ...extra,
  }
}

/** Every day from `from` to `to`, `n` works a day. */
function daily(from, to, n, drift = 0) {
  const rows = []
  for (let day = from; day <= to; day++)
    rows.push([day, n, drift])
  return rows
}

/** The window a run settled on, less what the ideal doesn't compute. */
function windowShape(window) {
  return { start: window.start, end: window.end, count: window.count, days: window.days }
}

function idealShape(expected) {
  return { start: expected.start, end: expected.end, count: expected.count, days: expected.days }
}

/** Every list's rows, as short ids. */
function readIds(progress) {
  return new Set(progress.flatMap(list => list.items.map(item => item.sid)))
}

describe('planWindow — sizing', () => {
  test('stops partway through a list once the target is reached', () => {
    const spec = { id: 'a', base: S - 1, works: works('a', daily(S - 1, TODAY, 10)) }
    const { window, requests, progress } = run([spec], { start: S, today: TODAY, target: 40 })
    assert.equal(window.start, S)
    assert.equal(window.end, S + 3)
    assert.equal(window.count, 40)
    assert.equal(window.reviewable, true)
    // A fifth day would make 50.
    assert.equal(window.nextDayCount, 10)
    assert.equal(progress[0].exhausted, false)
    assert.ok(requests.length < Math.ceil(queryOf(spec).length / 20), `${requests.length} requests`)
  })

  test('a first day already over the target is a one-day window', () => {
    const spec = { id: 'a', base: S - 1, works: works('a', [[S - 1, 5], [S, 50], [S + 1, 50], [S + 2, 5]]) }
    const { window, progress } = run([spec], { start: S, today: TODAY, target: 40 })
    assert.deepEqual([window.start, window.end, window.count], [S, S, 50])
    // …and only once the day is complete: everything filed the day after was read.
    const read = readIds(progress)
    for (const work of spec.works.filter(work => work.filed <= S + 1))
      assert.ok(read.has(work.sid), work.sid)
  })

  test('a quiet stretch runs to yesterday, empty days included', () => {
    const start = TODAY - 10
    const spec = { id: 'a', base: start - 1, works: works('a', [[start + 1, 3], [start + 6, 2]]) }
    const { window } = run([spec], { start, today: TODAY, target: 40 })
    assert.deepEqual([window.start, window.end, window.count], [start, YESTERDAY, 5])
    assert.equal(window.days.size, 10)
    assert.equal(window.days.get(start), 0)
    assert.equal(window.days.get(start + 1), 3)
    assert.equal(window.days.get(start + 2), 0)
    assert.equal(window.days.get(start + 6), 2)
    assert.equal(window.reviewable, true)
  })

  test('works on today can tip the window, which then ends yesterday', () => {
    const start = TODAY - 3
    const spec = { id: 'a', base: start - 1, works: works('a', [[start, 2], [TODAY, 30]]) }
    const { window } = run([spec], { start, today: TODAY, target: 10 })
    assert.deepEqual([window.end, window.count, window.nextDayCount], [YESTERDAY, 2, 30])
    assert.equal(window.reviewable, true)
  })

  test('caught up: a preview of today, which can\'t be marked reviewed', () => {
    const spec = { id: 'a', base: TODAY - 1, works: works('a', [[TODAY - 1, 25, 0], [TODAY, 12]]) }
    // Nothing read yet: today is only complete once the list is.
    assert.deepEqual(planWindow([progress('a', [], { base: TODAY - 1, total: 0 })], { start: TODAY, today: TODAY, target: 40 }), { fetch: 'a', page: 1 })

    const { window, progress: lists } = run([spec], { start: TODAY, today: TODAY, target: 40 })
    assert.deepEqual([window.start, window.end, window.count], [TODAY, TODAY, 12])
    assert.equal(window.reviewable, false)
    assert.equal(lists[0].exhausted, true)
  })

  test('a list tracked after the window starts isn\'t read for days before it began', () => {
    const early = { id: 'early', base: S - 1, works: works('e', daily(S - 1, TODAY, 5)) }
    const since = S + 10
    const late = { id: 'late', base: since - 1, works: works('l', daily(since - 1, TODAY, 20)) }
    const { window, requests } = run([early, late], { start: S, today: TODAY, target: 30 })
    assert.deepEqual([window.start, window.end, window.count], [S, S + 5, 30])
    assert.equal(requests.some(plan => (plan.fetch ?? plan.boundary) === 'late'), false)
  })

  test('a list tracked inside the window adds from its first day on', () => {
    const early = { id: 'early', base: S - 1, works: works('e', daily(S - 1, TODAY, 2)) }
    const since = S + 3
    const late = { id: 'late', base: since - 1, works: works('l', daily(since - 1, TODAY, 3)) }
    const options = { start: S, today: TODAY, target: 20 }
    const { window } = run([early, late], options)
    const expected = ideal([early, late], options)
    assert.deepEqual(windowShape(window), idealShape(expected))
    // The late list's works dated the day before it began don't count.
    assert.equal(window.days.get(since - 1), 2)
    assert.equal(window.days.get(since), 5)
  })
})

describe('planWindow — when a day is complete', () => {
  // Target 10 over rows dated S (6) and S + 1 (6+): day S + 1 tips it, so the
  // window is [S, S], settled once S is complete.
  const options = { start: S, today: TODAY, target: 10 }

  test('an exhausted list is complete', () => {
    const plan = planWindow([progress('a', [[S, 6], [S + 1, 6]], { exhausted: true })], options)
    assert.deepEqual(plan.window && [plan.window.start, plan.window.end, plan.window.count, plan.window.nextDayCount], [S, S, 6, 6])
  })

  test('as is one whose rows reached its total', () => {
    const plan = planWindow([progress('a', [[S, 6], [S + 1, 6]], { total: 12 })], options)
    assert.ok('window' in plan)
  })

  test('a boundary two days on that the rows have reached completes the day', () => {
    const plan = planWindow([progress('a', [[S, 6], [S + 1, 14]], { bounds: new Map([[S + 2, 20]]) })], options)
    assert.deepEqual(plan.window && [plan.window.start, plan.window.end], [S, S])
  })

  test('a boundary the rows haven\'t reached means another page, not another boundary', () => {
    const plan = planWindow([progress('a', [[S, 6], [S + 1, 12], [S + 2, 2]], { bounds: new Map([[S + 2, 23]]) })], options)
    assert.deepEqual(plan, { fetch: 'a', page: 2 })
  })

  test('a row dated three days on completes the day by itself', () => {
    const plan = planWindow([progress('a', [[S, 6], [S + 1, 6], [S + 3, 8]])], options)
    assert.deepEqual(plan.window && [plan.window.start, plan.window.end, plan.window.count], [S, S, 6])
  })

  test('two days on doesn\'t', () => {
    const plan = planWindow([progress('a', [[S, 6], [S + 1, 12], [S + 2, 2]])], options)
    assert.ok(!('window' in plan))
  })

  test('with nothing read yet, the first page', () => {
    assert.deepEqual(planWindow([progress('a', [], { total: 0 })], options), { fetch: 'a', page: 1 })
  })

  test('the list furthest behind is read first', () => {
    const plan = planWindow([
      progress('ahead', [[S, 6], [S + 1, 6], [S + 3, 8]]),
      progress('behind', [[S, 20]]),
    ], options)
    assert.deepEqual(plan, { fetch: 'behind', page: 2 })
  })
})

describe('planWindow — settling', () => {
  test('the day that tips the target only has to be seen tipping it', () => {
    // S + 1 is incomplete (the boundary only vouches for S), but it's over the
    // target already, and a partial count can only grow.
    const plan = planWindow(
      [progress('a', [[S, 6], [S + 1, 14]], { bounds: new Map([[S + 2, 20]]) })],
      { start: S, today: TODAY, target: 10 },
    )
    assert.deepEqual(plan.window && [plan.window.start, plan.window.end, plan.window.count], [S, S, 6])
  })

  test('an incomplete day inside the window holds it', () => {
    // S + 2 tips it, so the window would end at S + 1 — which isn't complete.
    const plan = planWindow(
      [progress('a', [[S, 6], [S + 1, 6], [S + 2, 8]], { bounds: new Map([[S + 2, 12]]) })],
      { start: S, today: TODAY, target: 15 },
    )
    assert.ok(!('window' in plan))
  })

  test('a one-day window still has to be complete itself', () => {
    const plan = planWindow([progress('a', [[S, 20]])], { start: S, today: TODAY, target: 10 })
    assert.deepEqual(plan, { fetch: 'a', page: 2 })
  })

  test('asks for a boundary once a list has read past the day after the end', () => {
    const plan = planWindow([progress('a', [[S, 6], [S + 1, 12], [S + 2, 2]])], { start: S, today: TODAY, target: 10 })
    assert.deepEqual(plan, { boundary: 'a', day: S + 2 })
  })

  test('reads the next page when it hasn\'t', () => {
    const plan = planWindow([progress('a', [[S, 6], [S + 1, 14]])], { start: S, today: TODAY, target: 10 })
    assert.deepEqual(plan, { fetch: 'a', page: 2 })
  })

  test('never asks for a boundary after today: only the end of the list answers that', () => {
    const start = TODAY - 3
    const plan = planWindow(
      [progress('a', [[start, 5], [start + 1, 5], [start + 2, 5], [TODAY, 4], [TODAY + 1, 1]], { base: start - 1 })],
      { start, today: TODAY, target: 1000 },
    )
    assert.deepEqual(plan, { fetch: 'a', page: 2 })
  })

  test('a work dated a day before it was filed, at the window\'s edge, is in this window and not the next', () => {
    // Filed S + 3 but dated S + 2, and the last of its day's works in the
    // query: on page 3, after every other work filed S + 3. The window ends at
    // S + 2, so it can't be settled until everything filed S + 3 is read.
    const late = { sid: 'late', filed: S + 3, dated: S + 2 }
    const spec = {
      id: 'a',
      base: S - 1,
      works: [...works('a', [[S, 7], [S + 1, 7], [S + 2, 7], [S + 3, 19]]), late, ...works('b', daily(S + 4, TODAY, 19))],
    }
    const { window, progress: lists } = run([spec], { start: S, today: TODAY, target: 22 })
    assert.deepEqual([window.start, window.end, window.count], [S, S + 2, 22])
    assert.equal(window.days.get(S + 2), 8)
    assert.ok(readIds(lists).has('late'))

    // Reviewed through S + 2, the next window starts at S + 3, and the work is
    // behind it.
    const next = { ...spec, base: S + 2 }
    const after = run([next], { start: S + 3, today: TODAY, target: 22 })
    assert.equal(ideal([next], { start: S + 3, today: TODAY, target: 22 }).inWindow.includes('late'), false)
    assert.equal(after.window.start, S + 3)
  })
})

describe('planWindow — what counts', () => {
  test('a work in two lists counts once, on the later of its days', () => {
    const plan = planWindow([
      progress('a', [], { items: [{ sid: 'w1', day: S, counts: true }, { sid: 'w2', day: S, counts: true }], exhausted: true }),
      progress('b', [], { items: [{ sid: 'w1', day: S + 2, counts: true }, { sid: 'w3', day: S + 1, counts: true }], exhausted: true }),
    ], { start: S, today: TODAY, target: 100 })
    assert.equal(plan.window.count, 3)
    assert.deepEqual([plan.window.days.get(S), plan.window.days.get(S + 1), plan.window.days.get(S + 2)], [1, 1, 1])
  })

  test('hidden works don\'t count, and don\'t tip the target', () => {
    const plan = planWindow(
      [progress('a', [[S, 30, false], [S, 6], [S + 1, 6]], { exhausted: true })],
      { start: S, today: TODAY, target: 10 },
    )
    assert.deepEqual([plan.window.end, plan.window.count], [S, 6])
  })

  test('already-reviewed works don\'t count but still hold their place in the query', () => {
    // The last row read is a work the reader already has; the boundary lands
    // just after it, so the rows have reached it only if that row is counted
    // as a position.
    const rows = [[S, 6], [S + 1, 13], [S + 1, 1, false]]
    const kept = planWindow([progress('a', rows, { bounds: new Map([[S + 2, 20]]) })], { start: S, today: TODAY, target: 10 })
    assert.deepEqual(kept.window && [kept.window.end, kept.window.count], [S, 6])

    const dropped = planWindow([progress('a', rows.slice(0, 2), { bounds: new Map([[S + 2, 20]]) })], { start: S, today: TODAY, target: 10 })
    assert.ok(!('window' in dropped))
  })

  test('a scanned list is read once, whole, and its old works are dropped', () => {
    const series = {
      id: 'series',
      base: S - 1,
      scanned: true,
      works: [
        { sid: 'part1', filed: dayOf('1 Jan 2019'), dated: dayOf('1 Jan 2019') },
        { sid: 'part2', filed: S - 1, dated: S - 1 },
        { sid: 'part3', filed: S + 2, dated: S + 2 },
      ],
    }
    const { window, requests } = run([series], { start: S, today: TODAY, target: 40 })
    assert.equal(requests.length, 1)
    assert.deepEqual([window.end, window.count, window.days.get(S + 2)], [YESTERDAY, 1, 1])
  })
})

describe('planWindow — failures', () => {
  test('a failed list makes the window unreviewable; the rest still sizes it', () => {
    const good = { id: 'good', base: S - 1, works: works('g', daily(S - 1, TODAY, 5)) }
    const bad = { id: 'bad', base: S - 1, works: works('b', daily(S - 1, TODAY, 5)), failOn: 1 }
    const { window, progress: lists } = run([good, bad], { start: S, today: TODAY, target: 30 })
    assert.equal(lists[1].failed, true)
    assert.deepEqual([window.start, window.end, window.count], [S, S + 5, 30])
    assert.equal(window.reviewable, false)
  })

  test('a list that fails partway keeps the works it read', () => {
    const good = { id: 'good', base: S - 1, works: works('g', daily(S - 1, TODAY, 1)) }
    const bad = { id: 'bad', base: S - 1, works: works('b', daily(S - 1, TODAY, 10)), failOn: 2 }
    const { window, progress: lists } = run([good, bad], { start: S, today: TODAY, target: 1000 })
    assert.equal(lists[1].failed, true)
    assert.equal(lists[1].items.length, 20)
    assert.equal(window.end, YESTERDAY)
    // Ten of its first page were filed (and dated) the day before the window.
    assert.equal(window.count, (YESTERDAY - S + 1) + 10)
    assert.equal(window.reviewable, false)
  })
})

describe('planWindow — endOverride', () => {
  // Long enough that a grown window still ends well short of the list's end.
  const from = TODAY - 30
  const spec = { id: 'a', base: from - 1, works: works('a', daily(from - 1, TODAY, 5)) }

  test('shrinking needs no more reading', () => {
    const natural = run([spec], { start: from, today: TODAY, target: 30 })
    assert.equal(natural.window.end, from + 5)
    const plan = planWindow(natural.progress, { start: from, today: TODAY, target: 30, endOverride: from + 2 })
    assert.deepEqual(plan.window && [plan.window.start, plan.window.end, plan.window.count, plan.window.nextDayCount], [from, from + 2, 15, 5])
  })

  test('growing reads as far as the new end needs, and no further', () => {
    const natural = run([spec], { start: from, today: TODAY, target: 30 })
    assert.ok(!('window' in planWindow(natural.progress, { start: from, today: TODAY, target: 30, endOverride: from + 9 })))

    const options = { start: from, today: TODAY, target: 30, endOverride: from + 9 }
    const { window, progress } = run([spec], options)
    assert.deepEqual(windowShape(window), idealShape(ideal([spec], options)))
    assert.equal(window.count, 50)
    assert.equal(progress[0].exhausted, false)
  })

  test('is kept between the start and yesterday', () => {
    assert.equal(run([spec], { start: from, today: TODAY, target: 30, endOverride: TODAY + 5 }).window.end, YESTERDAY)
    assert.equal(run([spec], { start: from, today: TODAY, target: 30, endOverride: from - 5 }).window.end, from)
  })
})

describe('planWindow — against a full read', () => {
  /**
   * A random set of lists: a few works a day each, some shared between lists,
   * about one in five dated a day off from when it was filed, some hidden or
   * already reviewed, and some lists tracked only partway into the window.
   */
  function scenario(seed) {
    const next = random(seed)
    const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1))
    const drift = () => {
      const x = next()
      return x < 0.1 ? -1 : x > 0.9 ? 1 : 0
    }
    const start = TODAY - int(1, 25)
    const shared = []
    for (let filed = start - 3; filed <= TODAY; filed++) {
      for (let n = int(0, 2); n > 0; n--)
        shared.push({ sid: `s${shared.length}`, filed, dated: filed + drift(), counts: next() > 0.15 })
    }
    const specs = []
    for (let i = int(1, 4); i > 0; i--) {
      const since = specs.length === 0 ? start - int(0, 10) : start - 10 + int(0, 16)
      const rate = int(0, 12)
      const own = []
      for (let filed = start - 3; filed <= TODAY; filed++) {
        for (let n = int(0, rate); n > 0; n--)
          own.push({ sid: `l${specs.length}-${own.length}`, filed, dated: filed + drift(), counts: next() > 0.15 })
      }
      const list = [...own, ...shared.filter(() => next() < 0.4)].sort((a, b) => a.filed - b.filed)
      specs.push({ id: `l${specs.length}`, base: Math.max(since, start) - 1, works: list })
    }
    const options = { start, today: TODAY, target: int(1, 80) }
    if (seed % 3 === 0)
      options.endOverride = int(start - 2, TODAY + 1)
    return { specs, options }
  }

  test('settles on the window a full read would give, having read every work in it', () => {
    let requests = 0
    let pages = 0
    for (let seed = 1; seed <= 400; seed++) {
      const { specs, options } = scenario(seed)
      const result = run(specs, options)
      const expected = ideal(specs, options)
      assert.deepEqual(windowShape(result.window), idealShape(expected), `seed ${seed}`)
      assert.equal(result.window.reviewable, true, `seed ${seed}`)
      assert.ok(result.window.nextDayCount <= expected.nextDayCount, `seed ${seed}`)
      const read = readIds(result.progress)
      for (const sid of expected.inWindow)
        assert.ok(read.has(sid), `seed ${seed}: ${sid} was never read`)
      requests += result.requests.length
      pages += specs.reduce((sum, spec) => sum + Math.max(1, Math.ceil(queryOf(spec).length / 20)), 0)
    }
    // Reading only what the window needs should cost well under reading it all.
    assert.ok(requests < pages, `${requests} requests against ${pages} pages`)
  })

  test('previews today once every list has been read to the end', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { specs } = scenario(seed)
      const rebased = specs.map(spec => ({ ...spec, base: TODAY - 1 }))
      const options = { start: TODAY, today: TODAY, target: 40 }
      const result = run(rebased, options)
      assert.deepEqual(windowShape(result.window), idealShape(ideal(rebased, options)), `seed ${seed}`)
      assert.equal(result.window.reviewable, false)
      assert.ok(result.progress.every(list => list.exhausted), `seed ${seed}`)
    }
  })
})
