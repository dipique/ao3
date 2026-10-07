import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { joinSavedLists } from '../../src/common/savedLists.ts'
import { OFFLINE_OFF, savedListRows, TRACK_OFF } from '../../src/options_ui/model/savedListRows.ts'

const AO3 = 'https://archiveofourown.org'
const DAY = 20_400

const TEA = '/works/search?work_search[query]=tea'
const TEA_BY_KUDOS = '/works/search?work_search[query]=tea&work_search[sort_column]=kudos_count'
const TAG = '/tags/marriage%20problems'
const HP = '/tags/Harry%20Potter/works'
const BROKEN = 'https://example.com/tags/x'

const SLOW_BURN = { text: 'slow burn' }

function state(entries, records) {
  return {
    tracked: { enabled: true, target: 40, reviewedThrough: 0, lists: entries },
    saved: { v: 1, lists: Object.fromEntries(records.map(record => [record.id, record])) },
  }
}

const record = (id, url, fields = {}) => ({ id, kind: 'text-search', url, title: '', ...fields })
const tracking = ({ id, kind, url, title, type, entity, filter }, since = DAY) =>
  Object.fromEntries(Object.entries({ id, kind, url, alias: title, type, entity, filter, tracked: true, since }).filter(([, value]) => value !== undefined))

const copy = (key, fields = {}) => ({ key, scrapedAt: 1_000, ...fields })
const described = (key, sourceId, path, label, fields = {}) => copy(key, { sourceId, listUrl: `${AO3}${path}`, label, ...fields })

/** What a stored list holds, by key, made up for each copy. */
const figures = key => ({ buckets: { total: 10, cached: 6, failed: 1, unfetched: 3, bytes: key.length, staleFailures: 2 }, unstored: 4 })
const IDLE = { copy: figures, review: true, jobOff: () => null }

/** The rows, by id. */
function rows(join, ctx = IDLE) {
  return Object.fromEntries(savedListRows(join, ctx).map(row => [row.id, row]))
}

/**
 * One row per saved list, and one per stored list no saved list claims: what
 * each says it is, its status, its caching figures, its links, and why any of
 * its controls is off.
 */
describe('savedListRows', () => {
  const tea = record('t3a', TEA, { title: 'Morning tea', type: 'search', entity: 'tea', filter: SLOW_BURN })
  const teaCopy = described('text-search:tea-kudos', 'text-search', TEA_BY_KUDOS, 'Works search: tea', { scrapedAt: 7_000 })

  test('a tracked list with a copy: tracked since its day, figures from its copy, its links and what it is', () => {
    const got = rows(joinSavedLists(state([tracking(tea, DAY - 3)], [tea]), [teaCopy]))
    assert.deepEqual(got.t3a, {
      id: 't3a',
      title: 'Morning tea',
      placeholder: 'Search: tea',
      titleEditable: true,
      rawKey: false,
      type: 'Search',
      typeTip: 'Search: tea',
      kind: 'Works search',
      filters: { text: 'Text: “slow burn”', full: 'Text: “slow burn”', more: 0 },
      viewEdit: `${TEA}#ao3e-list=t3a`,
      copyUrl: TEA,
      status: 'tracked',
      pending: null,
      since: DAY - 3,
      sharedTitle: false,
      sameAddressAs: [],
      caching: { kind: 'copy', ...figures(teaCopy.key), scrapedAt: 7_000 },
    })
  })

  test('a saved list is saved, with its own View/Edit; with no copy it isn\'t cached', () => {
    const series = record('s3r', '/series/9991', { kind: 'series-works', title: 'Long haul' })
    const got = rows(joinSavedLists(state([], [series]), []))
    assert.equal(got.s3r.status, 'saved')
    assert.equal(got.s3r.since, undefined)
    assert.equal(got.s3r.viewEdit, '/series/9991#ao3e-list=s3r', 'a list that isn\'t tracked is refined like one that is')
    assert.deepEqual(got.s3r.caching, { kind: 'none' })
    assert.equal(got.s3r.offlineOff, undefined, 'no copy, so no offline actions to turn off')
  })

  test('a list never shows a placeholder for a title: one never given one has its default, which an emptied field commits to', () => {
    const blank = record('b', '/series/9991', { kind: 'series-works' })
    const got = rows(joinSavedLists(state([], [blank]), [])).b
    assert.equal(got.title, 'Series: 9991')
    assert.equal(got.placeholder, 'Series: 9991')
  })

  test('a list at no address on the archive with no title has no default either: its URL\'s tail stands in', () => {
    const lone = record('lone', BROKEN, { kind: 'tag-works' })
    const got = rows(joinSavedLists(state([], [lone]), [])).lone
    assert.equal(got.title, '')
    assert.equal(got.placeholder, BROKEN)
  })

  test('a filtered listing is not kept offline', () => {
    const hp = record('hp', HP, { kind: 'works-filter', type: 'tag', entity: 'Harry Potter' })
    assert.deepEqual(rows(joinSavedLists(state([], [hp]), [])).hp.caching, { kind: 'not-offline' })
  })

  test('a list at no address on the archive is pending: no links, and its toggle off with the reason', () => {
    const broken = record('br0', BROKEN, { kind: 'tag-works', title: 'Elsewhere' })
    const got = rows(joinSavedLists(state([tracking(broken)], [broken]), [])).br0
    assert.equal(got.status, 'tracked')
    assert.equal(got.pending, 'not-archive')
    assert.equal(got.viewEdit, undefined)
    assert.equal(got.copyUrl, undefined)
    assert.equal(got.trackOff, TRACK_OFF.notArchive)
    assert.equal(got.titleEditable, true, 'it can still be titled, and removed')
  })

  test('with review off, every toggle is off with that reason, and the offline copy is untouched', () => {
    const series = record('s3r', '/series/9991', { kind: 'series-works' })
    const got = rows(joinSavedLists(state([tracking(tea)], [tea, series]), [teaCopy]), { ...IDLE, review: false })
    assert.equal(got.t3a.trackOff, TRACK_OFF.review)
    assert.equal(got.s3r.trackOff, TRACK_OFF.review)
    assert.equal(got.t3a.offlineOff, undefined)
  })

  test('a job turns off the offline actions of every row with a copy, with its reason', () => {
    const busy = 'off for now: one job at a time, and Marked for Later is caching'
    const series = record('s3r', '/series/9991', { kind: 'series-works' })
    const got = rows(joinSavedLists(state([], [tea, series]), [teaCopy]), { ...IDLE, jobOff: key => (key === teaCopy.key ? busy : null) })
    assert.equal(got.t3a.offlineOff, busy)
    assert.equal(got.t3a.trackOff, undefined, 'tracking never waits on a job')
    assert.equal(got.s3r.offlineOff, undefined)
  })

  test('an undescribed copy is a row of its own, by its raw key, pending one visit', () => {
    const old = copy('tag-works:Coffee%20Shop%20AU')
    const got = rows(joinSavedLists(state([], []), [old]), { ...IDLE, jobOff: () => 'off for now: another list is caching' })['copy:tag-works:Coffee%20Shop%20AU']
    assert.deepEqual(got, {
      id: 'copy:tag-works:Coffee%20Shop%20AU',
      title: 'tag-works:Coffee%20Shop%20AU',
      placeholder: '',
      titleEditable: false,
      rawKey: true,
      filters: { text: '', full: '', more: 0 },
      status: 'saved',
      pending: 'needs-visit',
      sharedTitle: false,
      sameAddressAs: [],
      caching: { kind: 'copy', ...figures(old.key), scrapedAt: 1_000 },
      trackOff: TRACK_OFF.needsVisit,
      offlineOff: OFFLINE_OFF.undescribed,
    })
  })

  test('a stored search at no address on the archive is pending, under its label', () => {
    const nowhere = described('text-search:nowhere', 'text-search', '', 'Works search: nowhere', { listUrl: BROKEN })
    const got = rows(joinSavedLists(state([], []), [nowhere]))['copy:text-search:nowhere']
    assert.equal(got.pending, 'not-archive')
    assert.equal(got.title, 'Works search: nowhere')
    assert.equal(got.rawKey, false)
    assert.equal(got.copyUrl, undefined)
    assert.equal(got.trackOff, TRACK_OFF.notArchive)
  })

  test('another account\'s profile list is a row that can\'t be tracked', () => {
    const theirs = described('marked-for-later:them', 'marked-for-later', '/users/them/readings?show=to-read', 'Marked for Later — them')
    const got = rows(joinSavedLists(state([], []), [theirs], 'me'))['copy:marked-for-later:them']
    assert.equal(got.pending, null)
    assert.equal(got.title, 'Marked for Later — them')
    assert.equal(got.trackOff, TRACK_OFF.notSearch)
    assert.equal(got.copyUrl, undefined)
  })

  test('a stored search not yet given its record is a row that tracks like one, under the title its record will take', () => {
    const fresh = described('tag-works:marriage%20problems', 'tag-works', TAG, 'Uncommon tag — marriage problems')
    const got = rows(joinSavedLists(state([], []), [fresh]))['copy:tag-works:marriage%20problems']
    assert.equal(got.title, 'Tag: marriage problems')
    assert.equal(got.pending, null)
    assert.equal(got.trackOff, undefined)
    assert.equal(got.titleEditable, false, 'a title needs its record')
    assert.equal(got.copyUrl, TAG)
    assert.equal(got.viewEdit, undefined)
    assert.equal(got.type, 'Tag')
    assert.equal(got.kind, 'Uncommon tag')
  })

  test('two lists sharing a title are both flagged, whatever their case and spaces', () => {
    const a = record('a', TEA, { title: 'Tea ' })
    const b = record('b', TAG, { kind: 'tag-works', title: 'tea' })
    const c = record('c', '/series/1', { kind: 'series-works' })
    const d = record('d', '/series/2', { kind: 'series-works' })
    const got = rows(joinSavedLists(state([], [a, b, c, d]), []))
    assert.deepEqual([got.a.sharedTitle, got.b.sharedTitle, got.c.sharedTitle, got.d.sharedTitle], [true, true, false, false])
  })

  test('two searches with one default title are flagged like any other pair', () => {
    const plain = record('p', TEA, { title: 'Search: tea' })
    const complete = record('c', `${TEA}&work_search[complete]=T`)
    const got = rows(joinSavedLists(state([], [plain, complete]), []))
    assert.deepEqual([got.p.sharedTitle, got.c.sharedTitle], [true, true])
  })

  test('lists at one address say which others search the same, by title', () => {
    const mine = record('m', TEA, { title: 'Mine' })
    const theirs = record('t', TEA_BY_KUDOS, { filter: SLOW_BURN, title: 'Theirs' })
    const got = rows(joinSavedLists(state([tracking(theirs)], [mine, theirs]), [teaCopy]))
    assert.deepEqual(got.m.sameAddressAs, ['Theirs'])
    assert.deepEqual(got.t.sameAddressAs, ['Mine'])
  })

  test('the lists come first, then the copies no list claims', () => {
    const got = savedListRows(joinSavedLists(state([], [tea]), [copy('tag-works:old')]), IDLE).map(row => row.id)
    assert.deepEqual(got, ['t3a', 'copy:tag-works:old'])
  })
})
