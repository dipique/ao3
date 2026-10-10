import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { addressOf, aliasOf, copyOwner, createSavedListsReconciler, FILTERED_LISTING_SOURCE_ID, filteredListing, joinSavedLists, listCopies, moveKeys, planDateFilterSplit, planLetGo, planListingRefile, planRemoveList, planRetitle, planSaveBack, planSavedLists, planStopTracking, planTrack, planTrackCopy, planTrackSearch, planUndoSaveBack, savedListAt, savedListsOf, savedListsWrite, splitDateFilter, storedListRefs } from '../../src/common/savedLists.ts'
import { normalizeTrackedUrl, refineLink, sameReading, trackedKey, withDateFilter } from '../../src/common/trackedLists.ts'

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

describe('filteredListing', () => {
  const BEES = '/tags/Bees/works'

  test('a filtered listing\'s copy is keyed by its source and address, which its saved list joins it by', () => {
    const listing = filteredListing(`${AO3}${BEES}`)
    assert.deepEqual(listing, { key: 'works-filter:/tags/Bees/works', url: BEES, label: 'Tag: Bees' })
    assert.equal(listing.key, addressOf(listing.url))
    assert.equal(listing.key.startsWith(`${FILTERED_LISTING_SOURCE_ID}:`), true)
  })

  test('the listing in either spelling, in any sort and on any page, is one copy; its own URL keeps its sort', () => {
    const spellings = [
      `${AO3}${BEES}`,
      `${AO3}${BEES}?page=3`,
      `${AO3}${BEES}?work_search[sort_column]=title`,
      `${AO3}/works?utf8=%E2%9C%93&work_search[sort_column]=kudos_count&work_search[other_tag_names]=&tag_id=Bees&commit=Sort+and+Filter&page=2`,
    ]
    for (const href of spellings)
      assert.equal(filteredListing(href).key, 'works-filter:/tags/Bees/works', href)
    assert.equal(filteredListing(spellings[2]).url, `${BEES}?work_search[sort_column]=title`)
    assert.equal(filteredListing(spellings[3]).url, '/works?work_search[sort_column]=kudos_count&tag_id=Bees')
  })

  test('its own URL is the whole listing\'s, as its saved list\'s is: the page\'s Date Updated bounds are kept apart, so its copy says which read it is', () => {
    const bounded = `${AO3}/works?work_search[date_from]=2026-01-01&work_search[sort_column]=title&work_search[date_to]=2026-02-01&tag_id=Bees&page=2`
    const listing = filteredListing(bounded)
    assert.deepEqual(listing, {
      key: 'works-filter:/tags/Bees/works',
      url: '/works?work_search[sort_column]=title&tag_id=Bees',
      dateFilter: 'work_search[date_from]=2026-01-01&work_search[date_to]=2026-02-01',
      label: 'Tag: Bees',
    })
    assert.equal(listing.url, normalizeTrackedUrl(bounded).url, 'the URL a list made from the page keeps')
    assert.equal(sameReading(withDateFilter(`${AO3}${listing.url}`, listing.dateFilter), bounded), true, 'the two together are the read')
  })

  test('the relative date bound stays in its URL, as a saved list\'s URL keeps it, and is no date filter kept apart', () => {
    const recent = `${AO3}/tags/Bees/works?work_search[revised_at]=%3C+2+weeks`
    assert.deepEqual(filteredListing(recent), { key: 'works-filter:/tags/Bees/works', url: '/tags/Bees/works?work_search[revised_at]=%3C+2+weeks', label: 'Tag: Bees' })
    assert.equal(filteredListing(recent).url, normalizeTrackedUrl(recent).url)
  })

  test('what a listing is filtered by makes it another listing, with a copy of its own', () => {
    assert.equal(filteredListing(`${AO3}${HP_COMPLETE}`).key, addressOf(HP_COMPLETE))
    assert.notEqual(filteredListing(`${AO3}${HP_COMPLETE}`).key, filteredListing(`${AO3}${HP}`).key)
  })

  test('an author\'s, a pseud\'s and a collection\'s listings are filtered listings, each named for its owner', () => {
    assert.deepEqual(filteredListing(`${AO3}/users/someone/works`), { key: 'works-filter:/users/someone/works', url: '/users/someone/works', label: 'Author: someone' })
    assert.equal(filteredListing(`${AO3}/users/someone/pseuds/Grace%20Notes/works`).key, 'works-filter:/users/someone/pseuds/Grace%20Notes/works')
    assert.equal(filteredListing(`${AO3}/collections/SomeFest2026/works`).label, 'Collection: SomeFest2026')
  })

  test('no other page is one', () => {
    for (const href of [`${AO3}${TAG}`, `${AO3}${SERIES}`, `${AO3}${TEA}`, `${AO3}/works`, `${AO3}/users/me/readings?show=to-read`, `${AO3}/tags/Bees/bookmarks`, BROKEN, ''])
      assert.equal(filteredListing(href), null, href)
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

  test('a paused entry with no title gets its search\'s default title', () => {
    const paused = entry('p4', TEA, { alias: '', tracked: false })
    const { state } = settle(stateOf([paused]))
    assert.deepEqual(state.tracked.lists, [])
    assert.equal(state.saved.lists.p4.title, 'Search: tea')
  })

  test('a tracked entry with no title takes its default, and so does its record: the title syncs', () => {
    const blank = entry('t4', TAG, { alias: '', type: 'freeform', entity: 'marriage problems' })
    const missing = entry('t5', SERIES, { alias: undefined })
    const { state, changed } = settle(stateOf([blank, missing]))
    assert.deepEqual(changed, { tracked: true, saved: true })
    assert.deepEqual(state.tracked.lists, [{ ...blank, alias: 'Tag: marriage problems' }, { ...missing, alias: 'Series: 123' }])
    assert.deepEqual(state.saved.lists, { t4: recordOf(state.tracked.lists[0]), t5: recordOf(state.tracked.lists[1]) })
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

  test('a stored list with no entry gets a new record under its search\'s default title, described from its descriptor', () => {
    const tracked = entry('t1', TEA)
    const stored = [
      copy('text-search', 'work_search[query]=coffee+shop', { listUrl: `${AO3}${COFFEE}&page=1`, label: 'Search: coffee shop' }),
      copy('tag-works', 'marriage%20problems', { listUrl: `${AO3}${TAG}`, label: 'Tag: marriage problems' }),
      copy('series-works', '123', { listUrl: `${AO3}${SERIES}`, label: 'Series: The Long Way Round' }),
      copy('works-filter', '/tags/Bees/works?work_search[complete]=T', { listUrl: `${AO3}/works?work_search[sort_column]=title&work_search[complete]=T&tag_id=Bees`, label: 'Tag: Bees' }),
    ]
    const { state } = settle(stateOf([tracked]), stored)

    const made = records(state).filter(record => record.id !== 't1')
    const byKind = Object.fromEntries(made.map(({ id, ...record }) => [record.kind, record]))
    assert.deepEqual(byKind, {
      'text-search': { kind: 'text-search', url: COFFEE, title: 'Search: coffee shop', type: 'search', entity: 'coffee shop' },
      'tag-works': { kind: 'tag-works', url: TAG, title: 'Tag: marriage problems', type: 'tag', entity: 'marriage problems' },
      'series-works': { kind: 'series-works', url: SERIES, title: 'Series: The Long Way Round', type: 'series', entity: 'The Long Way Round' },
      'works-filter': { kind: 'works-filter', url: '/works?work_search[sort_column]=title&work_search[complete]=T&tag_id=Bees', title: 'Tag: Bees', type: 'tag', entity: 'Bees' },
    })
    const ids = records(state).map(record => record.id)
    assert.equal(new Set(ids).size, 5, 'every id is new, and none is an entry\'s')
    for (const record of made)
      assert.equal(state.saved.lists[record.id], record, 'filed under its own id')
  })

  test('two searches with one default title both take it: none is numbered or renamed', () => {
    const stored = [
      copy('text-search', 'tea', { listUrl: `${AO3}${TEA}` }),
      copy('text-search', 'tea-complete', { listUrl: `${AO3}${TEA}&work_search[complete]=T` }),
    ]
    const { state } = settle(stateOf([]), stored)
    assert.deepEqual(records(state).map(record => record.title), ['Search: tea', 'Search: tea'])
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

  test('a record with no title takes its default; one whose address gives none keeps none', () => {
    const blank = { id: 'b', kind: 'text-search', url: TEA, title: '', type: 'search', entity: 'tea' }
    const lone = recordOf(entry('lone', BROKEN, { kind: 'tag-works', alias: '' }))
    const { state, changed } = settle(current([], [blank, lone]))
    assert.deepEqual(changed, { tracked: false, saved: true })
    assert.deepEqual(state.saved.lists, { b: { ...blank, title: 'Search: tea' }, lone })
  })

  test('an untitled entry from another browser takes its default here too, and it syncs back', () => {
    const arrived = entry('new', TEA, { alias: '  ' })
    const { state, changed } = settle(current([arrived], []))
    assert.deepEqual(changed, { tracked: true, saved: true })
    assert.deepEqual(state.tracked.lists, [{ ...arrived, alias: 'Search: tea' }])
    assert.deepEqual(state.saved.lists, { new: recordOf(state.tracked.lists[0], { mirror: true }) })
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

  test('a blank title is the list\'s default, refused like any other when another list has it', () => {
    assert.equal(planRetitle(current([], [saved]), 's', '  ').state.saved.lists.s.title, 'Search: tea')
    const other = recordOf(entry('o', `${TEA}&work_search[complete]=T`, { alias: 'Search: tea' }))
    assert.equal(planRetitle(current([], [saved, other]), 's', '').takenBy.id, 'o')
  })

  test('a list whose address gives no default title may be left without one', () => {
    const lone = recordOf(entry('lone', BROKEN, { kind: 'tag-works', alias: 'Elsewhere' }))
    assert.equal(planRetitle(current([], [lone]), 'lone', ' ').state.saved.lists.lone.title, '')
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

  test('a list with no title yet is tracked under its default, and its record takes it', () => {
    const blank = { id: 'b', kind: 'tag-works', url: TAG, title: '', type: 'freeform', entity: 'marriage problems' }
    const plan = planTrack(current([], [blank]), 'b', TODAY)
    assert.equal(plan.state.tracked.lists[0].alias, 'Tag: marriage problems')
    assert.equal(plan.state.saved.lists.b.title, 'Tag: marriage problems')
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

describe('createSavedListsReconciler', () => {
  /** Storage as the reconciler sees it, logging each read and write. */
  function storage({ tracked, saved, searchLists = {} }, { failWrites = 0 } = {}) {
    const log = []
    let held = { trackedLists: tracked, savedLists: saved, searchLists }
    return {
      log,
      get held() { return held },
      async read() {
        log.push('read')
        await new Promise(resolve => setTimeout(resolve, 5))
        return structuredClone(held)
      },
      async write(update) {
        await new Promise(resolve => setTimeout(resolve, 5))
        if (failWrites-- > 0)
          throw new Error('quota')
        log.push(`write ${Object.keys(update).sort().join(' ')}`)
        held = { ...held, ...structuredClone(update) }
      },
    }
  }

  const legacy = () => stateOf([entry('t', TEA), entry('p', COFFEE, { alias: 'Coffee', tracked: false })])

  test('migrates a legacy state in one write of both halves, and a run after it writes nothing', async () => {
    const store = storage(legacy())
    const reconcile = createSavedListsReconciler(store)
    await reconcile()
    assert.deepEqual(store.log, ['read', 'write savedLists trackedLists'])
    assert.deepEqual(store.held.trackedLists.lists.map(one => one.id), ['t'])
    assert.deepEqual(store.held.savedLists, { v: 1, lists: { t: recordOf(entry('t', TEA)), p: recordOf(entry('p', COFFEE, { alias: 'Coffee' })) } })
    await reconcile()
    assert.deepEqual(store.log, ['read', 'write savedLists trackedLists', 'read'])
  })

  test('one run at a time: a run asked for during another reads what that one wrote', async () => {
    const store = storage(legacy())
    const reconcile = createSavedListsReconciler(store)
    await Promise.all([reconcile(), reconcile()])
    assert.deepEqual(store.log, ['read', 'write savedLists trackedLists', 'read'])
  })

  test('a run that fails is reported, and the next runs all the same', async () => {
    const store = storage(legacy(), { failWrites: 1 })
    const reconcile = createSavedListsReconciler(store)
    const [first, second] = await Promise.allSettled([reconcile(), reconcile()])
    assert.equal(first.status, 'rejected')
    assert.equal(second.status, 'fulfilled')
    assert.deepEqual(store.log, ['read', 'read', 'write savedLists trackedLists'])
  })

  test('the stored lists are read as storage holds them', async () => {
    const store = storage({ ...current([], []), searchLists: { 'text-search:tea': { v: 3, scrapedAt: 1, ids: '', descriptor: { sourceId: 'text-search', label: 'Search: tea', listUrl: `${AO3}${TEA}` } } } })
    await createSavedListsReconciler(store)()
    assert.deepEqual(Object.values(store.held.savedLists.lists).map(({ id, ...rest }) => rest), [{ kind: 'text-search', url: TEA, title: 'Search: tea', type: 'search', entity: 'tea' }])
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

  test('keeps the copies while a list the planner has yet to file still has the address', () => {
    const sharing = entry('s', COFFEE_BY_KUDOS, { alias: 'Same search', filter: SLOW_BURN })
    const plan = planRemoveList(current([tracked, sharing], [recordOf(tracked)]), 't', [older, newer])
    assert.deepEqual(plan.state.tracked.lists, [sharing])
    assert.deepEqual(plan.dropCopies, [], 'the copies are that list\'s too')
    assert.deepEqual(joinSavedLists(plan.state, [older, newer]).lists.find(one => one.list.id === 's').copy, newer)
  })
})

describe('listCopies', () => {
  const tracked = entry('t', COFFEE, { alias: 'Coffee' })
  const older = copy('text-search', 'by-date', { listUrl: `${AO3}${COFFEE}`, scrapedAt: 1_000 })
  const newer = copy('text-search', 'by-kudos', { listUrl: `${AO3}${COFFEE_BY_KUDOS}`, scrapedAt: 2_000 })
  const tea = copy('text-search', 'tea', { listUrl: `${AO3}${TEA}` })

  test('every copy at the list\'s address, newest first: the one its row shows, and any older sort order of its search', () => {
    assert.deepEqual(listCopies(current([tracked], [recordOf(tracked)]), 't', [older, tea, newer]), [newer.key, older.key])
    const left = without([older, tea, newer], listCopies(current([tracked], [recordOf(tracked)]), 't', [older, tea, newer]))
    assert.equal(joinSavedLists(current([tracked], [recordOf(tracked)]), left).lists[0].copy, null, 'so the list has no copy left')
  })

  test('a copy another list at the address shares is the list\'s too', () => {
    const sharing = recordOf(entry('s', COFFEE_BY_KUDOS, { alias: 'Same search', filter: SLOW_BURN }))
    assert.deepEqual(listCopies(current([tracked], [recordOf(tracked), sharing]), 's', [older, newer]), [newer.key, older.key])
  })

  test('an entry the planner has yet to file has its copies', () => {
    assert.deepEqual(listCopies(current([tracked], []), 't', [older, newer]), [newer.key, older.key])
  })

  test('none for a list with no copy, one at no address on the archive, or one that is gone', () => {
    assert.deepEqual(listCopies(current([], [recordOf(entry('o', TEA))]), 'o', [older, newer]), [])
    assert.deepEqual(listCopies(current([], [recordOf(entry('b', BROKEN))]), 'b', [older, copy('tag-works', 'x', { listUrl: BROKEN })]), [])
    assert.deepEqual(listCopies(current([], []), 'gone', [older, newer]), [])
  })
})

describe('planSaveBack', () => {
  const meta = { type: 'search', entity: 'tea' }
  const coffee = recordOf(entry('c', COFFEE, { alias: 'Coffee', type: 'search', entity: 'coffee shop' }))
  const oldCopy = copy('text-search', 'coffee', { listUrl: `${AO3}${COFFEE}` })
  const newCopy = copy('text-search', 'tea', { listUrl: `${AO3}${TEA}`, scrapedAt: 3_000 })
  const autoRecord = { id: 'auto', kind: 'text-search', url: TEA, title: 'Search: tea', type: 'search', entity: 'tea' }

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

  test('absorbs the record made for the new address: untracked, unfiltered, under its default title', () => {
    for (const made of [autoRecord, { ...autoRecord, title: '' }]) {
      const plan = planSaveBack(current([], [coffee, made]), 'c', { url: TEA, kind: 'text-search', meta }, [oldCopy, newCopy])
      assert.deepEqual(plan.absorbed, made)
      assert.deepEqual(Object.keys(plan.state.saved.lists), ['c'])
    }
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

  test('a tracked list whose view filter is dropped is the unfiltered list\'s twin', () => {
    const filtered = entry('c', TEA, { alias: 'Tea, slowly', filter: SLOW_BURN })
    const plain = entry('tea', TEA, { alias: 'Tea' })
    const plan = planSaveBack(current([filtered, plain], [recordOf(filtered), recordOf(plain)]), 'c', { url: TEA, kind: 'text-search', meta }, [])
    assert.equal(plan.ok, false)
    assert.equal(plan.reason, 'duplicate')
    assert.equal(plan.other.id, 'tea')
  })

  test('a title the list already has is never refused, even one sync has doubled up', () => {
    const namesake = recordOf(entry('o', TAG, { alias: 'COFFEE' }))
    for (const title of [undefined, ' Coffee ']) {
      const plan = planSaveBack(current([], [coffee, namesake]), 'c', { url: TEA, kind: 'text-search', meta, title }, [])
      assert.equal(plan.ok, true, String(title))
      assert.equal(plan.state.saved.lists.c.title, 'Coffee')
    }
  })

  test('nothing to save back, or nothing to save it as', () => {
    assert.deepEqual(planSaveBack(current([], [coffee]), 'gone', { url: TEA, kind: 'text-search', meta }, []), { ok: false, reason: 'missing' })
    assert.deepEqual(planSaveBack(current([], [coffee]), 'c', { url: BROKEN, kind: 'tag-works', meta }, []), { ok: false, reason: 'invalid' })
    assert.deepEqual(planSaveBack(current([], [coffee]), 'c', { url: TEA, kind: 'tag-works', meta }, []), { ok: false, reason: 'invalid' })
  })

  test('a list adopted from another browser and saved back here stays saved when its tracking stops there', () => {
    const adopted = entry('c', COFFEE, { alias: 'Coffee', type: 'search', entity: 'coffee shop' })
    const plan = planSaveBack(current([adopted], [recordOf(adopted, { mirror: true })]), 'c', { url: TEA, kind: 'text-search', meta }, [])
    const { state } = settle({ ...plan.state, tracked: { ...plan.state.tracked, lists: [] } })
    assert.deepEqual(state.saved.lists.c, recordOf(plan.state.tracked.lists[0]))
  })

  test('a tracked entry the planner has yet to give a record is saved back all the same, and gets its record', () => {
    const tracked = entry('c', COFFEE, { alias: 'Coffee', type: 'search', entity: 'coffee shop', since: DAY - 30 })
    const plan = planSaveBack(current([tracked], []), 'c', { url: TEA, kind: 'text-search', meta }, [oldCopy])
    assert.equal(plan.ok, true)
    assert.deepEqual(plan.state.tracked.lists, [{ ...tracked, url: TEA, entity: 'tea' }])
    assert.deepEqual(plan.state.saved.lists, { c: recordOf(plan.state.tracked.lists[0]) })
    assert.deepEqual(plan.dropCopies, [oldCopy.key])
  })

  test('a title a list the planner has yet to file has is taken', () => {
    const unfiled = entry('o', TAG, { alias: 'Teatime' })
    const plan = planSaveBack(current([unfiled], [coffee]), 'c', { url: TEA, kind: 'text-search', meta, title: 'TEATIME' }, [])
    assert.equal(plan.ok, false)
    assert.equal(plan.reason, 'title')
    assert.equal(plan.other.id, 'o')
  })

  test('keeps the old copies while a list the planner has yet to file still has the old address', () => {
    const sharing = entry('s', COFFEE_BY_KUDOS, { alias: 'Same search', filter: SLOW_BURN })
    const moved = planSaveBack(current([sharing], [coffee]), 'c', { url: TEA, kind: 'text-search', meta }, [oldCopy])
    assert.deepEqual(moved.dropCopies, [], 'the copy is that list\'s too')
    assert.deepEqual(joinSavedLists(moved.state, [oldCopy]).lists.find(one => one.list.id === 's').copy, oldCopy)
  })
})

describe('refineLink, for a saved list', () => {
  test('every record with an address links to its page, marked with its id, tracked or not', () => {
    const saved = { id: 'l4tte', kind: 'text-search', url: TEA, title: 'Latte' }
    assert.equal(refineLink(saved), `${TEA}#ao3e-list=l4tte`)
    const tracked = recordOf(entry('hp', HP, { alias: 'Harry Potter' }))
    assert.equal(refineLink(tracked), `${HP}#ao3e-list=hp`)
  })

  test('a record whose address isn\'t a page of its kind on the archive has none', () => {
    assert.equal(refineLink({ id: 'b', kind: 'tag-works', url: BROKEN, title: 'Broken' }), null)
    assert.equal(refineLink({ id: 'k', kind: 'series-works', url: TEA, title: 'Wrong kind' }), null)
  })
})

describe('planUndoSaveBack', () => {
  const meta = { type: 'search', entity: 'tea' }
  const coffee = recordOf(entry('c', COFFEE, { alias: 'Coffee', type: 'search', entity: 'coffee shop' }))
  const autoRecord = { id: 'auto', kind: 'text-search', url: TEA, title: 'Search: tea', type: 'search', entity: 'tea' }
  const oldCopy = copy('text-search', 'coffee', { listUrl: `${AO3}${COFFEE}` })
  const byKudos = copy('text-search', 'coffee-by-kudos', { listUrl: `${AO3}${COFFEE_BY_KUDOS}`, scrapedAt: 2_000 })
  const newCopy = copy('text-search', 'tea', { listUrl: `${AO3}${TEA}`, scrapedAt: 3_000 })

  /** Save list `c` back to the tea search, as the toolbar does: what it changed, for its undo. */
  function saveBack(before, page = {}, stored = []) {
    const plan = planSaveBack(before, 'c', { url: TEA, kind: 'text-search', meta, ...page }, stored)
    assert.equal(plan.ok, true)
    return { done: { id: 'c', before, after: deepFreeze(plan.state), absorbed: plan.absorbed }, dropCopies: plan.dropCopies }
  }

  test('puts a saved list\'s record back, and the record its save-back absorbed, and touches nothing that syncs', () => {
    const before = current([], [coffee, autoRecord])
    const { done } = saveBack(before)
    const plan = planUndoSaveBack(done.after, done)
    assert.equal(plan.ok, true)
    assert.deepEqual(plan.state.saved.lists, before.saved.lists)
    assert.equal(plan.state.tracked, done.after.tracked)
  })

  test('puts a tracked list\'s entry back as it was, tracking start and all, and its record with it as this browser\'s own', () => {
    const tracked = entry('c', COFFEE, { alias: 'Coffee', type: 'search', entity: 'coffee shop', since: DAY - 30 })
    const { done } = saveBack(current([tracked], [recordOf(tracked, { mirror: true })]))
    const plan = planUndoSaveBack(done.after, done)
    assert.deepEqual(plan.state.tracked.lists, [tracked])
    assert.deepEqual(plan.state.saved.lists, { c: recordOf(tracked) })
    assert.equal(settle(plan.state).changed.saved, false, 'the planner finds the two in step')
  })

  test('a tracked entry that had no record keeps the one its save-back gave it, as the entry was', () => {
    const tracked = entry('c', COFFEE, { alias: 'Coffee', type: 'search', entity: 'coffee shop' })
    const { done } = saveBack(current([tracked], []))
    assert.deepEqual(planUndoSaveBack(done.after, done).state.saved.lists, { c: recordOf(tracked) })
  })

  test('takes back a title change with the rest', () => {
    const { done } = saveBack(current([], [coffee]), { title: 'Teatime' })
    assert.equal(done.after.saved.lists.c.title, 'Teatime')
    assert.equal(planUndoSaveBack(done.after, done).state.saved.lists.c.title, 'Coffee')
  })

  test('with the copies it dropped put back, they are the list\'s again: the planner makes no list of them', () => {
    const stored = [oldCopy, byKudos, newCopy]
    const { done, dropCopies } = saveBack(current([], [coffee, autoRecord]), {}, stored)
    assert.deepEqual(dropCopies, [byKudos.key, oldCopy.key])
    assert.deepEqual(planSavedLists(done.after, without(stored, dropCopies)).changed, { tracked: false, saved: false }, 'nothing is left at the old address')
    const plan = planUndoSaveBack(done.after, done)
    assert.deepEqual(planSavedLists(plan.state, stored).changed, { tracked: false, saved: false })
  })

  test('the record and entry as storage hands them back, keys in another order, are still the same', () => {
    const tracked = entry('c', COFFEE, { alias: 'Coffee', type: 'search', entity: 'coffee shop' })
    const { done } = saveBack(current([tracked], [recordOf(tracked)]))
    const reordered = value => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(value).reverse())))
    const stored = {
      tracked: { ...done.after.tracked, lists: done.after.tracked.lists.map(reordered) },
      saved: { ...done.after.saved, lists: { c: reordered(done.after.saved.lists.c) } },
    }
    assert.equal(planUndoSaveBack(stored, done).ok, true)
  })

  test('refuses once the list is gone', () => {
    const { done } = saveBack(current([], [coffee]))
    assert.deepEqual(planUndoSaveBack(planRemoveList(done.after, 'c', []).state, done), { ok: false, reason: 'missing' })
  })

  test('refuses once the list has changed since: retitled, saved back again, tracked or stopped', () => {
    const { done } = saveBack(current([], [coffee]))
    const retitled = planRetitle(done.after, 'c', 'Tea, now').state
    const again = planSaveBack(done.after, 'c', { url: COFFEE_BY_KUDOS, kind: 'text-search', meta, filter: SLOW_BURN }, []).state
    const nowTracked = planTrack(done.after, 'c', TODAY).state
    for (const state of [retitled, again, nowTracked])
      assert.deepEqual(planUndoSaveBack(state, done), { ok: false, reason: 'changed' })

    const tracked = entry('c', COFFEE, { alias: 'Coffee', type: 'search', entity: 'coffee shop' })
    const { done: trackedDone } = saveBack(current([tracked], [recordOf(tracked)]))
    assert.deepEqual(planUndoSaveBack(planStopTracking(trackedDone.after, 'c'), trackedDone), { ok: false, reason: 'changed' })
  })

  test('refuses to make a tracked list another tracked list\'s twin, and says which', () => {
    const tracked = entry('c', COFFEE, { alias: 'Coffee', type: 'search', entity: 'coffee shop' })
    const { done } = saveBack(current([tracked], [recordOf(tracked)]))
    const twin = entry('n', COFFEE, { alias: 'New coffee' })
    const state = { ...done.after, tracked: { ...done.after.tracked, lists: [...done.after.tracked.lists, twin] } }
    const plan = planUndoSaveBack(state, done)
    assert.equal(plan.ok, false)
    assert.equal(plan.reason, 'duplicate')
    assert.equal(plan.other.id, 'n')
  })

  test('refuses a title another list has taken since, and says which', () => {
    const { done } = saveBack(current([], [coffee]), { title: 'Teatime' })
    const taker = recordOf(entry('o', TAG, { alias: 'COFFEE' }))
    const state = { ...done.after, saved: { ...done.after.saved, lists: { ...done.after.saved.lists, o: taker } } }
    const plan = planUndoSaveBack(state, done)
    assert.equal(plan.ok, false)
    assert.equal(plan.reason, 'title')
    assert.equal(plan.other.id, 'o')
  })

  test('an absorbed record whose id is taken again is left as it is', () => {
    const { done } = saveBack(current([], [coffee, autoRecord]))
    const since = { ...autoRecord, url: TAG, title: 'Tag: marriage problems' }
    const state = { ...done.after, saved: { ...done.after.saved, lists: { ...done.after.saved.lists, auto: since } } }
    assert.deepEqual(planUndoSaveBack(state, done).state.saved.lists.auto, since)
  })
})

describe('planLetGo', () => {
  const meta = { type: 'search', entity: 'tea' }
  const coffee = recordOf(entry('c', COFFEE, { alias: 'Coffee', type: 'search', entity: 'coffee shop' }))
  const oldCopy = copy('text-search', 'coffee', { listUrl: `${AO3}${COFFEE}` })
  const byKudos = copy('text-search', 'coffee-by-kudos', { listUrl: `${AO3}${COFFEE_BY_KUDOS}`, scrapedAt: 2_000 })
  const newCopy = copy('text-search', 'tea', { listUrl: `${AO3}${TEA}`, scrapedAt: 3_000 })
  const BOTH = [byKudos.key, oldCopy.key]

  /**
   * List `c` saved back from the coffee search to the tea one, as the toolbar
   * does it: the lists as it left them, the copies it set aside, and what is
   * still stored.
   */
  function savedBack(lists = [], records = [coffee]) {
    const stored = deepFreeze([oldCopy, byKudos, newCopy])
    const plan = planSaveBack(current(lists, records), 'c', { url: TEA, kind: 'text-search', meta }, stored)
    assert.equal(plan.ok, true)
    assert.deepEqual(plan.dropCopies, BOTH)
    return { state: deepFreeze(plan.state), setAside: plan.dropCopies.map(key => stored.find(one => one.key === key)), stored: without(stored, plan.dropCopies) }
  }

  const withEntries = (state, lists) => ({ ...state, tracked: { ...state.tracked, lists } })
  const withRecords = (state, ...more) => ({ ...state, saved: { ...state.saved, lists: { ...state.saved.lists, ...Object.fromEntries(more.map(one => [one.id, one])) } } })

  test('with no list at their address since, every copy set aside goes', () => {
    const { state, setAside, stored } = savedBack()
    assert.deepEqual(planLetGo(state, setAside, stored), { restore: [], prune: BOTH })
  })

  test('a sync that put the list itself back there keeps them all, before the planner mirrors its entry and after', () => {
    const tracked = entry('c', COFFEE, { alias: 'Coffee', type: 'search', entity: 'coffee shop' })
    const { state, setAside, stored } = savedBack([tracked], [recordOf(tracked)])
    const pulled = withEntries(state, [tracked])
    assert.deepEqual(planLetGo(pulled, setAside, stored), { restore: BOTH, prune: [] })
    assert.deepEqual(planLetGo(settle(pulled, stored).state, setAside, stored), { restore: BOTH, prune: [] })
  })

  test('a sync that brought another list there keeps them, filed or not', () => {
    const { state, setAside, stored } = savedBack()
    const arrived = entry('n', COFFEE_BY_KUDOS, { alias: 'Their coffee' })
    const pulled = withEntries(state, [arrived])
    assert.deepEqual(planLetGo(pulled, setAside, stored), { restore: BOTH, prune: [] })
    assert.deepEqual(planLetGo(settle(pulled, stored).state, setAside, stored), { restore: BOTH, prune: [] })
  })

  test('another tab tracking the old search keeps them', () => {
    const { state, setAside, stored } = savedBack()
    const tracked = planTrackSearch(state, { kind: 'text-search', url: COFFEE, type: 'search', entity: 'coffee shop' }, '', TODAY)
    assert.equal(tracked.ok, true)
    assert.deepEqual(planLetGo(tracked.state, setAside, stored), { restore: BOTH, prune: [] })
  })

  test('another tab opening the old search keeps them: the copy it stored, before the planner files it, and the record after', () => {
    const { state, setAside, stored } = savedBack()
    const opened = [...stored, copy('text-search', 'coffee-again', { listUrl: `${AO3}${COFFEE}`, scrapedAt: 4_000 })]
    assert.deepEqual(planLetGo(state, setAside, opened), { restore: BOTH, prune: [] })
    assert.deepEqual(planLetGo(settle(state, opened).state, setAside, opened), { restore: BOTH, prune: [] })
  })

  test('a list or copy at another address keeps nothing, and neither does a copy no saved list is made from', () => {
    const { state, setAside, stored } = savedBack()
    const elsewhere = withRecords(state, recordOf(entry('o', TAG, { alias: 'Marriage' })))
    const profile = copy('marked-for-later', 'reader', { listUrl: `${AO3}${COFFEE}` })
    assert.deepEqual(planLetGo(elsewhere, setAside, [...stored, profile]), { restore: [], prune: BOTH })
  })

  test('put back, they are a list\'s copies again: the planner makes no list of them', () => {
    const { state, setAside, stored } = savedBack()
    const arrived = settle(withEntries(state, [entry('n', COFFEE, { alias: 'Their coffee' })]), stored).state
    const { restore } = planLetGo(arrived, setAside, stored)
    const back = [...stored, ...setAside.filter(one => restore.includes(one.key))]
    assert.deepEqual(planSavedLists(arrived, back).changed, { tracked: false, saved: false })
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

describe('joinSavedLists', () => {
  const byKudos = copy('text-search', 'by-kudos', { listUrl: `${AO3}${COFFEE_BY_KUDOS}`, scrapedAt: 2_000 })
  const byDate = copy('text-search', 'by-date', { listUrl: `${AO3}${COFFEE}`, scrapedAt: 1_000 })
  const marked = user => copy('marked-for-later', user, { listUrl: `${AO3}/users/${user}/readings?show=to-read` })
  const read = user => copy('read-works', user, { listUrl: `${AO3}/users/${user}/readings` })
  const review = copy('tracked-review', 'window', { key: 'tracked-review', listUrl: `${AO3}/users/me/readings#ao3e-tracked` })

  /** Each list's id, and the key of the copy it claims. */
  const claims = join => join.lists.map(one => [one.list.id, one.copy?.key ?? null])

  test('a list claims the newest copy at its address; the older sort orders are its too, and no rows', () => {
    const saved = recordOf(entry('s', COFFEE, { alias: 'Coffee' }))
    const join = joinSavedLists(current([], [saved]), [byDate, byKudos])
    assert.deepEqual(join.lists, [{ list: saved, entry: null, address: addressOf(COFFEE), copy: byKudos, copyKeys: [byKudos.key, byDate.key], sameAddress: [] }])
    assert.deepEqual(join.copies, [])
  })

  test('a tracked list with a view filter claims the copy of its page: its address leaves the filter out', () => {
    const filtered = entry('t', COFFEE, { alias: 'Coffee, slow', filter: SLOW_BURN })
    const join = joinSavedLists(current([filtered], [recordOf(filtered)]), [byKudos])
    assert.deepEqual(join.lists, [{ list: recordOf(filtered), entry: filtered, address: addressOf(COFFEE), copy: byKudos, copyKeys: [byKudos.key], sameAddress: [] }])
    assert.deepEqual(join.copies, [])
  })

  test('two lists at one address share its copy, and each names the other', () => {
    const tracked = entry('t', COFFEE, { alias: 'Theirs' })
    const saved = recordOf(entry('s', COFFEE_BY_KUDOS, { alias: 'Mine', filter: NO_DRACO }))
    const alone = recordOf(entry('a', TEA, { alias: 'Tea' }))
    const join = joinSavedLists(current([tracked], [recordOf(tracked), saved, alone]), [byKudos])
    assert.deepEqual(claims(join), [['t', byKudos.key], ['s', byKudos.key], ['a', null]])
    assert.deepEqual(join.lists.map(one => one.sameAddress), [['s'], ['t'], []])
    assert.deepEqual(join.lists.map(one => one.copyKeys), [[byKudos.key], [byKudos.key], []])
  })

  test('a list at no address on the archive claims nothing, and shares with nothing', () => {
    const broken = recordOf(entry('b', BROKEN, { kind: 'tag-works' }))
    const alsoBroken = recordOf(entry('c', BROKEN, { kind: 'tag-works' }))
    const join = joinSavedLists(current([], [broken, alsoBroken]), [copy('tag-works', 'x', { listUrl: BROKEN })])
    assert.deepEqual(join.lists.map(({ address, copy, copyKeys, sameAddress }) => ({ address, copy, copyKeys, sameAddress })), [
      { address: null, copy: null, copyKeys: [], sameAddress: [] },
      { address: null, copy: null, copyKeys: [], sameAddress: [] },
    ])
  })

  test('an entry with no record yet is a list all the same', () => {
    const tracked = entry('t', COFFEE, { alias: 'Coffee' })
    assert.deepEqual(claims(joinSavedLists(current([tracked], []), [byKudos])), [['t', byKudos.key]])
  })

  test('a copy no list claims is a row of its own: undescribed, at no archive address, or not yet given its record', () => {
    const undescribed = { key: 'text-search:work_search%5Bquery%5D=coffee+shop', scrapedAt: 3_000 }
    const nowhere = copy('text-search', 'nowhere', { listUrl: BROKEN, scrapedAt: 500 })
    const join = joinSavedLists(current([], []), [nowhere, byKudos, undescribed])
    assert.deepEqual(join.lists, [])
    assert.deepEqual(join.copies, [undescribed, byKudos, nowhere], 'newest first; an undescribed copy never joins by its key')
  })

  test('the reader\'s own profile lists are the built-ins; another account\'s are rows', () => {
    const join = joinSavedLists(current([], []), [marked('me'), marked('them'), read('them'), review], 'me')
    assert.deepEqual(join.builtins, { markedForLater: marked('me'), readWorks: null })
    assert.deepEqual(join.copies.map(one => one.key).sort(), ['marked-for-later:them', 'read-works:them'])
    assert.deepEqual(join.review, review)
  })

  test('with no account known, the newest described copy of each stands in', () => {
    const old = marked('old')
    const newer = { ...marked('new'), scrapedAt: 5_000 }
    const undescribed = { key: 'read-works:me', scrapedAt: 9_000 }
    const join = joinSavedLists(current([], []), [old, newer, undescribed, read('them')])
    assert.deepEqual(join.builtins, { markedForLater: newer, readWorks: read('them') })
    assert.deepEqual(join.copies.map(one => one.key), ['read-works:me', 'marked-for-later:old'])
  })

  test('an undescribed copy is a row, even the reader\'s own', () => {
    const undescribed = { key: 'marked-for-later:me', scrapedAt: 1_000 }
    const join = joinSavedLists(current([], []), [undescribed, marked('them')], 'me')
    assert.equal(join.builtins.markedForLater, null)
    assert.deepEqual(join.copies.map(one => one.key).sort(), ['marked-for-later:me', 'marked-for-later:them'])
  })

  test('nothing stored: no copies, no built-ins, no review', () => {
    assert.deepEqual(joinSavedLists(current([], []), []), { lists: [], copies: [], builtins: { markedForLater: null, readWorks: null }, review: null })
  })
})

describe('copyOwner', () => {
  const stored = copy('text-search', 'tea', { listUrl: `${AO3}${TEA}` })
  const owner = (state, one = stored) => copyOwner(joinSavedLists(state, []), one)?.list.id ?? null

  test('of the lists at the copy\'s address, a tracked one', () => {
    const tracked = entry('t', TEA, { alias: 'Theirs', filter: SLOW_BURN })
    const saved = recordOf(entry('s', TEA, { alias: 'Mine' }))
    assert.equal(owner(current([tracked], [saved, recordOf(tracked)])), 't')
  })

  test('else the one that is exactly its search, else the first', () => {
    const filtered = recordOf(entry('f', TEA, { alias: 'Filtered', filter: SLOW_BURN }))
    const exact = recordOf(entry('e', TEA, { alias: 'Exact' }))
    assert.equal(owner(current([], [filtered, exact])), 'e')
    assert.equal(owner(current([], [filtered])), 'f')
  })

  test('none for a copy no list is at, or with no address', () => {
    assert.equal(owner(current([], [recordOf(entry('c', COFFEE))])), null)
    assert.equal(owner(current([], [recordOf(entry('b', BROKEN, { kind: 'tag-works' }))]), { key: 'x', listUrl: BROKEN, scrapedAt: 1 }), null)
    assert.equal(owner(current([], [recordOf(entry('c', COFFEE))]), { key: 'text-search:old', scrapedAt: 1 }), null)
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

  test('a list with no title is read under its default, as the planner will file it', () => {
    const blank = { id: 'b', kind: 'text-search', url: COFFEE, title: '', type: 'search', entity: 'coffee shop' }
    const untitled = entry('u', TEA, { alias: '' })
    assert.deepEqual(savedListsOf(current([untitled], [blank])).map(({ list }) => list.title), ['Search: coffee shop', 'Search: tea'])
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
  const plain = recordOf(entry('p', COFFEE, { alias: 'Search: coffee shop' }))

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

  test('a blank title is the search\'s default', () => {
    const plan = planTrackSearch(current([], []), query, '  ', TODAY)
    assert.equal(plan.state.saved.lists[plan.id].title, 'Search: tea')
    assert.equal(plan.state.tracked.lists[0].alias, 'Search: tea')
  })

  test('a saved list keeps its own title as it is tracked, even one another list shares', () => {
    const saved = recordOf(entry('s', TEA, { alias: 'Search: tea', type: 'search', entity: 'tea' }))
    const other = recordOf(entry('o', `${TEA}&work_search[complete]=T`, { alias: 'Search: tea' }))
    const plan = planTrackSearch(current([], [saved, other]), query, 'Search: tea', TODAY)
    assert.equal(plan.ok, true)
    assert.equal(plan.state.tracked.lists[0].alias, 'Search: tea')
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

  test('a list with no title yet is tracked under its default, though another list has it: nothing is numbered', () => {
    const auto = { id: 'auto', kind: 'text-search', url: TEA, title: '', type: 'search', entity: 'tea' }
    const taken = recordOf(entry('x', TAG, { alias: 'Search: tea' }))
    const plan = planTrackCopy(current([], [auto, taken]), stored, TODAY)
    assert.equal(plan.id, 'auto')
    assert.equal(plan.state.saved.lists.auto.title, 'Search: tea')
    assert.equal(plan.state.tracked.lists[0].alias, 'Search: tea')
  })

  test('the saved list at the copy\'s address is the one tracked, a view filter and all', () => {
    const filtered = recordOf(entry('f', TEA, { alias: 'Tea, slow', filter: SLOW_BURN }))
    const plan = planTrackCopy(current([], [filtered]), stored, TODAY)
    assert.equal(plan.id, 'f', 'no second list at the address')
    assert.deepEqual(Object.keys(plan.state.saved.lists), ['f'])
    assert.deepEqual(plan.state.tracked.lists, [{ id: 'f', kind: 'text-search', url: TEA, alias: 'Tea, slow', filter: SLOW_BURN, tracked: true, since: TODAY }])
  })

  test('a copy whose list is tracked already, with a view filter, is refused as that list', () => {
    const filtered = entry('f', TEA, { alias: 'Tea, slow', filter: SLOW_BURN })
    const plan = planTrackCopy(current([filtered], [recordOf(filtered)]), stored, TODAY)
    assert.equal(plan.ok, false)
    assert.equal(plan.twin.id, 'f')
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

describe('planListingRefile', () => {
  // A collection's sidebar submits the collection's own path with its number
  // added, which a listing's address leaves out. Kept while the address still
  // held it, a submit's copy is under a key with the number, and its list stands
  // beside the link's.
  const LINK = '/collections/yuletide/works'
  const SUBMIT = `${LINK}?work_search[sort_column]=revised_at&collection_id=1`
  const SUBMIT_EN = `${LINK}?work_search[language_id]=en&collection_id=1`
  const ADDRESS = 'works-filter:/collections/yuletide/works'
  const ADDRESS_EN = 'works-filter:/collections/yuletide/works?work_search[language_id]=en'
  const NUMBERED = 'works-filter:/collections/yuletide/works?collection_id=1'
  const NUMBERED_EN = 'works-filter:/collections/yuletide/works?collection_id=1&work_search[language_id]=en'

  /** A filtered listing's copy as `cache.searchLists` holds it, read from `listUrl`. */
  const kept = (listUrl, scrapedAt = 1_000) => ({ v: 3, scrapedAt, ids: 'a,b', descriptor: { sourceId: FILTERED_LISTING_SOURCE_ID, label: 'Collection: yuletide', listUrl: `${AO3}${listUrl}` } })

  /** A saved list of the collection's, under its default title unless told otherwise. */
  const list = (id, url, fields = {}) => ({ id, kind: 'works-filter', url, title: 'Collection: yuletide', type: 'collection', entity: 'yuletide', ...fields })

  /** The plan, its moves made, and the plan again over what it left, which must change nothing. */
  function refile(state, searchLists) {
    deepFreeze(searchLists)
    const first = planListingRefile(state, searchLists)
    const lists = moveKeys(searchLists, first.moves)
    const second = planListingRefile(first.state, lists)
    assert.deepEqual(second.moves, [], 'the second run moves nothing')
    assert.equal(second.state, first.state, 'and changes no list')
    return { ...first, searchLists: lists }
  }

  test('a submit\'s copy kept under its number is refiled at its listing\'s address, its filters and all', () => {
    const plan = refile(current([], [list('sub', SUBMIT)]), { [NUMBERED]: kept(SUBMIT), [NUMBERED_EN]: kept(SUBMIT_EN, 2_000) })
    assert.deepEqual(plan.moves, [[NUMBERED, ADDRESS], [NUMBERED_EN, ADDRESS_EN]])
    assert.deepEqual(plan.searchLists, { [ADDRESS]: kept(SUBMIT), [ADDRESS_EN]: kept(SUBMIT_EN, 2_000) })
    assert.equal(filteredListing(`${AO3}${SUBMIT}`).key, ADDRESS, 'where the search view now looks for it')
  })

  test('every other copy stays where it is', () => {
    const state = current([], [])
    const searchLists = {
      'works-filter:/tags/Bees/works': kept('/works?work_search[sort_column]=title&tag_id=Bees'),
      [ADDRESS]: kept(LINK),
      'works-filter:/works?collection_id=yuletide': kept('/works?collection_id=yuletide'),
      'text-search:work_search%5Bquery%5D=tea': { ...kept(TEA), descriptor: { sourceId: 'text-search', label: 'Search: tea', listUrl: `${AO3}${TEA}` } },
      'tag-works:old': { v: 3, scrapedAt: 1, ids: '' },
      'works-filter:elsewhere': { ...kept(LINK), descriptor: { sourceId: FILTERED_LISTING_SOURCE_ID, label: 'Elsewhere', listUrl: BROKEN } },
    }
    const plan = refile(state, searchLists)
    assert.deepEqual(plan.moves, [])
    assert.equal(plan.searchLists, searchLists)
    assert.equal(plan.state, state)
  })

  test('a copy at the address already stays, and the submit\'s keeps its own key: both are the list\'s, as two sort orders\' copies are', () => {
    const plan = refile(current([], [list('l1nk', LINK)]), { [ADDRESS]: kept(LINK, 1_000), [NUMBERED]: kept(SUBMIT, 2_000) })
    assert.deepEqual(plan.moves, [])
    const join = joinSavedLists(plan.state, storedListRefs(plan.searchLists))
    assert.deepEqual(join.lists.map(one => [one.list.id, one.copyKeys]), [['l1nk', [NUMBERED, ADDRESS]]], 'the newest is the one the row shows')
    assert.deepEqual(join.copies, [])
  })

  test('of two numbered copies of one listing, the newest is refiled, and the other keeps its key', () => {
    const other = 'works-filter:/collections/yuletide/works?collection_id=2'
    const plan = refile(current([], []), { [NUMBERED]: kept(SUBMIT, 1_000), [other]: kept(`${LINK}?collection_id=2`, 2_000) })
    assert.deepEqual(plan.moves, [[other, ADDRESS]])
    assert.deepEqual(Object.keys(plan.searchLists).sort(), [ADDRESS, NUMBERED])
  })

  test('the link\'s list and a submit\'s, one search now, are one list: the link\'s, when nothing else sets them apart', () => {
    const state = current([], [list('l1nk', LINK), list('sub', SUBMIT)])
    const plan = refile(state, {})
    assert.deepEqual(plan.state.saved.lists, { l1nk: list('l1nk', LINK) })
    assert.equal(plan.state.tracked, state.tracked, 'nothing syncs')
  })

  test('a title the reader gave either is kept, with the list they gave it to', () => {
    const titled = list('sub', SUBMIT, { title: 'Yuletide, all of it' })
    assert.deepEqual(refile(current([], [list('l1nk', LINK), titled]), {}).state.saved.lists, { sub: titled })
  })

  test('a tracked one is the one kept, taking the other\'s title on its entry too, and is this browser\'s own from then on', () => {
    const tracked = entry('sub', SUBMIT, { alias: 'Collection: yuletide', type: 'collection', entity: 'yuletide' })
    const plan = refile(current([tracked], [list('l1nk', LINK, { title: 'Yule' }), recordOf(tracked, { mirror: true })]), {})
    assert.deepEqual(plan.state.saved.lists, { sub: recordOf(tracked, { title: 'Yule' }) })
    assert.deepEqual(plan.state.tracked.lists, [{ ...tracked, alias: 'Yule' }])
  })

  test('one title in two casings is one title', () => {
    const plan = refile(current([], [list('l1nk', LINK, { title: 'Yule' }), list('sub', SUBMIT, { title: ' yule ' })]), {})
    assert.deepEqual(plan.state.saved.lists, { l1nk: list('l1nk', LINK, { title: 'Yule' }) })
  })

  test('two titles the reader gave, or two tracked lists, stay two lists, since one would be lost', () => {
    const titled = current([], [list('l1nk', LINK, { title: 'Yule' }), list('sub', SUBMIT, { title: 'Yuletide faves' })])
    assert.equal(refile(titled, {}).state, titled)
    const link = entry('l1nk', LINK, { alias: 'Yule' })
    const submit = entry('sub', SUBMIT, { alias: 'Yuletide faves' })
    const tracked = current([link, submit], [recordOf(link), recordOf(submit)])
    assert.equal(refile(tracked, {}).state, tracked)
  })

  test('lists the number doesn\'t set apart stay apart: another view filter, another of the archive\'s filters, and two submits of one number', () => {
    const state = current([], [
      list('l1nk', LINK),
      list('slow', SUBMIT, { filter: SLOW_BURN }),
      list('en', SUBMIT_EN),
      list('a', `${LINK}?work_search[complete]=T&collection_id=1`),
      list('b', `${LINK}?collection_id=1&work_search[complete]=T&work_search[sort_column]=title`),
    ])
    assert.equal(refile(state, {}).state, state)
  })
})

describe('moveKeys', () => {
  test('each entry under a move\'s first key goes under its second; anything else stays', () => {
    const store = deepFreeze({ a: 1, b: 2, c: 3 })
    assert.deepEqual(moveKeys(store, [['a', 'x'], ['gone', 'y']]), { x: 1, b: 2, c: 3 })
  })

  test('with nothing to move, the same object', () => {
    const store = deepFreeze({ a: 1 })
    assert.equal(moveKeys(store, []), store)
    assert.equal(moveKeys(store, [['gone', 'y']]), store)
  })
})

describe('planDateFilterSplit', () => {
  // A filtered listing's copy kept while its descriptor's address held the
  // date filter the page was read under, as the search view kept it then.
  const BETWEEN = `${AO3}/works?work_search[date_from]=2026-01-01&work_search[sort_column]=title&work_search[date_to]=2026-02-01&tag_id=Bees&page=2`
  const DATES = 'work_search[date_from]=2026-01-01&work_search[date_to]=2026-02-01'
  const WHOLE = `${AO3}/works?work_search[sort_column]=title&tag_id=Bees`
  const KEY = 'works-filter:/tags/Bees/works'

  const described = (sourceId, listUrl, fields = {}) => ({ sourceId, label: 'Tag: Bees', listUrl, ...fields })
  /** A copy as `cache.searchLists` holds it, described by `descriptor`. */
  const kept = descriptor => ({ v: 3, scrapedAt: 1_000, ids: 'a,b', ctx: { a: '<p>ctx</p>' }, ...(descriptor ? { descriptor } : {}) })
  const legacy = () => kept(described(FILTERED_LISTING_SOURCE_ID, `${WHOLE}&${DATES}`))

  /** The plan, and the plan again over what it made, which must hand that back as it is. */
  function split(searchLists) {
    deepFreeze(searchLists)
    const first = planDateFilterSplit(searchLists)
    assert.equal(planDateFilterSplit(deepFreeze(first)), first, 'the second run changes nothing')
    return first
  }

  test('a filtered listing\'s copy whose address holds its date filter keeps the whole listing\'s address, its dates apart, and all else as it was', () => {
    const lists = split({ [KEY]: legacy() })
    assert.deepEqual(lists, { [KEY]: kept(described(FILTERED_LISTING_SOURCE_ID, WHOLE, { dateFilter: DATES })) })
  })

  test('which is the copy its search view now keeps of that read, at the same address and the same list\'s', () => {
    const listing = filteredListing(BETWEEN)
    const { descriptor } = split({ [KEY]: legacy() })[KEY]
    assert.deepEqual({ listUrl: descriptor.listUrl, dateFilter: descriptor.dateFilter }, { listUrl: new URL(listing.url, AO3).href, dateFilter: listing.dateFilter })
    assert.equal(addressOf(descriptor.listUrl), addressOf(legacy().descriptor.listUrl))
    assert.equal(sameReading(withDateFilter(descriptor.listUrl, descriptor.dateFilter), legacy().descriptor.listUrl), true, 'still the read it was')
  })

  test('every other copy is left as it is: the same object when none needs it', () => {
    const searchLists = {
      [KEY]: kept(described(FILTERED_LISTING_SOURCE_ID, WHOLE)),
      'works-filter:/tags/Wasps/works': kept(described(FILTERED_LISTING_SOURCE_ID, `${AO3}/tags/Wasps/works`, { dateFilter: DATES })),
      'works-filter:/tags/Moths/works': kept(described(FILTERED_LISTING_SOURCE_ID, `${AO3}/tags/Moths/works?work_search[revised_at]=%3C+2+weeks`)),
      'text-search:work_search%5Bdate_from%5D=2026-01-01&work_search%5Bquery%5D=tea': kept(described('text-search', `${AO3}/works/search?work_search%5Bquery%5D=tea&work_search%5Bdate_from%5D=2026-01-01&page=1`)),
      'marked-for-later:me': kept(described('marked-for-later', `${AO3}/users/me/readings?show=to-read`)),
      'works-filter:elsewhere': kept(described(FILTERED_LISTING_SOURCE_ID, `${BROKEN}?work_search[date_from]=2026-01-01`)),
      'works-filter:/tags/Old/works': kept(),
      'not-a-list': 'junk',
    }
    assert.equal(split(searchLists), searchLists)
  })

  test('nothing stored, or nothing that is stored lists, is nothing to do', () => {
    for (const store of [{}, null, undefined, 'junk'])
      assert.equal(planDateFilterSplit(store), store, String(store))
  })
})

describe('splitDateFilter', () => {
  const DATES = 'work_search[date_from]=2026-01-01&work_search[date_to]=2026-02-01'
  const WHOLE = `${AO3}/tags/Bees/works`

  test('a stopped job\'s descriptor of a filtered listing read between dates keeps the whole listing\'s address, its dates apart; again, it is as it is', () => {
    const job = deepFreeze({ sourceId: FILTERED_LISTING_SOURCE_ID, label: 'Tag: Bees', listUrl: `${WHOLE}?${DATES}` })
    const first = splitDateFilter(job)
    assert.deepEqual(first, { sourceId: FILTERED_LISTING_SOURCE_ID, label: 'Tag: Bees', listUrl: WHOLE, dateFilter: DATES })
    assert.equal(splitDateFilter(deepFreeze(first)), first)
  })

  test('any other is handed back as it is', () => {
    for (const descriptor of [
      { sourceId: FILTERED_LISTING_SOURCE_ID, label: 'Tag: Bees', listUrl: WHOLE },
      { sourceId: 'text-search', label: 'Search: tea', listUrl: `${AO3}/works/search?work_search[query]=tea&${DATES}` },
      { sourceId: FILTERED_LISTING_SOURCE_ID, label: 'Elsewhere', listUrl: `${BROKEN}?${DATES}` },
      { sourceId: FILTERED_LISTING_SOURCE_ID, label: 'No address' },
      undefined,
      null,
      'junk',
    ])
      assert.equal(splitDateFilter(descriptor), descriptor, JSON.stringify(descriptor))
  })
})
