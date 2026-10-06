import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { addressOf, aliasOf, planRemoveList, planRetitle, planSaveBack, planSavedLists, planStopTracking, planTrack, planTrackCopy, planTrackSearch, savedListAt, savedListsOf, savedListsWrite, storedListRefs } from '../../src/common/savedLists.ts'
import { normalizeTrackedUrl, trackedKey } from '../../src/common/trackedLists.ts'

const AO3 = 'https://archiveofourown.org'
const DAY = 20_000
const TODAY = 20_400

const COFFEE = '/works/search?work_search[query]=coffee+shop'
const COFFEE_BY_KUDOS = '/works/search?work_search[query]=coffee+shop&work_search[sort_column]=kudos_count'
const TEA = '/works/search?work_search[query]=tea'
const TAG = '/tags/marriage%20problems'
const SERIES = '/series/123'
const HP = '/tags/Harry%20Potter%20-%20J*d*%20K*d*%20Rowling/works'
const HP_COMPLETE = '/works?tag_id=Harry+Potter+-+J*d*+K*d*+Rowling&work_search[complete]=T'
const BROKEN = 'https://example.com/tags/x'

const SLOW_BURN = { text: 'slow burn' }
const NO_DRACO = { facets: { characters: { ex: ['Draco Malfoy'] } } }

/** A tracked-lists entry, tracked unless told otherwise. */
function entry(id, url, fields = {}) {
  return { id, kind: normalizeTrackedUrl(url)?.kind ?? 'tag-works', url, alias: `List ${id}`, tracked: true, since: DAY, ...fields }
}

/** The record the planner makes of an entry: its shared fields, under its title. */
function recordOf({ id, kind, url, alias, type, entity, filter, scan }, extra = {}) {
  const record = { id, kind, url, title: alias }
  for (const [name, value] of Object.entries({ type, entity, filter, scan })) {
    if (value !== undefined)
      record[name] = value
  }
  return { ...record, ...extra }
}

/** A described stored list, keyed as its search view keys it. */
function copy(sourceId, path, fields = {}) {
  return { key: `${sourceId}:${path}`, sourceId, listUrl: `${AO3}${path}`, label: `${sourceId} ${path}`, scrapedAt: 1_000, ...fields }
}

function stateOf(lists, saved = { lists: {} }) {
  return deepFreeze({ tracked: { enabled: true, target: 40, reviewedThrough: DAY, lists }, saved })
}

function current(lists, records) {
  return stateOf(lists, { v: 1, lists: Object.fromEntries(records.map(record => [record.id, record])) })
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value))
      deepFreeze(child)
  }
  return value
}

/** Run the planner, then again on its own output, which must change nothing. */
function settle(state, stored = []) {
  deepFreeze(stored)
  const first = planSavedLists(state, stored)
  const second = planSavedLists(first.state, stored)
  assert.deepEqual(second.changed, { tracked: false, saved: false }, 'the second run changes nothing')
  assert.deepEqual(second.state, first.state)
  return first
}

const records = state => Object.values(state.saved.lists)

/** The stored lists left once the caller has deleted the ones a plan names. */
function without(stored, keys) {
  const gone = new Set(keys)
  return stored.filter(one => !gone.has(one.key))
}

describe('addressOf', () => {
  test('a list\'s address is its key, the sort and the archive\'s origin left out', () => {
    assert.equal(addressOf(`${AO3}${COFFEE_BY_KUDOS}&page=3`), 'text-search:/works/search?work_search[query]=coffee+shop')
    assert.equal(addressOf(COFFEE), addressOf(COFFEE_BY_KUDOS))
    assert.equal(addressOf(HP_COMPLETE), 'works-filter:/tags/Harry%20Potter%20-%20J*d*%20K*d*%20Rowling/works?work_search[complete]=T')
  })

  test('nothing that isn\'t a list on the archive has one', () => {
    for (const url of [BROKEN, '/users/me/readings?show=to-read', '/works/search', '', undefined])
      assert.equal(addressOf(url), null, String(url))
  })
})

describe('planSavedLists, migrating a legacy state', () => {
  test('a paused entry with a stored list leaves the synced set, and a record keeps the rest of it', () => {
    const paused = entry('p1', COFFEE_BY_KUDOS, { alias: 'Coffee', type: 'search', entity: 'coffee shop', filter: SLOW_BURN, tracked: false, since: DAY - 9 })
    const stored = [copy('text-search', 'work_search[query]=coffee+shop', { listUrl: `${AO3}${COFFEE}&page=1` })]
    const { state, changed } = settle(stateOf([paused]), stored)

    assert.deepEqual(changed, { tracked: true, saved: true })
    assert.deepEqual(state.tracked.lists, [])
    assert.deepEqual(state.saved, { v: 1, lists: { p1: recordOf(paused) } })
    assert.equal(addressOf(state.saved.lists.p1.url), addressOf(stored[0].listUrl), 'the copy joins it by address, so it gets no record of its own')
  })

  test('a paused entry without one becomes a record all the same', () => {
    const paused = entry('p2', TAG, { alias: 'Marriage', type: 'freeform', entity: 'marriage problems', tracked: false, scan: true })
    const { state } = settle(stateOf([paused]))
    assert.deepEqual(state.tracked.lists, [])
    assert.deepEqual(state.saved.lists, { p2: recordOf(paused) })
  })

  test('a paused entry with a broken address keeps its URL as stored', () => {
    const paused = entry('p3', BROKEN, { kind: 'tag-works', alias: 'Elsewhere', tracked: false })
    const { state } = settle(stateOf([paused]))
    assert.deepEqual(state.tracked.lists, [])
    assert.deepEqual(state.saved.lists, { p3: recordOf(paused) })
    assert.equal(addressOf(state.saved.lists.p3.url), null)
  })

  test('a paused entry with no title makes an untitled record', () => {
    const paused = entry('p4', TEA, { alias: '', tracked: false })
    const { state } = settle(stateOf([paused]))
    assert.deepEqual(state.tracked.lists, [])
    assert.equal(state.saved.lists.p4.title, '')
  })

  test('tracked entries stay, each with a record of the same id and title, a filtered one included', () => {
    const filtered = entry('t1', TAG, { alias: 'Marriage, no slow burn', filter: SLOW_BURN })
    const plain = entry('t2', SERIES, { alias: 'The series', type: 'series', entity: 'The Long Way Round' })
    const stored = [copy('tag-works', 'marriage%20problems', { listUrl: `${AO3}${TAG}` }), copy('series-works', '123', { listUrl: `${AO3}${SERIES}` })]
    const before = stateOf([filtered, plain])
    const { state, changed } = settle(before, stored)

    assert.deepEqual(changed, { tracked: false, saved: true })
    assert.equal(state.tracked, before.tracked)
    assert.deepEqual(state.saved.lists, { t1: recordOf(filtered), t2: recordOf(plain) })
  })

  test('a tracked entry without a stored list gets its record all the same', () => {
    const tracked = entry('t3', TEA, { alias: 'Tea' })
    const { state } = settle(stateOf([tracked]))
    assert.deepEqual(state.tracked.lists, [tracked])
    assert.deepEqual(state.saved.lists, { t3: recordOf(tracked) })
  })

  test('two tracked entries at one address, filtered differently, are two records sharing the copy', () => {
    const a = entry('a', HP, { alias: 'HP' })
    const b = entry('b', HP, { alias: 'HP, no Draco', filter: NO_DRACO })
    const stored = [copy('works-filter', HP, { listUrl: `${AO3}${HP}` })]
    const { state } = settle(stateOf([a, b]), stored)
    assert.deepEqual(state.saved.lists, { a: recordOf(a), b: recordOf(b) })
  })

  test('a stored list with no entry gets a new, untitled record, described from its descriptor', () => {
    const tracked = entry('t1', TEA)
    const stored = [
      copy('text-search', 'work_search[query]=coffee+shop', { listUrl: `${AO3}${COFFEE}&page=1`, label: 'Search: coffee shop' }),
      copy('tag-works', 'marriage%20problems', { listUrl: `${AO3}${TAG}`, label: 'Tag: marriage problems' }),
      copy('series-works', '123', { listUrl: `${AO3}${SERIES}`, label: 'Series: The Long Way Round' }),
    ]
    const { state } = settle(stateOf([tracked]), stored)

    const made = records(state).filter(record => record.id !== 't1')
    const byKind = Object.fromEntries(made.map(({ id, ...record }) => [record.kind, record]))
    assert.deepEqual(byKind, {
      'text-search': { kind: 'text-search', url: COFFEE, title: '', type: 'search', entity: 'coffee shop' },
      'tag-works': { kind: 'tag-works', url: TAG, title: '', type: 'tag', entity: 'marriage problems' },
      'series-works': { kind: 'series-works', url: SERIES, title: '', type: 'series', entity: 'The Long Way Round' },
    })
    const ids = records(state).map(record => record.id)
    assert.equal(new Set(ids).size, 4, 'every id is new, and none is an entry\'s')
    for (const record of made)
      assert.equal(state.saved.lists[record.id], record, 'filed under its own id')
  })

  test('two stored lists at one address are one record, made from the newer', () => {
    const stored = [
      copy('text-search', 'by-date', { listUrl: `${AO3}${COFFEE}`, scrapedAt: 1_000 }),
      copy('text-search', 'by-kudos', { listUrl: `${AO3}${COFFEE_BY_KUDOS}`, scrapedAt: 2_000 }),
    ]
    const { state } = settle(stateOf([]), stored)
    assert.equal(records(state).length, 1)
    assert.equal(records(state)[0].url, COFFEE_BY_KUDOS)
  })

  test('an undescribed stored list, the built-ins and the review window get no record', () => {
    const stored = [
      { key: 'tag-works:old%20tag', scrapedAt: 1_000 },
      copy('marked-for-later', 'me', { listUrl: `${AO3}/users/me/readings?show=to-read` }),
      copy('read-works', 'me', { listUrl: `${AO3}/users/me/readings` }),
      copy('tracked-review', 'window', { listUrl: `${AO3}/users/me/readings#ao3e-tracked` }),
      copy('works-filter', HP, { listUrl: `${AO3}${HP}` }),
    ]
    const { state, changed } = settle(stateOf([]), stored)
    assert.deepEqual(changed, { tracked: false, saved: true })
    assert.deepEqual(state.saved, { v: 1, lists: {} })
  })

  test('any legacy state is stamped, and gets no mirror flags', () => {
    const empty = settle(stateOf([]))
    assert.deepEqual(empty.changed, { tracked: false, saved: true })
    assert.deepEqual(empty.state.saved, { v: 1, lists: {} })
    assert.deepEqual(settle(stateOf([], { v: '1', lists: {} })).state.saved, { v: 1, lists: {} }, 'a version that isn\'t one is no version')

    const mixed = settle(
      stateOf([entry('t', TEA), entry('p', TAG, { tracked: false })]),
      [copy('series-works', '123', { listUrl: `${AO3}${SERIES}` })],
    )
    assert.equal(mixed.state.saved.v, 1)
    assert.equal(records(mixed.state).length, 3)
    for (const record of records(mixed.state))
      assert.equal('mirror' in record, false, record.id)
  })

  test('an entry it can\'t read is left where it is', () => {
    const junk = [null, 'x', { kind: 'text-search', url: TEA, alias: 'No id', tracked: false, since: DAY }, entry('__proto__', TEA, { tracked: false })]
    const { state } = settle(stateOf(junk))
    assert.deepEqual(state.tracked.lists, junk)
    assert.deepEqual(state.saved.lists, {})
    assert.equal(Object.getPrototypeOf(state.saved.lists), Object.prototype)
  })
})

describe('planSavedLists, reconciling', () => {
  test('an entry arriving for an id this browser doesn\'t know makes a mirror record', () => {
    const arrived = entry('new', TEA, { alias: 'Tea, from elsewhere' })
    const { state, changed } = settle(current([arrived], []))
    assert.deepEqual(changed, { tracked: false, saved: true })
    assert.deepEqual(state.saved.lists, { new: recordOf(arrived, { mirror: true }) })
  })

  test('an entry\'s change overwrites its record: the entry is authoritative', () => {
    const was = entry('t', TAG, { alias: 'Old title', filter: SLOW_BURN, scan: true })
    const now = entry('t', HP, { alias: 'New title', type: 'fandom', entity: 'Harry Potter - J. K. Rowling' })
    for (const extra of [{}, { mirror: true }]) {
      const { state } = settle(current([now], [recordOf(was, extra)]))
      assert.deepEqual(state.saved.lists, { t: recordOf(now, extra) }, 'a field the entry dropped goes from the record too')
    }
  })

  test('a mirror whose id leaves the synced set goes, when nothing of it is held here', () => {
    const gone = recordOf(entry('m', TEA), { mirror: true })
    const { state, changed } = settle(current([], [gone]))
    assert.deepEqual(changed, { tracked: false, saved: true })
    assert.deepEqual(state.saved.lists, {})
  })

  test('a mirror whose id leaves stays saved when this browser holds its copy', () => {
    const left = recordOf(entry('m', COFFEE, { alias: 'Coffee' }), { mirror: true })
    const stored = [copy('text-search', 'by-kudos', { listUrl: `${AO3}${COFFEE_BY_KUDOS}` })]
    const { state } = settle(current([], [left]), stored)
    const { mirror, ...saved } = left
    assert.deepEqual(state.saved.lists, { m: saved }, 'no longer a mirror, so removing the copy later doesn\'t take the list')
  })

  test('a record touched here stays saved when its id leaves', () => {
    const local = recordOf(entry('l', TEA, { alias: 'Mine' }))
    const before = current([], [local])
    const { state, changed } = settle(before)
    assert.deepEqual(changed, { tracked: false, saved: false })
    assert.equal(state.saved, before.saved)
  })

  test('a re-tracked id overwrites a saved record\'s title, and the record stays local', () => {
    const saved = recordOf(entry('r', TEA, { alias: 'My title' }))
    const tracker = entry('r', TEA, { alias: 'The tracker\'s title' })
    const { state } = settle(current([tracker], [saved]))
    assert.deepEqual(state.saved.lists, { r: { ...saved, title: 'The tracker\'s title' } })
  })

  test('a paused entry, from an older backup, leaves the set and its record becomes local', () => {
    const paused = entry('p', TEA, { alias: 'Paused', tracked: false })
    const { state, changed } = settle(current([paused], [recordOf(paused, { mirror: true, title: 'Was mirrored' })]))
    assert.deepEqual(changed, { tracked: true, saved: true })
    assert.deepEqual(state.tracked.lists, [])
    assert.deepEqual(state.saved.lists, { p: recordOf(paused) })
  })

  test('nothing else is deleted', () => {
    const lone = recordOf(entry('lone', BROKEN, { kind: 'tag-works', alias: '' }))
    const before = current([], [lone])
    assert.deepEqual(planSavedLists(before, []).changed, { tracked: false, saved: false })
  })
})

describe('planRetitle', () => {
  const saved = recordOf(entry('s', TEA, { alias: 'Tea' }))
  const tracked = entry('t', COFFEE, { alias: 'Coffee' })

  test('a saved list\'s title is written to its record alone, trimmed', () => {
    const before = current([tracked], [saved, recordOf(tracked)])
    const plan = planRetitle(before, 's', '  Green tea ')
    assert.equal(plan.ok, true)
    assert.equal(plan.state.saved.lists.s.title, 'Green tea')
    assert.equal(plan.state.tracked, before.tracked)
  })

  test('a tracked list\'s title is written to the record and the entry', () => {
    const plan = planRetitle(current([tracked], [saved, recordOf(tracked)]), 't', 'Coffee shops')
    assert.equal(plan.state.saved.lists.t.title, 'Coffee shops')
    assert.deepEqual(plan.state.tracked.lists, [{ ...tracked, alias: 'Coffee shops' }])
  })

  test('refuses a title another list has, trimmed and in any case, and says which', () => {
    const plan = planRetitle(current([tracked], [saved, recordOf(tracked)]), 's', ' COFFEE ')
    assert.equal(plan.ok, false)
    assert.equal(plan.takenBy.id, 't')
  })

  test('untitled is never taken', () => {
    const blank = recordOf(entry('b', TAG, { alias: '' }))
    assert.equal(planRetitle(current([], [saved, blank]), 's', '  ').state.saved.lists.s.title, '')
  })

  test('never adds or removes an entry', () => {
    const before = current([tracked], [saved, recordOf(tracked)])
    for (const id of ['s', 't'])
      assert.deepEqual(planRetitle(before, id, `Renamed ${id}`).state.tracked.lists.map(one => one.id), ['t'])
  })

  test('a mirror retitled here is no longer one; committing the same title again touches nothing', () => {
    const mirror = recordOf(tracked, { mirror: true })
    assert.equal('mirror' in planRetitle(current([tracked], [mirror]), 't', 'Mine').state.saved.lists.t, false)
    const same = current([tracked], [mirror])
    assert.equal(planRetitle(same, 't', ' Coffee ').state, same)
  })

  test('a list that is gone is left gone', () => {
    const before = current([], [saved])
    assert.equal(planRetitle(before, 'gone', 'x').state, before)
  })

  test('an entry with no record yet gets one, under the new title, and the entry takes it too', () => {
    const plan = planRetitle(current([tracked], []), 't', 'Coffee shops')
    assert.deepEqual(plan.state.saved.lists, { t: recordOf(tracked, { title: 'Coffee shops' }) })
    assert.deepEqual(plan.state.tracked.lists, [{ ...tracked, alias: 'Coffee shops' }])
  })

  test('a title only an entry has so far is taken all the same', () => {
    const plan = planRetitle(current([tracked], [saved]), 's', 'coffee')
    assert.equal(plan.ok, false)
    assert.equal(plan.takenBy.id, 't')
  })
})

describe('planTrack', () => {
  const saved = recordOf(entry('s', HP, { alias: 'HP, no Draco', type: 'fandom', entity: 'Harry Potter - J. K. Rowling', filter: NO_DRACO }))

  test('copies the record into a new entry tracked from today, and leaves the record', () => {
    const before = current([], [saved])
    const plan = planTrack(before, 's', TODAY)
    assert.equal(plan.ok, true)
    assert.deepEqual(plan.state.tracked.lists, [{
      id: 's',
      kind: 'works-filter',
      url: HP,
      alias: 'HP, no Draco',
      type: 'fandom',
      entity: 'Harry Potter - J. K. Rowling',
      filter: NO_DRACO,
      tracked: true,
      since: TODAY,
    }])
    assert.equal(plan.state.saved, before.saved)
  })

  test('refuses when another tracked list is the same search, and says which', () => {
    const twin = entry('twin', HP, { filter: NO_DRACO })
    const plan = planTrack(current([twin], [saved, recordOf(twin)]), 's', TODAY)
    assert.equal(plan.ok, false)
    assert.equal(plan.twin.id, 'twin')
  })

  test('the same address with another view filter is no twin', () => {
    const unfiltered = entry('u', HP)
    const plan = planTrack(current([unfiltered], [saved, recordOf(unfiltered)]), 's', TODAY)
    assert.deepEqual(plan.state.tracked.lists.map(one => one.id), ['u', 's'])
  })

  test('a list already tracked is left as it is', () => {
    const tracked = entry('s', HP, { alias: saved.title, filter: NO_DRACO })
    const before = current([tracked], [saved])
    assert.equal(planTrack(before, 's', TODAY).state, before)
  })
})

describe('planStopTracking', () => {
  const tracked = entry('t', TEA, { alias: 'Tea' })

  test('removes the entry and keeps the record, as a list made here', () => {
    const other = entry('o', COFFEE)
    for (const extra of [{}, { mirror: true }]) {
      const state = planStopTracking(current([tracked, other], [recordOf(tracked, extra), recordOf(other)]), 't')
      assert.deepEqual(state.tracked.lists, [other])
      assert.deepEqual(state.saved.lists.t, recordOf(tracked))
    }
  })

  test('an entry with no record yet gets one before it goes', () => {
    const state = planStopTracking(current([tracked], []), 't')
    assert.deepEqual(state.tracked.lists, [])
    assert.deepEqual(state.saved.lists, { t: recordOf(tracked) })
  })

  test('a list not tracked is left as it is', () => {
    const before = current([], [recordOf(tracked)])
    assert.equal(planStopTracking(before, 't'), before)
  })
})

describe('planRemoveList', () => {
  const tracked = entry('t', COFFEE, { alias: 'Coffee' })
  const older = copy('text-search', 'by-date', { listUrl: `${AO3}${COFFEE}`, scrapedAt: 1_000 })
  const newer = copy('text-search', 'by-kudos', { listUrl: `${AO3}${COFFEE_BY_KUDOS}`, scrapedAt: 2_000 })

  test('deletes the record and the entry, and its copies', () => {
    const other = recordOf(entry('o', TEA))
    const plan = planRemoveList(current([tracked], [recordOf(tracked), other]), 't', [older, newer])
    assert.deepEqual(plan.state.tracked.lists, [])
    assert.deepEqual(plan.state.saved.lists, { o: other })
    assert.deepEqual(plan.dropCopies, [newer.key, older.key])
  })

  test('takes every copy at its address, so an older sort order doesn\'t bring it back untitled', () => {
    const plan = planRemoveList(current([tracked], [recordOf(tracked)]), 't', [older, newer])
    assert.deepEqual(plan.dropCopies, [newer.key, older.key], 'newest first')
    const left = without([older, newer], plan.dropCopies)
    assert.deepEqual(records(planSavedLists(plan.state, left).state), [], 'no list reappears')
  })

  test('keeps a copy another record shares', () => {
    const sharing = recordOf(entry('s', COFFEE_BY_KUDOS, { alias: 'Same search', filter: SLOW_BURN }))
    const plan = planRemoveList(current([tracked], [recordOf(tracked), sharing]), 't', [newer])
    assert.deepEqual(Object.keys(plan.state.saved.lists), ['s'])
    assert.deepEqual(plan.dropCopies, [])
  })

  test('a list with no copy drops none', () => {
    const plan = planRemoveList(current([], [recordOf(tracked)]), 't', [copy('text-search', 'tea', { listUrl: `${AO3}${TEA}` })])
    assert.deepEqual(plan.state.saved.lists, {})
    assert.deepEqual(plan.dropCopies, [])
  })
})

describe('planSaveBack', () => {
  const meta = { type: 'search', entity: 'tea' }
  const coffee = recordOf(entry('c', COFFEE, { alias: 'Coffee', type: 'search', entity: 'coffee shop' }))
  const oldCopy = copy('text-search', 'coffee', { listUrl: `${AO3}${COFFEE}` })
  const newCopy = copy('text-search', 'tea', { listUrl: `${AO3}${TEA}`, scrapedAt: 3_000 })
  const autoRecord = { id: 'auto', kind: 'text-search', url: TEA, title: '', type: 'search', entity: 'tea' }

  test('rewrites a saved list in place under its own id, and leaves what syncs alone', () => {
    const before = current([], [coffee])
    const plan = planSaveBack(before, 'c', { url: `${AO3}${TEA}&page=2`, kind: 'text-search', meta, filter: SLOW_BURN }, [oldCopy])
    assert.equal(plan.ok, true)
    assert.deepEqual(plan.state.saved.lists, { c: { id: 'c', kind: 'text-search', url: TEA, title: 'Coffee', type: 'search', entity: 'tea', filter: SLOW_BURN } })
    assert.equal(plan.state.tracked, before.tracked)
    assert.deepEqual(plan.dropCopies, [oldCopy.key])
    assert.equal(plan.absorbed, null)
  })

  test('rewrites a tracked list\'s entry the same way, keeping its tracking start', () => {
    const tracked = entry('c', COFFEE, { alias: 'Coffee', type: 'search', entity: 'coffee shop', since: DAY - 30 })
    const plan = planSaveBack(current([tracked], [recordOf(tracked, { mirror: true })]), 'c', { url: TEA, kind: 'text-search', meta }, [])
    assert.deepEqual(plan.state.tracked.lists, [{ ...tracked, url: TEA, entity: 'tea' }])
    assert.deepEqual(plan.state.saved.lists.c, recordOf(plan.state.tracked.lists[0]), 'record and entry agree, and a save-back here ends the mirror')
  })

  test('absorbs the untitled, untracked record made for the new address', () => {
    const plan = planSaveBack(current([], [coffee, autoRecord]), 'c', { url: TEA, kind: 'text-search', meta }, [oldCopy, newCopy])
    assert.deepEqual(plan.absorbed, autoRecord)
    assert.deepEqual(Object.keys(plan.state.saved.lists), ['c'])
  })

  test('a titled, tracked or filtered list at the new address is a list of its own, and stays', () => {
    const titled = { ...autoRecord, title: 'Tea' }
    const filtered = { ...autoRecord, filter: NO_DRACO }
    const trackedEntry = entry('auto', TEA, { alias: '' })
    for (const [lists, other] of [[[], titled], [[], filtered], [[trackedEntry], autoRecord]]) {
      const plan = planSaveBack(current(lists, [coffee, other]), 'c', { url: TEA, kind: 'text-search', meta }, [])
      assert.equal(plan.absorbed, null)
      assert.deepEqual(Object.keys(plan.state.saved.lists).sort(), ['auto', 'c'])
    }
  })

  test('a move takes every copy at the old address, so an older sort order isn\'t left there as a list', () => {
    const byKudos = copy('text-search', 'coffee-by-kudos', { listUrl: `${AO3}${COFFEE_BY_KUDOS}`, scrapedAt: 2_000 })
    const stored = [oldCopy, byKudos]
    const plan = planSaveBack(current([], [coffee]), 'c', { url: TEA, kind: 'text-search', meta }, stored)
    assert.deepEqual(plan.dropCopies, [byKudos.key, oldCopy.key], 'newest first')
    const left = without(stored, plan.dropCopies)
    assert.deepEqual(Object.keys(planSavedLists(plan.state, left).state.saved.lists), ['c'], 'no list appears at the old address')
  })

  test('keeps the old copy while another list still has the old address', () => {
    const sharing = recordOf(entry('s', COFFEE_BY_KUDOS, { alias: 'Same search', filter: SLOW_BURN }))
    const plan = planSaveBack(current([], [coffee, sharing]), 'c', { url: TEA, kind: 'text-search', meta }, [oldCopy])
    assert.deepEqual(plan.dropCopies, [])
  })

  test('a filter-only change keeps the copy and absorbs nothing', () => {
    const blank = recordOf(entry('b', COFFEE_BY_KUDOS, { alias: '' }))
    const plan = planSaveBack(current([], [coffee, blank]), 'c', { url: COFFEE_BY_KUDOS, kind: 'text-search', meta: { type: 'search', entity: 'coffee shop' }, filter: SLOW_BURN }, [oldCopy])
    assert.deepEqual(plan.dropCopies, [])
    assert.equal(plan.absorbed, null)
    assert.deepEqual(plan.state.saved.lists.c.filter, SLOW_BURN)
  })

  test('a default title follows the search to a new root; any other title stays', () => {
    const byDefault = { ...coffee, title: 'Search: coffee shop' }
    assert.equal(planSaveBack(current([], [byDefault]), 'c', { url: TEA, kind: 'text-search', meta }, []).state.saved.lists.c.title, 'Search: tea')
    assert.equal(planSaveBack(current([], [coffee]), 'c', { url: TEA, kind: 'text-search', meta }, []).state.saved.lists.c.title, 'Coffee')
    const sameRoot = planSaveBack(current([], [byDefault]), 'c', { url: COFFEE_BY_KUDOS, kind: 'text-search', meta: { type: 'search', entity: 'coffee shop' }, filter: SLOW_BURN }, [])
    assert.equal(sameRoot.state.saved.lists.c.title, 'Search: coffee shop')
  })

  test('takes a title typed for it; a blank one is the new search\'s default', () => {
    assert.equal(planSaveBack(current([], [coffee]), 'c', { url: TEA, kind: 'text-search', meta, title: ' Teatime ' }, []).state.saved.lists.c.title, 'Teatime')
    const taken = { ...autoRecord, id: 'x', url: TAG, title: 'Search: tea' }
    assert.equal(planSaveBack(current([], [coffee, taken]), 'c', { url: TEA, kind: 'text-search', meta, title: '' }, []).state.saved.lists.c.title, 'Search: tea (2)')
  })

  test('refuses a typed title another list has, and says which', () => {
    const other = recordOf(entry('o', TAG, { alias: 'Teatime' }))
    const plan = planSaveBack(current([], [coffee, other]), 'c', { url: TEA, kind: 'text-search', meta, title: 'TEATIME' }, [])
    assert.equal(plan.ok, false)
    assert.equal(plan.reason, 'title')
    assert.equal(plan.other.id, 'o')
  })

  test('refuses to make a tracked list another tracked list\'s twin, and says which', () => {
    const tracked = entry('c', COFFEE, { alias: 'Coffee' })
    const twin = entry('tea', TEA, { alias: 'Tea' })
    const plan = planSaveBack(current([tracked, twin], [recordOf(tracked), recordOf(twin)]), 'c', { url: TEA, kind: 'text-search', meta }, [])
    assert.equal(plan.ok, false)
    assert.equal(plan.reason, 'duplicate')
    assert.equal(plan.other.id, 'tea')

    const untracked = planSaveBack(current([twin], [coffee, recordOf(twin)]), 'c', { url: TEA, kind: 'text-search', meta }, [])
    assert.equal(untracked.ok, true, 'a saved list may search what a tracked one does')
  })

  test('nothing to save back, or nothing to save it as', () => {
    assert.deepEqual(planSaveBack(current([], [coffee]), 'gone', { url: TEA, kind: 'text-search', meta }, []), { ok: false, reason: 'missing' })
    assert.deepEqual(planSaveBack(current([], [coffee]), 'c', { url: BROKEN, kind: 'tag-works', meta }, []), { ok: false, reason: 'invalid' })
    assert.deepEqual(planSaveBack(current([], [coffee]), 'c', { url: TEA, kind: 'tag-works', meta }, []), { ok: false, reason: 'invalid' })
  })
})

describe('storedListRefs', () => {
  test('each stored list as the planner reads it, its descriptor flattened in', () => {
    const lists = {
      'text-search:tea': { v: 3, scrapedAt: 2_000, ids: 'a,b', descriptor: { sourceId: 'text-search', label: 'Search: tea', listUrl: `${AO3}${TEA}` } },
      'tag-works:old': { v: 3, scrapedAt: 1_000, ids: 'c' },
    }
    assert.deepEqual(storedListRefs(lists), [
      { key: 'text-search:tea', sourceId: 'text-search', listUrl: `${AO3}${TEA}`, label: 'Search: tea', scrapedAt: 2_000 },
      { key: 'tag-works:old', scrapedAt: 1_000 },
    ])
  })

  test('whatever storage holds that isn\'t a list is left out', () => {
    assert.deepEqual(storedListRefs(undefined), [])
    assert.deepEqual(storedListRefs('x'), [])
    assert.deepEqual(storedListRefs({ a: null, b: 'x', c: { ids: '' } }), [{ key: 'c', scrapedAt: 0 }])
    assert.deepEqual(storedListRefs({ d: { scrapedAt: 5, descriptor: { sourceId: 7, listUrl: null } } }), [{ key: 'd', scrapedAt: 5 }])
  })
})

describe('savedListsWrite', () => {
  test('only the halves a plan changed are written', () => {
    const legacy = stateOf([entry('p', TEA, { tracked: false })])
    const migrated = planSavedLists(legacy, []).state
    assert.deepEqual(savedListsWrite(legacy, migrated), { trackedLists: migrated.tracked, savedLists: migrated.saved })
    const empty = stateOf([])
    const stamped = planSavedLists(empty, []).state
    assert.deepEqual(savedListsWrite(empty, stamped), { savedLists: { v: 1, lists: {} } })
    assert.deepEqual(savedListsWrite(stamped, planSavedLists(stamped, []).state), {}, 'a run that changed nothing writes nothing')
  })

  test('a title on a saved list writes nothing that syncs', () => {
    const before = current([], [recordOf(entry('s', TEA, { alias: 'Tea' }))])
    assert.deepEqual(Object.keys(savedListsWrite(before, planRetitle(before, 's', 'Green tea').state)), ['savedLists'])
  })
})

describe('aliasOf', () => {
  test('a saved list as the title helpers read a list: its title as an alias', () => {
    const record = recordOf(entry('s', TEA, { alias: 'Tea', type: 'search', entity: 'tea', filter: SLOW_BURN }))
    assert.deepEqual(aliasOf(record), { id: 's', alias: 'Tea', url: TEA, type: 'search', entity: 'tea' })
  })
})

describe('savedListsOf', () => {
  const tracked = entry('t', TEA, { alias: 'Tea' })
  const saved = recordOf(entry('s', COFFEE, { alias: 'Coffee' }))

  test('every record, each with its entry while it is tracked', () => {
    assert.deepEqual(savedListsOf(current([tracked], [recordOf(tracked), saved])), [
      { list: recordOf(tracked), entry: tracked },
      { list: saved, entry: null },
    ])
  })

  test('an entry with no record yet is the record the planner will make of it', () => {
    const paused = entry('p', TAG, { alias: 'Paused', tracked: false })
    assert.deepEqual(savedListsOf(current([tracked, paused], [saved])), [
      { list: saved, entry: null },
      { list: recordOf(tracked), entry: tracked },
      { list: recordOf(paused), entry: null },
    ])
  })

  test('nothing it can\'t read', () => {
    const state = stateOf([null, { kind: 'text-search', url: TEA }], { v: 1, lists: { x: null, y: 'junk' } })
    assert.deepEqual(savedListsOf(state), [])
    assert.deepEqual(savedListsOf({}), [])
  })
})

describe('savedListAt', () => {
  const tracked = entry('t', HP, { alias: 'HP' })
  const filtered = recordOf(entry('f', HP, { alias: 'HP, no Draco', filter: NO_DRACO }))
  const plain = recordOf(entry('p', COFFEE, { alias: '' }))

  test('the untracked saved list that searches exactly that, view filter and all', () => {
    const state = current([tracked], [recordOf(tracked), filtered, plain])
    assert.equal(savedListAt(state, trackedKey(filtered)), filtered)
    assert.equal(savedListAt(state, trackedKey({ url: COFFEE_BY_KUDOS })), plain)
  })

  test('a tracked list is no saved list to track, and nothing is at nothing', () => {
    const state = current([tracked], [recordOf(tracked), filtered])
    assert.equal(savedListAt(state, trackedKey(tracked)), null)
    assert.equal(savedListAt(state, null), null)
  })
})

describe('planTrackSearch', () => {
  const query = { kind: 'text-search', url: TEA, type: 'search', entity: 'tea' }

  test('a search no list is becomes a new list: a record and its entry, one new id', () => {
    const other = entry('o', COFFEE, { alias: 'Coffee' })
    const before = current([other], [recordOf(other)])
    const plan = planTrackSearch(before, query, '  Tea time ', TODAY)
    assert.equal(plan.ok, true)
    assert.notEqual(plan.id, 'o')
    assert.deepEqual(plan.state.saved.lists[plan.id], { id: plan.id, ...query, title: 'Tea time' })
    assert.deepEqual(plan.state.tracked.lists, [other, { id: plan.id, ...query, alias: 'Tea time', tracked: true, since: TODAY }])
  })

  test('a saved list that is exactly the search is tracked under its own id, taking the search and the title given', () => {
    const auto = { id: 'auto', kind: 'tag-works', url: TAG, title: '', type: 'tag', entity: 'marriage problems' }
    const checked = { kind: 'tag-works', url: TAG, type: 'freeform', entity: 'marriage problems', scan: true }
    const plan = planTrackSearch(current([], [{ ...auto, mirror: true }]), checked, 'Tag: marriage problems', TODAY)
    assert.equal(plan.id, 'auto')
    assert.deepEqual(plan.state.saved.lists, { auto: { id: 'auto', ...checked, title: 'Tag: marriage problems' } })
    assert.deepEqual(plan.state.tracked.lists, [{ id: 'auto', ...checked, alias: 'Tag: marriage problems', tracked: true, since: TODAY }])
  })

  test('the same address with another view filter is another list', () => {
    const plain = recordOf(entry('p', TEA, { alias: '' }))
    const plan = planTrackSearch(current([], [plain]), { ...query, filter: SLOW_BURN }, 'Tea, slow burn', TODAY)
    assert.notEqual(plan.id, 'p')
    assert.deepEqual(plan.state.saved.lists.p, plain)
  })

  test('refuses a search another list already tracks, and says which', () => {
    const twin = entry('twin', TEA, { alias: 'Tea' })
    const plan = planTrackSearch(current([twin], [recordOf(twin)]), query, 'Tea again', TODAY)
    assert.equal(plan.ok, false)
    assert.equal(plan.twin.id, 'twin')
  })

  test('refuses a title another list has, trimmed and in any case, and says which', () => {
    const saved = recordOf(entry('s', COFFEE, { alias: 'Morning' }))
    const plan = planTrackSearch(current([], [saved]), query, ' MORNING', TODAY)
    assert.equal(plan.ok, false)
    assert.equal(plan.takenBy.id, 's')
  })

  test('a saved list may keep its own title as it is tracked', () => {
    const saved = recordOf(entry('s', TEA, { alias: 'Morning', type: 'search', entity: 'tea' }))
    const plan = planTrackSearch(current([], [saved]), query, 'Morning', TODAY)
    assert.equal(plan.ok, true)
    assert.equal(plan.state.tracked.lists[0].alias, 'Morning')
  })
})

describe('planTrackCopy', () => {
  const stored = copy('text-search', 'work_search[query]=tea', { listUrl: `${AO3}${TEA}&page=1`, label: 'Search: tea' })

  test('the saved list a copy is, tracked under its own id and title', () => {
    const saved = recordOf(entry('s', TEA, { alias: 'Morning', type: 'search', entity: 'tea', scan: true }))
    const plan = planTrackCopy(current([], [saved]), stored, TODAY)
    assert.equal(plan.id, 's')
    assert.deepEqual(plan.state.saved.lists, { s: saved })
    assert.deepEqual(plan.state.tracked.lists, [{ id: 's', kind: 'text-search', url: TEA, alias: 'Morning', type: 'search', entity: 'tea', scan: true, tracked: true, since: TODAY }])
  })

  test('untitled, it takes the search\'s default, made unique', () => {
    const auto = { id: 'auto', kind: 'text-search', url: TEA, title: '', type: 'search', entity: 'tea' }
    const taken = recordOf(entry('x', TAG, { alias: 'Search: tea' }))
    const plan = planTrackCopy(current([], [auto, taken]), stored, TODAY)
    assert.equal(plan.id, 'auto')
    assert.equal(plan.state.saved.lists.auto.title, 'Search: tea (2)')
    assert.equal(plan.state.tracked.lists[0].alias, 'Search: tea (2)')
  })

  test('a copy no record has yet gets one, as the planner would make it, under the default title', () => {
    const series = copy('series-works', '123', { listUrl: `${AO3}${SERIES}`, label: 'Series: The Long Way Round' })
    const plan = planTrackCopy(current([], []), series, TODAY)
    assert.deepEqual(plan.state.saved.lists[plan.id], { id: plan.id, kind: 'series-works', url: SERIES, title: 'Series: The Long Way Round', type: 'series', entity: 'The Long Way Round' })
    assert.equal(plan.state.tracked.lists[0].since, TODAY)
  })

  test('refuses a copy whose search another list tracks', () => {
    const twin = entry('twin', TEA, { alias: 'Tea' })
    assert.equal(planTrackCopy(current([twin], [recordOf(twin)]), stored, TODAY).twin.id, 'twin')
  })

  test('a copy that isn\'t a saved list\'s search is nothing to track', () => {
    for (const other of [
      { key: 'tag-works:old', scrapedAt: 1 },
      copy('marked-for-later', 'me', { listUrl: `${AO3}/users/me/readings?show=to-read` }),
      copy('text-search', 'nowhere', { listUrl: BROKEN }),
    ])
      assert.equal(planTrackCopy(current([], []), other, TODAY), null, other.key)
  })
})
