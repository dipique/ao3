import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { joinSavedLists } from '../../src/common/savedLists.ts'
import { formatDay } from '../../src/common/trackedLists.ts'
import { bucketBar, formatBytes } from '../../src/options_ui/model/buckets.ts'
import { jobView } from '../../src/options_ui/model/jobView.ts'
import { timeAgo } from '../../src/options_ui/model/moments.ts'
import { blurbsOnRemove, cachingCell, copyTitle, describeList, NEEDS_VISIT_NOTE, NOT_ARCHIVE_NOTE, OFFLINE_OFF, offlineDetails, rowAction, sameSearchNote, savedListRows, statusCell, STOP_NOTE, titleRefusal, titlesInWords, TRACK_OFF, trackingDetails } from '../../src/options_ui/model/savedListRows.ts'

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
      open: `${TEA}#ao3e-open=t3a`,
      status: 'tracked',
      pending: null,
      since: DAY - 3,
      sharedTitle: false,
      sameAddressAs: [],
      caching: { kind: 'copy', key: teaCopy.key, ...figures(teaCopy.key), scrapedAt: 7_000 },
    })
  })

  test('a saved list is saved, with its own View/Edit; with no copy it isn\'t cached', () => {
    const series = record('s3r', '/series/9991', { kind: 'series-works', title: 'Long haul' })
    const got = rows(joinSavedLists(state([], [series]), []))
    assert.equal(got.s3r.status, 'saved')
    assert.equal(got.s3r.since, undefined)
    assert.equal(got.s3r.viewEdit, '/series/9991#ao3e-list=s3r', 'a list that isn\'t tracked is refined like one that is')
    assert.equal(got.s3r.open, '/series/9991#ao3e-open=s3r', 'and opened like one')
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

  test('a filtered listing with no copy isn\'t cached, as no list of any other kind is', () => {
    const hp = record('hp', HP, { kind: 'works-filter', type: 'tag', entity: 'Harry Potter' })
    assert.deepEqual(rows(joinSavedLists(state([], [hp]), [])).hp.caching, { kind: 'none' })
  })

  test('every saved list opens on its own page by its id, its view filter left to the list', () => {
    const hp = record('hp', HP, { kind: 'works-filter', type: 'tag', entity: 'Harry Potter', filter: SLOW_BURN })
    const tag = record('m4rr', TAG, { kind: 'tag-works', scan: true })
    const got = rows(joinSavedLists(state([tracking(hp)], [hp, tag, tea]), [teaCopy]))
    assert.deepEqual([got.hp.open, got.m4rr.open, got.t3a.open], [`${HP}#ao3e-open=hp`, `${TAG}#ao3e-open=m4rr`, `${TEA}#ao3e-open=t3a`])
  })

  test('a list at no address on the archive is pending: no links, and its toggle off with the reason', () => {
    const broken = record('br0', BROKEN, { kind: 'tag-works', title: 'Elsewhere' })
    const got = rows(joinSavedLists(state([tracking(broken)], [broken]), [])).br0
    assert.equal(got.status, 'tracked')
    assert.equal(got.pending, 'not-archive')
    assert.equal(got.viewEdit, undefined)
    assert.equal(got.open, undefined)
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
      caching: { kind: 'copy', key: old.key, ...figures(old.key), scrapedAt: 1_000 },
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
    assert.equal(got.open, undefined)
    assert.equal(got.trackOff, TRACK_OFF.notArchive)
  })

  test('another account\'s profile list is a row that can\'t be tracked', () => {
    const theirs = described('marked-for-later:them', 'marked-for-later', '/users/them/readings?show=to-read', 'Marked for Later — them')
    const got = rows(joinSavedLists(state([], []), [theirs], 'me'))['copy:marked-for-later:them']
    assert.equal(got.pending, null)
    assert.equal(got.title, 'Marked for Later — them')
    assert.equal(got.trackOff, TRACK_OFF.notSearch)
    assert.equal(got.open, undefined)
  })

  test('a stored search not yet given its record is a row that tracks like one, under the title its record will take', () => {
    const fresh = described('tag-works:marriage%20problems', 'tag-works', TAG, 'Uncommon tag — marriage problems')
    const got = rows(joinSavedLists(state([], []), [fresh]))['copy:tag-works:marriage%20problems']
    assert.equal(got.title, 'Tag: marriage problems')
    assert.equal(got.pending, null)
    assert.equal(got.trackOff, undefined)
    assert.equal(got.titleEditable, false, 'a title needs its record')
    assert.equal(got.viewEdit, undefined)
    assert.equal(got.open, undefined, 'no id to open it by, or copy a link to, until its record is filed')
    assert.equal('copyUrl' in got, false, 'Copy URL copies the open URL, which it hasn\'t')
    assert.equal(got.type, 'Tag')
    assert.equal(got.kind, 'Uncommon tag')
  })

  test('a filtered listing\'s copy not yet given its record tracks like any search, and its saved list reads it once filed', () => {
    const at = '/works?work_search[sort_column]=title&tag_id=Bees'
    const fresh = described('works-filter:/tags/Bees/works', 'works-filter', at, 'Tag: Bees')
    const got = rows(joinSavedLists(state([], []), [fresh]))['copy:works-filter:/tags/Bees/works']
    assert.equal(got.title, 'Tag: Bees')
    assert.equal(got.pending, null)
    assert.equal(got.trackOff, undefined)
    assert.equal(got.open, undefined)
    assert.equal(got.type, 'Tag')
    assert.equal(got.kind, 'Filtered listing')

    const bees = record('b33s', '/tags/Bees/works', { kind: 'works-filter', type: 'tag', entity: 'Bees' })
    assert.equal(rows(joinSavedLists(state([], [bees]), [fresh])).b33s.caching.key, 'works-filter:/tags/Bees/works')
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

/**
 * What removing a stored copy does to its blurbs, which a remove confirmation
 * says: only *Discard unneeded blurbs automatically* has them go at once.
 */
describe('blurbsOnRemove', () => {
  test('with Discard unneeded blurbs automatically on, the blurbs no other list holds go now', () => {
    assert.equal(blurbsOnRemove(true), 'The blurbs saved for it that no other list holds go now, since Discard unneeded blurbs automatically is on.')
  })

  test('with it off, they stay for Discard orphans', () => {
    assert.equal(blurbsOnRemove(false), 'The blurbs saved for it stay until Discard orphans clears them, since Discard unneeded blurbs automatically is off.')
  })
})

/** The job as the page sees it: none, or one on the stored list `key`, named Marked for Later wherever it is. */
const NOW = 2_000_000_000_000
const jobStatus = (key, fields = {}) => ({
  job: key && { cacheKey: key, steps: ['caching'], queue: [], done: 1, total: 10, startedAt: 0, updatedAt: 0, errors: [], errorCount: 0 },
  running: !!key,
  message: 'Fetching…',
  error: null,
  warnings: [],
  waitingUntil: null,
  waitReason: null,
  ...fields,
})
const NO_JOB = jobView(jobStatus(null), () => '', NOW)
const jobOn = (key, fields) => jobView(jobStatus(key, fields), () => 'Marked for Later', NOW)
const BUSY = 'off for now: one job at a time, and Marked for Later is caching'

/** The rows with `job` turning their offline actions off, as the page has them; by id. */
function rowsWith(join, job, ctx = {}) {
  const jobOff = key => (job.key === null || !['running', 'waiting'].includes(job.state) ? null : key === job.key ? 'off while this list is caching' : BUSY)
  return rows(join, { ...IDLE, jobOff, ...ctx })
}

describe('the row\'s cells', () => {
  const tea = record('t3a', TEA, { title: 'Morning tea', type: 'search', entity: 'tea', filter: SLOW_BURN })
  const teaCopy = described('text-search:tea-kudos', 'text-search', TEA_BY_KUDOS, 'Works search: tea', { scrapedAt: 7_000 })
  const series = record('s3r', '/series/9991', { kind: 'series-works', title: 'Long haul' })
  const broken = record('br0', BROKEN, { kind: 'tag-works', title: 'Elsewhere' })
  const old = copy('tag-works:Coffee%20Shop%20AU')
  const theirs = described('marked-for-later:them', 'marked-for-later', '/users/them/readings?show=to-read', 'Marked for Later — them')
  const join = joinSavedLists(state([tracking(tea, DAY - 3), tracking(broken)], [tea, series, broken]), [teaCopy, old, theirs], 'me')
  const idle = rowsWith(join, NO_JOB)

  describe('statusCell', () => {
    test('a tracked list: since when, and what tracking means', () => {
      assert.deepEqual(statusCell(idle.t3a), {
        word: 'Tracked',
        detail: `since ${formatDay(DAY - 3)}`,
        tip: 'Tracked for your review: its new and updated works are gathered there. It does everything any other saved list does as well.',
        toggle: { kind: 'switch', title: 'Track this list for review' },
      })
    })

    test('a saved list: not tracked, and switching it on tracks it from today', () => {
      assert.deepEqual(statusCell(idle.s3r), {
        word: 'Saved',
        detail: 'not tracked',
        tip: 'Saved: kept, refreshed, cached and editable like any list, but not tracked for review. Switch it on to track it from today.',
        toggle: { kind: 'switch', title: 'Track this list for review, from today on' },
      })
    })

    test('with review off, the switch says why it is off', () => {
      const off = rows(join, { ...IDLE, review: false })
      assert.equal(statusCell(off.s3r).toggle.title, `Track this list for review, from today on — ${TRACK_OFF.review}`)
      assert.equal(statusCell(off.t3a).toggle.title, `Track this list for review — ${TRACK_OFF.review}`)
    })

    test('a list at no address on the archive is pending, its switch off with the reason', () => {
      assert.deepEqual(statusCell(idle.br0), {
        word: 'Tracked (pending)',
        detail: 'not an AO3 address',
        tip: 'Tracked, but waiting on you: its address isn\'t a page on AO3, so nothing from it can be reviewed. Remove it and track the list again from its page.',
        toggle: { kind: 'switch', title: `Track this list for review — ${TRACK_OFF.notArchive}` },
      })
      const untracked = rowsWith(joinSavedLists(state([], [broken]), []), NO_JOB).br0
      assert.equal(statusCell(untracked).word, 'Saved (pending)')
      assert.equal(statusCell(untracked).tip, 'Saved, but waiting on you: its address isn\'t a page on AO3, so it can\'t be tracked. Remove it, and keep the list again from its page.')
    })

    test('an undescribed copy waits on one visit, and has no switch at all, only why', () => {
      assert.deepEqual(statusCell(idle['copy:tag-works:Coffee%20Shop%20AU']), {
        word: 'Saved (pending)',
        detail: 'needs one visit',
        tip: 'Saved, but waiting on you: it was saved before the extension could fetch it again. Open it on AO3 and press its search button; until then it can\'t be refreshed or tracked.',
        toggle: { kind: 'none', title: 'Can\'t be tracked until it has been opened on AO3 once' },
      })
    })

    test('a list that isn\'t a search is saved, and can\'t be tracked', () => {
      assert.deepEqual(statusCell(idle['copy:marked-for-later:them']), {
        word: 'Saved',
        detail: 'not tracked',
        tip: 'Saved: kept, refreshed and cached like any list. Only a search, an uncommon tag or a series can be tracked for review.',
        toggle: { kind: 'none', title: 'Can\'t be tracked: only a search, an uncommon tag or a series can be' },
      })
    })
  })

  describe('cachingCell', () => {
    const { buckets } = figures(teaCopy.key)

    test('a copy: the bar, what of it is cached and its size, and how old it is, with its failures', () => {
      assert.deepEqual(cachingCell(idle.t3a, NO_JOB, NOW), {
        bar: bucketBar(buckets),
        line: `6 of 10 cached · ${formatBytes(buckets.bytes)}`,
        detail: `as of ${timeAgo(7_000, NOW)} · 1 failed`,
        muted: false,
        link: null,
      })
    })

    test('while its own job runs, it says so in place of how old it is', () => {
      const job = jobOn(teaCopy.key)
      assert.equal(cachingCell(rowsWith(join, job).t3a, job, NOW).detail, 'caching now')
      const refreshing = jobOn(teaCopy.key, { job: { ...jobStatus(teaCopy.key).job, steps: ['refreshing', 'caching'] } })
      assert.equal(cachingCell(rowsWith(join, refreshing).t3a, refreshing, NOW).detail, 'refreshing now')
      const downloading = jobOn(teaCopy.key, { job: { ...jobStatus(teaCopy.key).job, steps: ['exporting'] } })
      assert.equal(cachingCell(rowsWith(join, downloading).t3a, downloading, NOW).detail, 'downloading now', 'a Download\'s last stage, as its button says')
      const other = jobOn(old.key)
      assert.equal(cachingCell(rowsWith(join, other).t3a, other, NOW).detail, `as of ${timeAgo(7_000, NOW)} · 1 failed`)
    })

    test('with no copy: not cached, and a link that opens it on AO3, which keeps one', () => {
      assert.deepEqual(cachingCell(idle.s3r, NO_JOB, NOW), { bar: null, line: 'Not cached', detail: 'open it on AO3 to keep a copy', muted: true, link: '/series/9991#ao3e-open=s3r' })
    })

    test('every kind of list with no copy says so alike, and links its own open URL, a filtered listing\'s too', () => {
      const hp = record('hp', HP, { kind: 'works-filter', type: 'tag', entity: 'Harry Potter' })
      const tag = record('m4rr', TAG, { kind: 'tag-works' })
      const search = record('s34rch', TEA)
      const got = rows(joinSavedLists(state([tracking(hp)], [hp, tag, search]), []))
      for (const [id, page] of [['hp', HP], ['m4rr', TAG], ['s34rch', TEA]]) {
        const cell = cachingCell(got[id], NO_JOB, NOW)
        assert.deepEqual(cell, { bar: null, line: 'Not cached', detail: 'open it on AO3 to keep a copy', muted: true, link: `${page}#ao3e-open=${id}` }, id)
        assert.equal(cell.link, got[id].open, 'the row\'s open URL')
      }
    })

    test('a list at no address on the archive has no open URL, so nothing to link, and keeps its own words', () => {
      assert.deepEqual(cachingCell(idle.br0, NO_JOB, NOW), { bar: null, line: 'Not cached', detail: 'cache it from its page on AO3', muted: true, link: null })
    })
  })

  describe('rowAction', () => {
    test('a list with a copy offers Download, off while another list\'s job runs', () => {
      assert.deepEqual(rowAction(idle.t3a, NO_JOB), { kind: 'download', off: null })
      const other = jobOn(old.key)
      assert.deepEqual(rowAction(rowsWith(join, other).t3a, other), { kind: 'download', off: BUSY })
      assert.deepEqual(rowAction(idle['copy:tag-works:Coffee%20Shop%20AU'], NO_JOB), { kind: 'download', off: OFFLINE_OFF.undescribed })
    })

    test('Download becomes Stop while its own job runs, and leaves Continue to the job\'s line once it stops', () => {
      const running = jobOn(teaCopy.key)
      assert.deepEqual(rowAction(rowsWith(join, running).t3a, running), { kind: 'stop', verb: 'caching' })
      const downloading = jobOn(teaCopy.key, { job: { ...jobStatus(teaCopy.key).job, steps: ['exporting'] } })
      assert.deepEqual(rowAction(rowsWith(join, downloading).t3a, downloading), { kind: 'stop', verb: 'downloading' })
      const stopped = jobOn(teaCopy.key, { running: false })
      assert.deepEqual(rowAction(rowsWith(join, stopped).t3a, stopped), { kind: 'none' })
    })

    test('a list with no copy has nothing to download', () => {
      assert.deepEqual(rowAction(idle.s3r, NO_JOB), { kind: 'none' })
    })
  })
})

describe('the row\'s details', () => {
  const tea = record('t3a', TEA, { title: 'Morning tea', type: 'search', entity: 'tea', filter: SLOW_BURN })
  const teaCopy = described('text-search:tea-kudos', 'text-search', TEA_BY_KUDOS, 'Works search: tea', { scrapedAt: 7_000 })
  const series = record('s3r', '/series/9991', { kind: 'series-works', title: 'Long haul' })
  const join = joinSavedLists(state([tracking(tea, DAY - 3)], [tea, series]), [teaCopy])
  const idle = rowsWith(join, NO_JOB)
  const { buckets } = figures(teaCopy.key)
  const size = formatBytes(buckets.bytes)
  const keeps = `The 6 cached works (${size}) stay, since another list may be reading the same copies. Opening the list on AO3 again brings it straight back.`

  describe('offlineDetails', () => {
    test('a copy: its figures, what a retry would ask for, and what removing it does', () => {
      assert.deepEqual(offlineDetails(idle.t3a, NO_JOB, NOW, false), {
        summary: `10 works as of ${timeAgo(7_000, NOW)} · 6 cached (${size}) · 4 uncached · 1 failed · 4 need refreshing`,
        empty: null,
        note: null,
        off: null,
        retry: 3,
        cached: 6,
        remove: { off: null, note: `${blurbsOnRemove(false)} ${keeps}` },
      })
    })

    test('uncached is said only while some works were never fetched; the failed ones are counted on their own', () => {
      const failedOnly = rowsWith(join, NO_JOB, { copy: () => ({ buckets: { total: 10, cached: 8, failed: 2, unfetched: 0, bytes: 50, staleFailures: 0 }, unstored: 0 }) })
      assert.equal(offlineDetails(failedOnly.t3a, NO_JOB, NOW, false).summary, `10 works as of ${timeAgo(7_000, NOW)} · 8 cached (50 B) · 2 failed`)
    })

    test('with blurbs discarded automatically, removing says they go now', () => {
      assert.equal(offlineDetails(idle.t3a, NO_JOB, NOW, true).remove.note, `${blurbsOnRemove(true)} ${keeps}`)
    })

    test('another list\'s job turns the actions off, and says so where the reader is looking; removing stays on', () => {
      const job = jobOn('marked-for-later:tester')
      const got = offlineDetails(rowsWith(join, job).t3a, job, NOW, false)
      assert.equal(got.off, BUSY)
      assert.deepEqual(got.note, { severity: 'neutral', text: 'Off for now: one job at a time, and Marked for Later is caching.' })
      assert.equal(got.remove.off, null)
    })

    test('its own job turns its actions off, and removing it too', () => {
      const job = jobOn(teaCopy.key)
      const got = offlineDetails(rowsWith(join, job).t3a, job, NOW, false)
      assert.equal(got.off, 'off while this list is caching')
      assert.equal(got.remove.off, 'off while this list is caching')
    })

    test('a stopped job on it goes with the copy, which removing says', () => {
      const job = jobOn(teaCopy.key, { running: false })
      const got = offlineDetails(rowsWith(join, job).t3a, job, NOW, false)
      assert.equal(got.off, null)
      assert.equal(got.remove.off, null)
      assert.equal(got.remove.note, `${blurbsOnRemove(false)} ${keeps} Its stopped job is discarded with it.`)
    })

    test('a copy two lists share: removing it from one takes it from both, and says so', () => {
      const mine = record('m', TEA, { title: 'Mine' })
      const theirs = record('t', TEA_BY_KUDOS, { filter: SLOW_BURN, title: 'Theirs' })
      const shared = rowsWith(joinSavedLists(state([], [mine, theirs]), [teaCopy]), NO_JOB)
      assert.match(offlineDetails(shared.m, NO_JOB, NOW, false).remove.note, /“Theirs” shares this copy, and loses it too\.$/)
    })

    test('an undescribed copy: why its actions are off, as a warning, and nothing about cached works it has none of', () => {
      const old = copy('tag-works:Old%20Tag')
      const row = rowsWith(joinSavedLists(state([], []), [old]), NO_JOB, { copy: () => ({ buckets: { total: 94, cached: 0, failed: 0, unfetched: 94, bytes: 0, staleFailures: 0 }, unstored: 0 }) })['copy:tag-works:Old%20Tag']
      const got = offlineDetails(row, NO_JOB, NOW, false)
      assert.equal(got.summary, `94 works as of ${timeAgo(1_000, NOW)} · 0 cached (0 B) · 94 uncached`)
      assert.deepEqual(got.note, { severity: 'warning', text: NEEDS_VISIT_NOTE })
      assert.equal(got.off, OFFLINE_OFF.undescribed)
      assert.equal(got.remove.note, `${blurbsOnRemove(false)} Opening the list on AO3 again brings it straight back.`)
    })

    test('no copy: where one comes from, and nothing to remove', () => {
      const got = offlineDetails(idle.s3r, NO_JOB, NOW, false)
      assert.equal(got.summary, null)
      assert.equal(got.empty, 'None yet. Open it on AO3 to keep a copy: from then on, it refreshes from here.')
      assert.equal(got.remove, null)
    })

    test('a filtered listing with no copy: one comes from the same place', () => {
      const hp = record('hp', HP, { kind: 'works-filter', type: 'tag', entity: 'Harry Potter' })
      const got = offlineDetails(rows(joinSavedLists(state([], [hp]), [])).hp, NO_JOB, NOW, false)
      assert.equal(got.empty, 'None yet. Open it on AO3 to keep a copy: from then on, it refreshes from here.')
    })

    test('a list at no address on the archive, which can\'t be opened from here, keeps its own words', () => {
      const broken = record('br0', BROKEN, { kind: 'tag-works', title: 'Elsewhere' })
      const got = offlineDetails(rows(joinSavedLists(state([], [broken]), [])).br0, NO_JOB, NOW, false)
      assert.equal(got.empty, 'None yet. Open the list on AO3 and press the search button there: a copy is kept from then on, and refreshes from here.')
    })
  })

  describe('trackingDetails', () => {
    test('a tracked list: since when, what it searches, Stop tracking, and Remove list with what it takes', () => {
      assert.deepEqual(trackingDetails(idle.t3a, NO_JOB, false), {
        state: `Tracked since ${formatDay(DAY - 3)}. Its new and updated works turn up in your review.`,
        muted: false,
        what: 'Works search · Text: “slow burn”',
        problem: null,
        action: { kind: 'stop', off: null },
        remove: { off: null, note: `Forgets the list and its title, and stops tracking it. Its offline copy goes too. ${blurbsOnRemove(false)} Cached work text stays. To keep it without reviewing it, stop tracking it instead.` },
      })
      assert.equal(STOP_NOTE, 'It stays a Saved list, title and all. Tracking it again starts from that day, so anything it turns up in between is never reviewed.')
    })

    test('a saved list: tracking starts from today; with no copy, removing takes only the list', () => {
      assert.deepEqual(trackingDetails(idle.s3r, NO_JOB, false), {
        state: 'Not tracked. Tracking starts from today, so nothing from before it reaches the review.',
        muted: false,
        what: null,
        problem: null,
        action: { kind: 'track', off: null },
        remove: { off: null, note: 'Forgets the list and its title.' },
      })
      const withCopy = rowsWith(joinSavedLists(state([], [tea]), [teaCopy]), NO_JOB).t3a
      assert.equal(trackingDetails(withCopy, NO_JOB, false).state, 'Not tracked. Tracking starts from today: however many works the offline copy already holds, none of them reaches the review.')
    })

    test('with review off, tracking and stopping are off with the reason; removing isn\'t', () => {
      const off = rows(join, { ...IDLE, review: false })
      assert.deepEqual(trackingDetails(off.t3a, NO_JOB, false).action, { kind: 'stop', off: TRACK_OFF.review })
      assert.deepEqual(trackingDetails(off.s3r, NO_JOB, false).action, { kind: 'track', off: TRACK_OFF.review })
      assert.equal(trackingDetails(off.s3r, NO_JOB, false).remove.off, null)
    })

    test('a list two lists search: removing one leaves the copy to the other', () => {
      const mine = record('m', TEA, { title: 'Mine' })
      const theirs = record('t', TEA_BY_KUDOS, { filter: SLOW_BURN, title: 'Theirs' })
      const shared = rowsWith(joinSavedLists(state([], [mine, theirs]), [teaCopy]), NO_JOB)
      assert.equal(trackingDetails(shared.m, NO_JOB, false).remove.note, 'Forgets the list and its title. Its offline copy stays: “Theirs” searches the same thing.')
    })

    test('removing a list is off while its copy\'s own job runs', () => {
      const job = jobOn(teaCopy.key)
      assert.equal(trackingDetails(rowsWith(join, job).t3a, job, false).remove.off, 'off while this list is caching')
    })

    test('a list at no address on the archive: what is wrong, and only Remove list', () => {
      const broken = record('br0', BROKEN, { kind: 'tag-works', title: 'Elsewhere' })
      const row = rowsWith(joinSavedLists(state([tracking(broken)], [broken]), []), NO_JOB).br0
      assert.deepEqual(trackingDetails(row, NO_JOB, false), {
        state: null,
        muted: false,
        what: null,
        problem: NOT_ARCHIVE_NOTE,
        action: null,
        remove: { off: null, note: 'Forgets the list and its title. Its address isn\'t a page on AO3, so nothing was ever fetched for it.' },
      })
    })

    test('a copy with no record: why it can\'t be tracked, or Track this list for a search, and no Remove list', () => {
      const old = copy('tag-works:Old%20Tag')
      const theirs = described('marked-for-later:them', 'marked-for-later', '/users/them/readings?show=to-read', 'Marked for Later — them')
      const fresh = described('tag-works:marriage%20problems', 'tag-works', TAG, 'Uncommon tag — marriage problems')
      const got = rowsWith(joinSavedLists(state([], []), [old, theirs, fresh], 'me'), NO_JOB)
      assert.deepEqual(trackingDetails(got['copy:tag-works:Old%20Tag'], NO_JOB, false), {
        state: 'Can\'t be tracked until it has been opened on AO3 once — the same visit that lets it refresh.',
        muted: true,
        what: null,
        problem: null,
        action: null,
        remove: null,
      })
      assert.equal(trackingDetails(got['copy:marked-for-later:them'], NO_JOB, false).state, 'Can\'t be tracked: only a search, an uncommon tag or a series can be.')
      assert.deepEqual(trackingDetails(got['copy:tag-works:marriage%20problems'], NO_JOB, false).action, { kind: 'track', off: null })
      assert.equal(trackingDetails(got['copy:tag-works:marriage%20problems'], NO_JOB, false).remove, null)
    })
  })
})

describe('naming lists', () => {
  test('copyTitle: the title a stored copy\'s record will take, else its label, else its key', () => {
    assert.equal(copyTitle(described('tag-works:marriage%20problems', 'tag-works', TAG, 'Uncommon tag — marriage problems')), 'Tag: marriage problems')
    assert.equal(copyTitle(described('marked-for-later:them', 'marked-for-later', '/users/them/readings?show=to-read', 'Marked for Later — them')), 'Marked for Later — them')
    assert.equal(copyTitle(copy('tag-works:Old%20Tag')), 'tag-works:Old%20Tag')
  })

  test('describeList: by its title, and what it searches where the title doesn\'t say', () => {
    assert.equal(describeList({ id: 'm', alias: 'Mine', url: TEA }), '“Mine” (Search: tea)')
    assert.equal(describeList({ id: 'm', alias: 'Search: tea', url: TEA }), '“Search: tea”')
  })

  test('titleRefusal: names the list that has the title', () => {
    assert.equal(
      titleRefusal(record('lh', '/series/2947183', { kind: 'series-works', title: 'The Long Haul' })),
      'Another list is already called “The Long Haul” (Series: 2947183), so this title isn\'t saved. Choose a different one.',
    )
  })

  test('titlesInWords: one, two, or more titles, as a sentence names them', () => {
    assert.equal(titlesInWords(['A']), '“A”')
    assert.equal(titlesInWords(['A', 'B']), '“A” and “B”')
    assert.equal(titlesInWords(['A', 'B', 'C']), '“A”, “B” and “C”')
  })

  test('sameSearchNote: the other lists at the address, by title', () => {
    const mine = record('m', TEA, { title: 'Mine' })
    const theirs = record('t', TEA_BY_KUDOS, { filter: SLOW_BURN, title: 'Theirs' })
    assert.equal(sameSearchNote(rows(joinSavedLists(state([], [mine, theirs]), [])).m), 'Same search as “Theirs”')
    assert.equal(sameSearchNote(rows(joinSavedLists(state([], [mine]), [])).m), null)
  })
})
