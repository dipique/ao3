import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { claimRefresh } from '../../src/content_script/searchView/listRefresh.ts'
import { bucketBar, bucketFigures } from '../../src/options_ui/model/buckets.ts'
import { foreignView, jobView } from '../../src/options_ui/model/jobView.ts'
import { timeAgo } from '../../src/options_ui/model/moments.ts'
import { PROFILE_LISTS, profileTiles, REFRESH_OFF, refreshNeeds } from '../../src/options_ui/model/profileLists.ts'

const NOW = 1_800_000_000_000
const ARCHIVE = 'https://archiveofourown.org'
const MARKED = 'marked-for-later:tester'
const READ = 'read-works:tester'
const OTHER = 'tag-works:Coffee%20Shop%20AU'
const HOURS_AGO = NOW - 3 * 60 * 60_000

const buckets = (fields = {}) => ({ total: 240, cached: 205, failed: 6, unfetched: 29, bytes: 7_235_174, staleFailures: 0, ...fields })

/** The reader's Marked for Later, stored three hours ago: 240 works, 205 cached, 6 failed. */
const markedCopy = (fields = {}) => ({
  key: MARKED,
  count: 240,
  scrapedAt: HOURS_AGO,
  buckets: buckets(),
  unstored: 0,
  listUrl: `${ARCHIVE}/users/tester/readings?show=to-read`,
  ...fields,
})

/** Their read works, two days old, with nothing cached. */
const readCopy = {
  key: READ,
  count: 620,
  scrapedAt: NOW - 2 * 24 * 60 * 60_000,
  buckets: buckets({ total: 620, cached: 0, failed: 0, unfetched: 620, bytes: 0 }),
  unstored: 0,
  listUrl: `${ARCHIVE}/users/tester/readings`,
}

/** The job as the page reads it: on `key`, running unless told otherwise. */
function job(key, { job: fields, ...status } = {}) {
  return jobView({
    job: {
      cacheKey: key,
      descriptor: { sourceId: 'marked-for-later', label: 'Marked for Later — tester', listUrl: '' },
      steps: ['caching'],
      queue: [],
      done: 148,
      total: 240,
      startedAt: NOW - 60_000,
      updatedAt: NOW,
      errors: [],
      errorCount: 0,
      ...fields,
    },
    running: true,
    message: 'Fetching…',
    error: null,
    warnings: [],
    waitingUntil: null,
    waitReason: null,
    ...status,
  }, k => ({ [MARKED]: 'Marked for Later', [READ]: 'Read works', [OTHER]: 'Coffee Shop AU' })[k] ?? '', NOW)
}

const IDLE = jobView({ job: null, running: false, message: '', error: null, warnings: [], waitingUntil: null, waitReason: null }, () => '', NOW)

/** The reader's settings, with work marks on and no list tracked, which neither tile asks for. */
const MARKS_ON = { trackedLists: { lists: [] }, workMarks: { enabled: true } }
const MARKS_OFF = { ...MARKS_ON, workMarks: { enabled: false } }

/** Both tiles, with both copies stored, work marks on and no job, unless told otherwise. */
const tiles = (input = {}) => profileTiles({ copies: { 'marked-for-later': markedCopy(), 'read-works': readCopy }, userId: 'tester', settings: MARKS_ON, job: IDLE, now: NOW, ...input })
const marked = input => tiles(input)[0]
const read = input => tiles(input)[1]

describe('the profile lists', () => {
  test('Marked for Later, then Read works, each with its note and no account name', () => {
    assert.deepEqual(tiles().map(tile => [tile.id, tile.name, tile.note]), [
      ['marked-for-later', 'Marked for Later', 'Your own to-read page. Not part of Review — it only changes when you add to it.'],
      ['read-works', 'Read works', 'Everything you’ve marked read or given a verdict, Favorites included: a shelf to come back to. Not part of Review — it only changes when you mark something.'],
    ])
    assert.deepEqual(PROFILE_LISTS.map(list => list.id), ['marked-for-later', 'read-works'])
  })
})

describe('a tile with its copy', () => {
  test('how many works, and how old the copy is', () => {
    assert.deepEqual(marked().figure, { count: '240', detail: `works · as of ${timeAgo(HOURS_AGO, NOW)}` })
    assert.deepEqual(read().figure, { count: '620', detail: `works · as of ${timeAgo(readCopy.scrapedAt, NOW)}` })
    assert.equal(marked({ copies: { 'marked-for-later': markedCopy({ count: 1 }), 'read-works': null } }).figure.detail, `work · as of ${timeAgo(HOURS_AGO, NOW)}`)
    assert.equal(marked({ copies: { 'marked-for-later': markedCopy({ count: 2400 }), 'read-works': null } }).figure.count, '2,400')
  })

  test('works whose blurbs a refresh would bring back are counted', () => {
    assert.equal(marked({ copies: { 'marked-for-later': markedCopy({ unstored: 4 }), 'read-works': null } }).figure.detail, `works · as of ${timeAgo(HOURS_AGO, NOW)} · 4 need refreshing`)
  })

  test('the bucket bar and its figures', () => {
    assert.deepEqual(marked().bar, bucketBar(buckets()))
    assert.deepEqual(marked().figures, bucketFigures(buckets()))
    assert.equal(marked().empty, null)
  })

  test('View on AO3 is the list\'s open URL, on the reader\'s own page', () => {
    assert.equal(marked().view, '/users/tester/readings?show=to-read#ao3e-open=marked-for-later')
    assert.equal(read().view, '/users/tester/readings#ao3e-open=read-works')
  })

  test('with the reader\'s account not known, it opens on the page the copy was read from', () => {
    assert.equal(marked({ userId: undefined }).view, `${ARCHIVE}/users/tester/readings?show=to-read#ao3e-open=marked-for-later`)
    assert.equal(read({ userId: undefined }).view, `${ARCHIVE}/users/tester/readings#ao3e-open=read-works`)
  })

  test('with no job, Refresh list, Cache works and Download Offline Copy, all on', () => {
    for (const tile of tiles()) {
      assert.equal(tile.actions, 'offline', tile.id)
      assert.equal(tile.offlineOff, null, tile.id)
      assert.equal(tile.refreshOff, null, tile.id)
      assert.equal(tile.refreshNeeds, null, tile.id)
      assert.equal(tile.job, false, tile.id)
    }
  })

  test('More offers a retry while any work has failed, stale ones included', () => {
    assert.equal(marked().retry, 6)
    assert.equal(marked({ copies: { 'marked-for-later': markedCopy({ buckets: buckets({ staleFailures: 3 }) }), 'read-works': null } }).retry, 9)
    assert.equal(read().retry, 0)
  })

  test('and a download without refreshing once anything is cached', () => {
    assert.equal(marked().cached, 205)
    assert.equal(read().cached, 0)
  })
})

describe('a tile with no copy', () => {
  const none = (input = {}) => tiles({ copies: { 'marked-for-later': null, 'read-works': null }, ...input })

  test('says how one is kept: by its own View on AO3, which keeps one whatever the list\'s search switch says', () => {
    for (const tile of none())
      assert.equal(tile.empty, 'None yet. Use View on AO3, signed in, to keep a copy: from then on, it refreshes from here.', tile.id)
  })

  test('with no View on AO3, the reader\'s account not known, it names the page and the switch that keep one', () => {
    const [mfl, rw] = none({ userId: undefined })
    assert.equal(mfl.empty, 'None yet. Open your Marked for Later page on AO3, signed in, with Search your Marked for Later list on: a copy is kept from then on, and refreshes from here.')
    assert.equal(rw.empty, 'None yet. Press Search read items on your History page on AO3, signed in, with Search the works you\'ve read on: a copy is kept from then on, and refreshes from here.')
  })

  test('has nothing to count or fetch', () => {
    const [mfl, rw] = none()
    for (const tile of [mfl, rw]) {
      assert.equal(tile.figure, null)
      assert.equal(tile.bar, null)
      assert.equal(tile.figures, null)
      assert.equal(tile.actions, null)
      assert.equal(tile.offlineOff, null)
      assert.equal(tile.job, false)
    }
  })

  test('View on AO3 is the list\'s open URL on the reader\'s own page, when the page knows who they are', () => {
    assert.deepEqual(none().map(tile => tile.view), ['/users/tester/readings?show=to-read#ao3e-open=marked-for-later', '/users/tester/readings#ao3e-open=read-works'])
    assert.deepEqual(none({ userId: undefined }).map(tile => tile.view), [null, null])
  })

  test('another list\'s job has nothing here to turn off', () => {
    assert.equal(none({ job: job(OTHER) })[0].offlineOff, null)
  })
})

describe('Read works with work marks off, when its view opens nothing', () => {
  const NEEDS_MARKS = 'None yet. This list is made from your marks, so it needs Work marks on, under Reading.'
  const none = (input = {}) => tiles({ copies: { 'marked-for-later': null, 'read-works': null }, settings: MARKS_OFF, ...input })

  test('has no View on AO3, with its copy or without, whether or not the reader\'s account is known', () => {
    assert.equal(read({ settings: MARKS_OFF }).view, null)
    assert.equal(read({ settings: MARKS_OFF, userId: undefined }).view, null, 'not even on the page its copy was read from')
    assert.equal(none()[1].view, null)
    assert.equal(none({ userId: undefined })[1].view, null)
  })

  test('with no copy, its note says the list needs Work marks on, whether or not the reader\'s account is known', () => {
    assert.equal(none()[1].empty, NEEDS_MARKS)
    assert.equal(none({ userId: undefined })[1].empty, NEEDS_MARKS)
  })

  test('with its copy, it still counts the copy and says nothing of how one is kept', () => {
    const tile = read({ settings: MARKS_OFF })
    assert.equal(tile.empty, null)
    assert.deepEqual(tile.figure, read().figure)
  })

  test('Marked for Later, which needs no marks, keeps its View on AO3 and its note', () => {
    assert.equal(marked({ settings: MARKS_OFF }).view, '/users/tester/readings?show=to-read#ao3e-open=marked-for-later')
    assert.equal(none()[0].view, '/users/tester/readings?show=to-read#ao3e-open=marked-for-later')
    assert.equal(none()[0].empty, 'None yet. Use View on AO3, signed in, to keep a copy: from then on, it refreshes from here.')
  })

  test('a list tracked or not makes no difference to either tile', () => {
    const tracked = { ...MARKS_ON, trackedLists: { lists: [{ tracked: true }] } }
    assert.deepEqual(tiles({ settings: tracked }).map(tile => tile.view), tiles().map(tile => tile.view))
    assert.deepEqual(tiles({ settings: { ...MARKS_OFF, trackedLists: { lists: [{ tracked: true }] } } }).map(tile => tile.view), tiles({ settings: MARKS_OFF }).map(tile => tile.view))
  })
})

describe('Read works with work marks off and its copy kept, which a refresh would empty', () => {
  test('Refresh list, Download Offline Copy and Refresh the list first are off, saying the list needs Work marks', () => {
    const tile = read({ settings: MARKS_OFF })
    assert.equal(tile.refreshOff, REFRESH_OFF.workMarks)
    assert.equal(tile.refreshNeeds, REFRESH_OFF.workMarks, 'said in the tile, where the reader is looking')
    assert.equal(REFRESH_OFF.workMarks, 'off while Work marks, under Reading, is switched off: this list is made from your marks, so without them it can\'t be refreshed or viewed on AO3')
  })

  test('Cache works, the retry and Download without refreshing work from the copy as it is, so they stay on', () => {
    const tile = read({ settings: MARKS_OFF })
    assert.equal(tile.actions, 'offline')
    assert.equal(tile.offlineOff, null)
  })

  test('Marked for Later, made from no marks, refreshes as before', () => {
    assert.equal(marked({ settings: MARKS_OFF }).refreshOff, null)
    assert.equal(marked({ settings: MARKS_OFF }).refreshNeeds, null)
  })

  test('with no copy there is nothing to refresh, and its note already says what the list needs', () => {
    const tile = tiles({ copies: { 'marked-for-later': null, 'read-works': null }, settings: MARKS_OFF })[1]
    assert.equal(tile.refreshOff, null)
    assert.equal(tile.refreshNeeds, null)
  })

  test('another list\'s job turns every offline action off, and the refresh keeps its own reason, which outlasts the job', () => {
    const tile = read({ settings: MARKS_OFF, job: job(MARKED) })
    assert.equal(tile.offlineOff, 'off for now: one job at a time, and Marked for Later is caching')
    assert.equal(tile.refreshOff, REFRESH_OFF.workMarks)
    assert.equal(tile.refreshNeeds, REFRESH_OFF.workMarks)
  })

  test('with work marks on, another list\'s job is the refresh\'s reason too', () => {
    const tile = read({ job: job(MARKED) })
    assert.equal(tile.refreshOff, 'off for now: one job at a time, and Marked for Later is caching')
    assert.equal(tile.refreshNeeds, null)
  })

  test('while its own job runs or waits to continue, the tile still says why the list can\'t be refreshed', () => {
    assert.equal(read({ settings: MARKS_OFF, job: job(READ) }).refreshNeeds, REFRESH_OFF.workMarks)
    assert.equal(read({ settings: MARKS_OFF, job: job(READ, { running: false }) }).refreshNeeds, REFRESH_OFF.workMarks)
  })

  test('refreshNeeds: only Read works, and only with work marks off', () => {
    assert.equal(refreshNeeds('read-works', false), REFRESH_OFF.workMarks)
    assert.equal(refreshNeeds('read-works', true), null)
    assert.equal(refreshNeeds('marked-for-later', false), null)
    assert.equal(refreshNeeds('tag-works', false), null)
    assert.equal(refreshNeeds(undefined, false), null, 'a list no visit has described is said to be off for its own reason')
  })
})

describe('a tile and the job', () => {
  test('another list\'s job turns its offline actions off, naming that list', () => {
    const tile = read({ job: job(MARKED) })
    assert.equal(tile.actions, 'offline')
    assert.equal(tile.offlineOff, 'off for now: one job at a time, and Marked for Later is caching')
    assert.equal(tile.job, false)
  })

  test('a refresh an AO3 tab runs on it: the line in the tile, and Cancel in place of the actions', () => {
    const foreign = foreignView(claimRefresh('tab', 'page', NOW), MARKED, () => 'Marked for Later', NOW)
    const tile = marked({ foreign })
    assert.equal(tile.actions, 'cancel')
    assert.equal(tile.job, true)
    assert.equal(read({ foreign }).actions, 'offline', 'and nothing on the other tile')
  })

  test('its own job: the line in the tile, and Pause or Cancel in place of the actions', () => {
    const tile = marked({ job: job(MARKED) })
    assert.equal(tile.actions, 'stop')
    assert.equal(tile.offlineOff, null)
    assert.equal(tile.job, true)
    assert.equal(marked({ job: job(MARKED, { waitingUntil: NOW + 9_000, waitReason: 'pacing' }) }).actions, 'stop', 'a pause is still running')
  })

  test('its own job, stopped, by the reader or by an error: Continue or Discard', () => {
    assert.equal(marked({ job: job(MARKED, { running: false }) }).actions, 'resume')
    assert.equal(marked({ job: job(MARKED, { running: false, error: 'AO3 kept asking us to wait.' }) }).actions, 'resume')
    assert.equal(marked({ job: job(MARKED, { running: false }) }).job, true)
  })

  test('its own job, finished: the line stays, and the actions are back', () => {
    const tile = marked({ job: job(MARKED, { running: false, job: { steps: [] } }) })
    assert.equal(tile.actions, 'offline')
    assert.equal(tile.offlineOff, null)
    assert.equal(tile.job, true)
  })

  test('a job on one tile is no job on the other', () => {
    assert.equal(read({ job: job(MARKED, { running: false }) }).job, false)
    assert.equal(read({ job: job(MARKED, { running: false }) }).offlineOff, null)
  })
})
