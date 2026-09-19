// A stand-in for the archive and the fetcher, for the planner tests. Each list
// is a fixed set of works in the order the archive returns them oldest first,
// and `run()` drives planWindow() over them until it settles, applying every
// request the way the real fetcher does and refusing any request a correct
// planner would never make. Not a test file itself.

import { mergeItems, PAGE_SIZE, planWindow } from '../../src/common/trackedLists.ts'

/**
 * A list spec:
 *
 *     { id, base, works: [{ sid, filed, dated, counts? }], scanned?, failOn? }
 *
 * `filed` is the archive's day for a work, `dated` its blurb's. `works` must be
 * in filed order. `failOn: n` makes the list's nth request fail.
 */

/** The works a list's query returns: everything filed on or after its base (all of it, scanned). */
export function queryOf(spec) {
  return spec.scanned ? spec.works : spec.works.filter(work => work.filed >= spec.base)
}

/** Empty progress for a list, as the fetcher starts it. */
export function startProgress(spec) {
  return {
    id: spec.id,
    base: spec.base,
    items: [],
    total: 0,
    bounds: new Map(),
    exhausted: false,
    failed: false,
    ...(spec.scanned ? { scanned: true } : {}),
  }
}

const rowOf = work => ({ sid: work.sid, day: work.dated, counts: work.counts ?? true })

/** Apply one fetch or boundary request to a list's progress. */
function apply(spec, progress, plan, attempt) {
  if (progress.failed || progress.exhausted)
    throw new Error(`asked to read ${spec.id}, which is ${progress.failed ? 'failed' : 'exhausted'}`)
  if (spec.failOn === attempt) {
    progress.failed = true
    return
  }
  const query = queryOf(spec)

  if ('boundary' in plan) {
    if (progress.bounds.has(plan.day))
      throw new Error(`asked for the boundary at ${plan.day} on ${spec.id} twice`)
    if (plan.day <= spec.base)
      throw new Error(`asked for a boundary at ${plan.day}, not after ${spec.id}'s base ${spec.base}`)
    progress.total = query.length
    progress.bounds.set(plan.day, query.length - query.filter(work => work.filed >= plan.day).length)
    return
  }

  if (spec.scanned) {
    progress.items.push(...query.map(rowOf))
    progress.total = query.length
    progress.exhausted = true
    return
  }
  const expected = Math.floor(progress.items.length / PAGE_SIZE) + 1
  if (plan.page !== expected)
    throw new Error(`asked for page ${plan.page} of ${spec.id}; the next unread page is ${expected}`)
  const rows = query.slice((plan.page - 1) * PAGE_SIZE, plan.page * PAGE_SIZE)
  progress.items.push(...rows.map(rowOf))
  progress.total = query.length
  if (rows.length < PAGE_SIZE || progress.items.length >= progress.total)
    progress.exhausted = true
}

/**
 * Plan, fetch, repeat, until the planner settles. Returns the window, every
 * request made (in order), and the lists' final progress.
 */
export function run(specs, options, { maxSteps = 2000 } = {}) {
  const progress = specs.map(startProgress)
  const attempts = new Map()
  const requests = []
  for (let step = 0; step < maxSteps; step++) {
    const plan = planWindow(progress, options)
    if ('window' in plan)
      return { window: plan.window, requests, progress }
    const id = 'fetch' in plan ? plan.fetch : plan.boundary
    const index = specs.findIndex(spec => spec.id === id)
    if (index === -1)
      throw new Error(`asked to read unknown list ${id}`)
    const attempt = (attempts.get(id) ?? 0) + 1
    attempts.set(id, attempt)
    apply(specs[index], progress[index], plan, attempt)
    requests.push(plan)
  }
  throw new Error('the planner never settled')
}

/**
 * The window with every list read to the end: what the planner has to arrive at
 * without reading everything. Sized independently of the planner, from the
 * same merged counts.
 */
export function ideal(specs, { start, today, target, endOverride }) {
  const full = specs.map(spec => ({
    ...startProgress(spec),
    items: queryOf(spec).map(rowOf),
    total: queryOf(spec).length,
    exhausted: true,
  }))
  const merged = mergeItems(full, { start, today })
  const perDay = new Map()
  for (const work of merged.values()) {
    if (work.counts)
      perDay.set(work.day, (perDay.get(work.day) ?? 0) + 1)
  }

  const yesterday = today - 1
  let end
  if (start > yesterday) {
    end = start
  }
  else if (endOverride !== undefined) {
    end = Math.min(Math.max(endOverride, start), yesterday)
  }
  else {
    end = yesterday
    let total = 0
    for (let day = start; day <= today; day++) {
      total += perDay.get(day) ?? 0
      if (total > target) {
        end = Math.min(yesterday, Math.max(start, day - 1))
        break
      }
    }
  }

  const days = new Map()
  let count = 0
  for (let day = start; day <= end; day++) {
    days.set(day, perDay.get(day) ?? 0)
    count += perDay.get(day) ?? 0
  }
  const inWindow = [...merged].filter(([, work]) => work.day >= start && work.day <= end).map(([sid]) => sid)
  return { start, end, count, days, nextDayCount: perDay.get(end + 1) ?? 0, inWindow }
}

/**
 * Works for a list spec, in filed order: `[filed, n, drift?, counts?]` rows,
 * each making `n` works filed that day and dated `filed + drift`.
 */
export function works(prefix, rows) {
  const out = []
  for (const [filed, n, drift = 0, counts = true] of rows) {
    for (let i = 0; i < n; i++)
      out.push({ sid: `${prefix}${out.length}`, filed, dated: filed + drift, counts })
  }
  return out
}

/** A small seeded PRNG (mulberry32), so a failing random case can be replayed. */
export function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
