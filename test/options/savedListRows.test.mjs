import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { joinSavedLists } from '../../src/common/savedLists.ts'
import { describeFilters, formatDay, TRACKED_TYPE_LABELS } from '../../src/common/trackedLists.ts'
import { bucketBar, formatBytes } from '../../src/options_ui/model/buckets.ts'
import { jobVerb, jobView, offReason } from '../../src/options_ui/model/jobView.ts'
import { timeAgo } from '../../src/options_ui/model/moments.ts'
import { REFRESH_OFF } from '../../src/options_ui/model/profileLists.ts'
import { blurbsOnRemove, cachingCell, COPY_REMOVAL, copyTitle, describeList, KIND_LABELS, LIST_REMOVAL, NEEDS_VISIT_NOTE, NO_COPY, NO_SWITCH, NOT_ARCHIVE_NOTE, NOT_ARCHIVE_STOP_NOTE, OFFLINE_OFF, offlineDetails, rowAction, rowJob, sameSearchNote, savedListRows, STATUS_DETAILS, STATUS_TIPS, STATUS_WORDS, statusCell, STOP_NOTE, titleRefusal, titlesInWords, TRACK_OFF, TRACKING_STATE, trackingDetails } from '../../src/options_ui/model/savedListRows.ts'
import { figures, mentions } from '../facts.mjs'

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
const holds = key => ({ buckets: { total: 10, cached: 6, failed: 1, unfetched: 3, bytes: key.length, staleFailures: 2 }, unstored: 5 })
const IDLE = { copy: holds, review: true, workMarks: true, jobOff: () => null }

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
      type: TRACKED_TYPE_LABELS.search,
      typeTip: 'Search: tea',
      kind: KIND_LABELS['text-search'],
      filters: describeFilters(tea),
      viewEdit: `${TEA}#ao3e-list=t3a`,
      open: `${TEA}#ao3e-open=t3a`,
      status: 'tracked',
      pending: null,
      since: DAY - 3,
      sharedTitle: false,
      sameAddressAs: [],
      caching: { kind: 'copy', key: teaCopy.key, keys: [teaCopy.key], ...holds(teaCopy.key), scrapedAt: 7_000 },
    })
  })

  test('a list\'s copies are every one at its address, newest first: an older sort order of its search is its too', () => {
    const teaOlder = described('text-search:tea', 'text-search', TEA, 'Works search: tea', { scrapedAt: 5_000 })
    const got = rows(joinSavedLists(state([], [tea]), [teaOlder, teaCopy]))
    assert.equal(got.t3a.caching.key, teaCopy.key, 'its figures are the newest copy\'s')
    assert.deepEqual(got.t3a.caching.keys, [teaCopy.key, teaOlder.key])
    assert.deepEqual(Object.keys(got), ['t3a'], 'and no copy is a row of its own')
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

  test('a list at no address on the archive is pending, with no links; tracked, its toggle can stop it, but never start it again', () => {
    const broken = record('br0', BROKEN, { kind: 'tag-works', title: 'Elsewhere' })
    const got = rows(joinSavedLists(state([tracking(broken)], [broken]), [])).br0
    assert.equal(got.status, 'tracked')
    assert.equal(got.pending, 'not-archive')
    assert.equal(got.viewEdit, undefined)
    assert.equal(got.open, undefined)
    assert.equal(got.trackOff, undefined, 'its switch is live, to stop it syncing')
    assert.equal(got.titleEditable, true, 'it can still be titled, and removed')

    const saved = rows(joinSavedLists(state([], [broken]), [])).br0
    assert.equal(saved.status, 'saved')
    assert.equal(saved.pending, 'not-archive')
    assert.equal(saved.trackOff, TRACK_OFF.notArchive)
  })

  test('with review off, every toggle is off with that reason, and the offline copy is untouched', () => {
    const series = record('s3r', '/series/9991', { kind: 'series-works' })
    const broken = record('br0', BROKEN, { kind: 'tag-works', title: 'Elsewhere' })
    const got = rows(joinSavedLists(state([tracking(tea), tracking(broken)], [tea, series, broken]), [teaCopy]), { ...IDLE, review: false })
    assert.equal(got.t3a.trackOff, TRACK_OFF.review)
    assert.equal(got.s3r.trackOff, TRACK_OFF.review)
    assert.equal(got.br0.trackOff, TRACK_OFF.review, 'a tracked list at no address on the archive too')
    assert.equal(got.t3a.offlineOff, undefined)
  })

  test('a job turns off the offline actions of every row with a copy, with its reason', () => {
    const busy = 'off for now: one job at a time, and Marked for Later is caching'
    const series = record('s3r', '/series/9991', { kind: 'series-works' })
    const got = rows(joinSavedLists(state([], [tea, series]), [teaCopy]), { ...IDLE, jobOff: keys => (keys.includes(teaCopy.key) ? busy : null) })
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
      caching: { kind: 'copy', key: old.key, keys: [old.key], ...holds(old.key), scrapedAt: 1_000 },
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
    assert.equal(got.type, TRACKED_TYPE_LABELS.tag)
    assert.equal(got.kind, KIND_LABELS['tag-works'])
  })

  test('a filtered listing\'s copy not yet given its record tracks like any search, and its saved list reads it once filed', () => {
    const at = '/works?work_search[sort_column]=title&tag_id=Bees'
    const fresh = described('works-filter:/tags/Bees/works', 'works-filter', at, 'Tag: Bees')
    const got = rows(joinSavedLists(state([], []), [fresh]))['copy:works-filter:/tags/Bees/works']
    assert.equal(got.title, 'Tag: Bees')
    assert.equal(got.pending, null)
    assert.equal(got.trackOff, undefined)
    assert.equal(got.open, undefined)
    assert.equal(got.type, TRACKED_TYPE_LABELS.tag)
    assert.equal(got.kind, KIND_LABELS['works-filter'])

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
  test('says one thing with Discard unneeded blurbs automatically on, and another with it off', () => {
    assert.ok(blurbsOnRemove(true))
    assert.ok(blurbsOnRemove(false))
    assert.notEqual(blurbsOnRemove(true), blurbsOnRemove(false))
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
const OTHER = 'Marked for Later'
const NO_JOB = jobView(jobStatus(null), () => '', NOW)
const jobOn = (key, fields) => jobView(jobStatus(key, fields), () => OTHER, NOW)

/** A reason that is another list's job: it names that list. */
const othersJob = off => typeof off === 'string' && mentions(off, OTHER)
/** A reason that is the row's own job: it says what the job is doing, and names no other list. */
const ownJob = (off, job) => typeof off === 'string' && mentions(off, jobVerb(job)) && !mentions(off, OTHER)

/** The rows with `job` turning their offline actions off, as the page has them; by id. */
function rowsWith(join, job, ctx = {}) {
  return rows(join, { ...IDLE, jobOff: keys => offReason(job, keys), ...ctx })
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
    /** The cell, with only what its switch is: its tooltip is checked where it gives a reason. */
    const status = ({ toggle, ...cell }) => ({ ...cell, toggle: toggle.kind })

    test('a tracked list: since when, and what tracking means', () => {
      const cell = statusCell(idle.t3a)
      assert.ok(mentions(cell.detail, formatDay(DAY - 3)), cell.detail)
      assert.deepEqual(status({ ...cell, detail: null }), { word: STATUS_WORDS.tracked, detail: null, tip: STATUS_TIPS.tracked, toggle: 'switch' })
    })

    test('a saved list: not tracked, and switching it on tracks it from today', () => {
      assert.deepEqual(status(statusCell(idle.s3r)), { word: STATUS_WORDS.saved, detail: STATUS_DETAILS.notTracked, tip: STATUS_TIPS.saved, toggle: 'switch' })
    })

    test('with review off, the switch says why it is off', () => {
      const off = rows(join, { ...IDLE, review: false })
      assert.ok(mentions(statusCell(off.s3r).toggle.title, TRACK_OFF.review))
      assert.ok(mentions(statusCell(off.t3a).toggle.title, TRACK_OFF.review))
      assert.ok(!mentions(statusCell(idle.t3a).toggle.title, TRACK_OFF.review), 'and not while it is on')
    })

    test('a list at no address on the archive is pending; tracked, its switch can stop it; saved, it is off with the reason', () => {
      assert.deepEqual(status(statusCell(idle.br0)), { word: STATUS_WORDS.trackedPending, detail: STATUS_DETAILS.notArchive, tip: STATUS_TIPS.trackedNotArchive, toggle: 'switch' })
      const untracked = statusCell(rowsWith(joinSavedLists(state([], [broken]), []), NO_JOB).br0)
      assert.deepEqual(status(untracked), { word: STATUS_WORDS.savedPending, detail: STATUS_DETAILS.notArchive, tip: STATUS_TIPS.savedNotArchive, toggle: 'switch' })
      assert.ok(mentions(untracked.toggle.title, TRACK_OFF.notArchive))
    })

    test('an undescribed copy waits on one visit, and has no switch at all, only why', () => {
      assert.deepEqual(statusCell(idle['copy:tag-works:Coffee%20Shop%20AU']), {
        word: STATUS_WORDS.savedPending,
        detail: STATUS_DETAILS.needsVisit,
        tip: STATUS_TIPS.needsVisit,
        toggle: { kind: 'none', title: NO_SWITCH.needsVisit },
      })
    })

    test('a list that isn\'t a search is saved, and can\'t be tracked', () => {
      assert.deepEqual(statusCell(idle['copy:marked-for-later:them']), {
        word: STATUS_WORDS.saved,
        detail: STATUS_DETAILS.notTracked,
        tip: STATUS_TIPS.notSearch,
        toggle: { kind: 'none', title: NO_SWITCH.notSearch },
      })
    })
  })

  describe('cachingCell', () => {
    const { buckets } = holds(teaCopy.key)
    const age = timeAgo(7_000, NOW)

    test('a copy: the bar, what of it is cached and its size, and how old it is, with its failures', () => {
      const cell = cachingCell(idle.t3a, NO_JOB, NOW)
      assert.deepEqual({ ...cell, line: null, detail: null }, { bar: bucketBar(buckets), line: null, detail: null, muted: false, link: null })
      assert.deepEqual(figures(cell.line, formatBytes(buckets.bytes)), [6, 10], 'cached, of how many')
      assert.deepEqual(figures(cell.detail, age), [1], 'and how many failed')
    })

    test('while its own job runs, it says so in place of how old it is', () => {
      const says = (job) => {
        const { detail } = cachingCell(rowsWith(join, job).t3a, job, NOW)
        return { doing: mentions(detail, jobVerb(job)), age: mentions(detail, age) }
      }
      assert.deepEqual(says(jobOn(teaCopy.key)), { doing: true, age: false })
      assert.deepEqual(says(jobOn(teaCopy.key, { job: { ...jobStatus(teaCopy.key).job, steps: ['refreshing', 'caching'] } })), { doing: true, age: false })
      assert.deepEqual(says(jobOn(teaCopy.key, { job: { ...jobStatus(teaCopy.key).job, steps: ['exporting'] } })), { doing: true, age: false }, 'a Download\'s last stage, as its button says')
      const other = jobOn(old.key)
      assert.equal(cachingCell(rowsWith(join, other).t3a, other, NOW).detail, cachingCell(idle.t3a, NO_JOB, NOW).detail, 'another list\'s job changes nothing here')
    })

    test('with no copy: not cached, and a link that opens it on AO3, which keeps one', () => {
      const { bar, muted, link } = cachingCell(idle.s3r, NO_JOB, NOW)
      assert.deepEqual({ bar, muted, link }, { bar: null, muted: true, link: '/series/9991#ao3e-open=s3r' })
    })

    test('every kind of list with no copy says so alike, and links its own open URL, a filtered listing\'s too', () => {
      const hp = record('hp', HP, { kind: 'works-filter', type: 'tag', entity: 'Harry Potter' })
      const tag = record('m4rr', TAG, { kind: 'tag-works' })
      const search = record('s34rch', TEA)
      const got = rows(joinSavedLists(state([tracking(hp)], [hp, tag, search]), []))
      const series = cachingCell(idle.s3r, NO_JOB, NOW)
      for (const [id, page] of [['hp', HP], ['m4rr', TAG], ['s34rch', TEA]]) {
        const cell = cachingCell(got[id], NO_JOB, NOW)
        assert.deepEqual(cell, { ...series, link: `${page}#ao3e-open=${id}` }, id)
        assert.equal(cell.link, got[id].open, 'the row\'s open URL')
      }
    })

    test('a list at no address on the archive has no open URL, so nothing to link, and keeps its own words', () => {
      const cell = cachingCell(idle.br0, NO_JOB, NOW)
      const linked = cachingCell(idle.s3r, NO_JOB, NOW)
      assert.deepEqual({ ...cell, detail: null }, { ...linked, detail: null, link: null })
      assert.notEqual(cell.detail, linked.detail, 'it can\'t point at a link it hasn\'t')
    })
  })

  describe('rowAction', () => {
    test('a list with a copy offers Download, off while another list\'s job runs', () => {
      assert.deepEqual(rowAction(idle.t3a, NO_JOB), { kind: 'download', off: null })
      const other = jobOn(old.key)
      const busy = rowAction(rowsWith(join, other).t3a, other)
      assert.equal(busy.kind, 'download')
      assert.ok(othersJob(busy.off), busy.off)
      assert.deepEqual(rowAction(idle['copy:tag-works:Coffee%20Shop%20AU'], NO_JOB), { kind: 'download', off: OFFLINE_OFF.undescribed })
    })

    test('Download becomes Stop while its own job runs, and leaves Continue to the job\'s line once it stops', () => {
      const running = jobOn(teaCopy.key)
      assert.deepEqual(rowAction(rowsWith(join, running).t3a, running), { kind: 'stop', verb: jobVerb(running) })
      const downloading = jobOn(teaCopy.key, { job: { ...jobStatus(teaCopy.key).job, steps: ['exporting'] } })
      assert.deepEqual(rowAction(rowsWith(join, downloading).t3a, downloading), { kind: 'stop', verb: jobVerb(downloading) })
      assert.notEqual(jobVerb(downloading), jobVerb(running), 'each says what its job is doing')
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
  const { buckets } = holds(teaCopy.key)
  const size = formatBytes(buckets.bytes)
  const age = timeAgo(7_000, NOW)

  /** What Remove offline copy says of a copy with cached works: what goes of its blurbs, that its 6 cached works stay, and how to get it back. */
  function removesCopy(note, prune) {
    assert.ok(mentions(note, blurbsOnRemove(prune)), note)
    assert.deepEqual(figures(note, size), [6], 'the cached works that stay')
    assert.ok(mentions(note, COPY_REMOVAL.reopens), note)
  }

  describe('offlineDetails', () => {
    test('a copy: its figures, what a retry would ask for, and what removing it does', () => {
      const got = offlineDetails(idle.t3a, NO_JOB, NOW, false)
      assert.deepEqual({ ...got, summary: null, remove: null }, {
        summary: null,
        empty: null,
        note: null,
        off: null,
        refreshOff: null,
        refreshNote: null,
        retry: 3,
        cached: 6,
        remove: null,
      })
      // Its works, cached, uncached, failed, and needing a refresh.
      assert.deepEqual(figures(got.summary, age, size), [1, 4, 5, 6, 10])
      assert.equal(got.remove.off, null)
      removesCopy(got.remove.note, false)
      assert.ok(!mentions(got.remove.note, COPY_REMOVAL.discardsJob), 'no job to discard')
    })

    test('uncached is said only while some works were never fetched; the failed ones are counted on their own', () => {
      const failedOnly = rowsWith(join, NO_JOB, { copy: () => ({ buckets: { total: 10, cached: 8, failed: 2, unfetched: 0, bytes: 50, staleFailures: 0 }, unstored: 0 }) })
      assert.deepEqual(figures(offlineDetails(failedOnly.t3a, NO_JOB, NOW, false).summary, age, formatBytes(50)), [2, 8, 10])
    })

    test('with blurbs discarded automatically, removing says they go now', () => {
      removesCopy(offlineDetails(idle.t3a, NO_JOB, NOW, true).remove.note, true)
    })

    test('another list\'s job turns the actions off, and says so where the reader is looking; removing stays on', () => {
      const job = jobOn('marked-for-later:tester')
      const got = offlineDetails(rowsWith(join, job).t3a, job, NOW, false)
      assert.ok(othersJob(got.off), got.off)
      assert.equal(got.note.severity, 'neutral')
      assert.ok(mentions(got.note.text, got.off), got.note.text)
      assert.equal(got.remove.off, null)
    })

    test('its own job turns its actions off, and removing it too', () => {
      const job = jobOn(teaCopy.key)
      const got = offlineDetails(rowsWith(join, job).t3a, job, NOW, false)
      assert.ok(ownJob(got.off, job), got.off)
      assert.equal(got.remove.off, got.off)
    })

    test('a stopped job on it goes with the copy, which removing says', () => {
      const job = jobOn(teaCopy.key, { running: false })
      const got = offlineDetails(rowsWith(join, job).t3a, job, NOW, false)
      assert.equal(got.off, null)
      assert.equal(got.remove.off, null)
      removesCopy(got.remove.note, false)
      assert.ok(mentions(got.remove.note, COPY_REMOVAL.discardsJob), got.remove.note)
    })

    test('a copy two lists share: removing it from one takes it from both, and says so', () => {
      const mine = record('m', TEA, { title: 'Mine' })
      const theirs = record('t', TEA_BY_KUDOS, { filter: SLOW_BURN, title: 'Theirs' })
      const shared = rowsWith(joinSavedLists(state([], [mine, theirs]), [teaCopy]), NO_JOB)
      assert.ok(mentions(offlineDetails(shared.m, NO_JOB, NOW, false).remove.note, 'Theirs'))
      assert.ok(!mentions(offlineDetails(idle.t3a, NO_JOB, NOW, false).remove.note, 'Theirs'), 'and only then')
    })

    test('an undescribed copy: why its actions are off, as a warning, and nothing about cached works it has none of', () => {
      const old = copy('tag-works:Old%20Tag')
      const row = rowsWith(joinSavedLists(state([], []), [old]), NO_JOB, { copy: () => ({ buckets: { total: 94, cached: 0, failed: 0, unfetched: 94, bytes: 0, staleFailures: 0 }, unstored: 0 }) })['copy:tag-works:Old%20Tag']
      const got = offlineDetails(row, NO_JOB, NOW, false)
      assert.deepEqual(figures(got.summary, timeAgo(1_000, NOW), formatBytes(0)), [0, 94, 94], 'its works, none cached, all uncached')
      assert.deepEqual(got.note, { severity: 'warning', text: NEEDS_VISIT_NOTE })
      assert.equal(got.off, OFFLINE_OFF.undescribed)
      assert.ok(mentions(got.remove.note, blurbsOnRemove(false)))
      assert.ok(mentions(got.remove.note, COPY_REMOVAL.reopens))
      assert.deepEqual(figures(got.remove.note), [], 'no cached works to say stay')
    })

    test('no copy: where one comes from, and nothing to remove', () => {
      const got = offlineDetails(idle.s3r, NO_JOB, NOW, false)
      assert.equal(got.summary, null)
      assert.equal(got.empty, NO_COPY.opens)
      assert.equal(got.remove, null)
    })

    test('a filtered listing with no copy: one comes from the same place', () => {
      const hp = record('hp', HP, { kind: 'works-filter', type: 'tag', entity: 'Harry Potter' })
      const got = offlineDetails(rows(joinSavedLists(state([], [hp]), [])).hp, NO_JOB, NOW, false)
      assert.equal(got.empty, NO_COPY.opens)
    })

    test('a list at no address on the archive, which can\'t be opened from here, keeps its own words', () => {
      const broken = record('br0', BROKEN, { kind: 'tag-works', title: 'Elsewhere' })
      const got = offlineDetails(rows(joinSavedLists(state([], [broken]), [])).br0, NO_JOB, NOW, false)
      assert.equal(got.empty, NO_COPY.elsewhere)
    })
  })

  describe('trackingDetails', () => {
    test('a tracked list: since when, what it searches, Stop tracking, and Remove list with what it takes', () => {
      const got = trackingDetails(idle.t3a, NO_JOB, false)
      assert.deepEqual({ ...got, state: null, what: null, remove: null }, {
        state: null,
        muted: false,
        what: null,
        problem: null,
        action: { kind: 'stop', off: null, note: STOP_NOTE },
        remove: null,
      })
      assert.ok(mentions(got.state, formatDay(DAY - 3)), got.state)
      assert.ok(mentions(got.what, KIND_LABELS['text-search']) && mentions(got.what, describeFilters(tea).text), got.what)
      assert.equal(got.remove.off, null)
      for (const fact of [LIST_REMOVAL.forgetsTracked, LIST_REMOVAL.copyGoes, blurbsOnRemove(false), LIST_REMOVAL.textStays, LIST_REMOVAL.stopInstead])
        assert.ok(mentions(got.remove.note, fact), fact)
    })

    test('a saved list: tracking starts from today; with no copy, removing takes only the list', () => {
      assert.deepEqual(trackingDetails(idle.s3r, NO_JOB, false), {
        state: TRACKING_STATE.notTracked,
        muted: false,
        what: null,
        problem: null,
        action: { kind: 'track', off: null, note: null },
        remove: { off: null, note: LIST_REMOVAL.forgets },
      })
      const withCopy = rowsWith(joinSavedLists(state([], [tea]), [teaCopy]), NO_JOB).t3a
      assert.equal(trackingDetails(withCopy, NO_JOB, false).state, TRACKING_STATE.notTrackedWithCopy)
    })

    test('with review off, tracking and stopping are off with the reason; removing isn\'t', () => {
      const off = rows(join, { ...IDLE, review: false })
      assert.deepEqual(trackingDetails(off.t3a, NO_JOB, false).action, { kind: 'stop', off: TRACK_OFF.review, note: STOP_NOTE })
      assert.deepEqual(trackingDetails(off.s3r, NO_JOB, false).action, { kind: 'track', off: TRACK_OFF.review, note: null })
      assert.equal(trackingDetails(off.s3r, NO_JOB, false).remove.off, null)
    })

    test('a list two lists search: removing one leaves the copy to the other', () => {
      const mine = record('m', TEA, { title: 'Mine' })
      const theirs = record('t', TEA_BY_KUDOS, { filter: SLOW_BURN, title: 'Theirs' })
      const shared = rowsWith(joinSavedLists(state([], [mine, theirs]), [teaCopy]), NO_JOB)
      const { note } = trackingDetails(shared.m, NO_JOB, false).remove
      assert.ok(mentions(note, LIST_REMOVAL.forgets), note)
      assert.ok(mentions(note, 'Theirs'), 'naming the list that keeps it')
      assert.ok(!mentions(note, LIST_REMOVAL.copyGoes), note)
    })

    test('removing a list is off while its copy\'s own job runs', () => {
      const job = jobOn(teaCopy.key)
      const { off } = trackingDetails(rowsWith(join, job).t3a, job, false).remove
      assert.ok(ownJob(off, job), off)
    })

    test('a list at no address on the archive: what is wrong, and Remove list; tracked, Stop tracking too, which can\'t be taken back', () => {
      const broken = record('br0', BROKEN, { kind: 'tag-works', title: 'Elsewhere' })
      const row = rowsWith(joinSavedLists(state([tracking(broken)], [broken]), []), NO_JOB).br0
      const got = trackingDetails(row, NO_JOB, false)
      assert.deepEqual({ ...got, remove: null }, {
        state: null,
        muted: false,
        what: null,
        problem: NOT_ARCHIVE_NOTE,
        action: { kind: 'stop', off: null, note: NOT_ARCHIVE_STOP_NOTE },
        remove: null,
      })
      assert.equal(got.remove.off, null)
      assert.ok(mentions(got.remove.note, LIST_REMOVAL.forgetsTracked) && mentions(got.remove.note, LIST_REMOVAL.neverFetched), got.remove.note)

      const off = rows(joinSavedLists(state([tracking(broken)], [broken]), []), { ...IDLE, review: false }).br0
      assert.deepEqual(trackingDetails(off, NO_JOB, false).action, { kind: 'stop', off: TRACK_OFF.review, note: NOT_ARCHIVE_STOP_NOTE }, 'off with Tracked lists, as every switch is')

      const saved = trackingDetails(rowsWith(joinSavedLists(state([], [broken]), []), NO_JOB).br0, NO_JOB, false)
      assert.deepEqual({ ...saved, remove: null }, { state: null, muted: false, what: null, problem: NOT_ARCHIVE_NOTE, action: null, remove: null })
      assert.equal(saved.remove.off, null)
      assert.ok(mentions(saved.remove.note, LIST_REMOVAL.forgets) && mentions(saved.remove.note, LIST_REMOVAL.neverFetched), saved.remove.note)
    })

    test('a copy with no record: why it can\'t be tracked, or Track this list for a search, and no Remove list', () => {
      const old = copy('tag-works:Old%20Tag')
      const theirs = described('marked-for-later:them', 'marked-for-later', '/users/them/readings?show=to-read', 'Marked for Later — them')
      const fresh = described('tag-works:marriage%20problems', 'tag-works', TAG, 'Uncommon tag — marriage problems')
      const got = rowsWith(joinSavedLists(state([], []), [old, theirs, fresh], 'me'), NO_JOB)
      assert.deepEqual(trackingDetails(got['copy:tag-works:Old%20Tag'], NO_JOB, false), {
        state: TRACKING_STATE.needsVisit,
        muted: true,
        what: null,
        problem: null,
        action: null,
        remove: null,
      })
      assert.equal(trackingDetails(got['copy:marked-for-later:them'], NO_JOB, false).state, TRACKING_STATE.notSearch)
      assert.deepEqual(trackingDetails(got['copy:tag-works:marriage%20problems'], NO_JOB, false).action, { kind: 'track', off: null, note: null })
      assert.equal(trackingDetails(got['copy:tag-works:marriage%20problems'], NO_JOB, false).remove, null)
    })
  })
})

/**
 * One search stored in two sort orders: the row shows the newer copy, and a
 * job started on the older, before the newer was stored, is the row's all the
 * same. It is reading and writing one of the copies a removal would take.
 */
describe('a job on an older sort order of a list\'s search', () => {
  const tea = record('t3a', TEA, { title: 'Morning tea', type: 'search', entity: 'tea' })
  const teaCopy = described('text-search:tea-kudos', 'text-search', TEA_BY_KUDOS, 'Works search: tea', { scrapedAt: 7_000 })
  const teaOlder = described('text-search:tea', 'text-search', TEA, 'Works search: tea', { scrapedAt: 5_000 })
  const series = record('s3r', '/series/9991', { kind: 'series-works', title: 'Long haul' })
  const seriesCopy = described('series-works:9991', 'series-works', '/series/9991', 'Series: Long haul', { scrapedAt: 6_000 })
  const join = joinSavedLists(state([], [tea, series]), [teaCopy, teaOlder, seriesCopy])
  const running = jobOn(teaOlder.key)
  const stopped = jobOn(teaOlder.key, { running: false })

  test('is the row\'s while it runs: its actions off as its own, Download become Stop, and its caching says so', () => {
    const row = rowsWith(join, running).t3a
    assert.ok(ownJob(row.offlineOff, running), row.offlineOff)
    assert.deepEqual(rowAction(row, running), { kind: 'stop', verb: jobVerb(running) })
    assert.ok(mentions(cachingCell(row, running, NOW).detail, jobVerb(running)))
    assert.deepEqual(rowJob(row, running), { actions: 'stop', off: null, here: true }, 'its line is under the row')
  })

  test('neither removal can take a copy from under it', () => {
    const row = rowsWith(join, running).t3a
    assert.ok(ownJob(offlineDetails(row, running, NOW, false).remove.off, running))
    assert.ok(ownJob(trackingDetails(row, running, false).remove.off, running))
  })

  test('stopped, its line is the row\'s, with Continue and Discard, and removing the copy discards it too', () => {
    const row = rowsWith(join, stopped).t3a
    assert.deepEqual(rowJob(row, stopped), { actions: 'resume', off: null, here: true })
    assert.deepEqual(rowAction(row, stopped), { kind: 'none' })
    assert.ok(mentions(offlineDetails(row, stopped, NOW, false).remove.note, COPY_REMOVAL.discardsJob))
    assert.equal(offlineDetails(row, stopped, NOW, false).remove.off, null)
  })

  test('to every other row it is another list\'s job', () => {
    const row = rowsWith(join, running).s3r
    assert.ok(othersJob(row.offlineOff), row.offlineOff)
    assert.deepEqual(rowJob(row, running), { actions: 'offline', off: row.offlineOff, here: false })
    assert.equal(offlineDetails(row, running, NOW, false).remove.off, null)
    assert.equal(trackingDetails(row, running, false).remove.off, null)
  })

  test('a row with no copy has no job of its own', () => {
    const bare = rowsWith(joinSavedLists(state([], [tea]), []), running).t3a
    assert.equal(rowJob(bare, running), null)
  })
})

/**
 * Read works is the works the reader's marks name, so with Work marks off a
 * refresh finds none of them and would store the list empty. Another account's
 * copy is a row, whose controls that refresh first are off, saying why; what
 * works from the copy as it is stays on.
 */
describe('another account\'s Read works, with Work marks off', () => {
  const theirRead = described('read-works:them', 'read-works', '/users/them/readings', 'Read works — them')
  const theirMarked = described('marked-for-later:them', 'marked-for-later', '/users/them/readings?show=to-read', 'Marked for Later — them')
  const join = joinSavedLists(state([], []), [theirRead, theirMarked], 'me')
  const READ_ROW = 'copy:read-works:them'
  const MARKED_ROW = 'copy:marked-for-later:them'
  const marksOff = (job = NO_JOB) => rowsWith(join, job, { workMarks: false })
  /** A neutral note that gives `reason`, where the reader is looking. */
  const notes = (note, reason) => note?.severity === 'neutral' && mentions(note.text, reason)

  test('the row says the list needs Work marks to be refreshed; nothing else of it is off', () => {
    const row = marksOff()[READ_ROW]
    assert.equal(row.refreshNeeds, REFRESH_OFF.workMarks)
    assert.equal(row.offlineOff, undefined)
    assert.equal(row.trackOff, TRACK_OFF.notSearch, 'it is no more trackable than before')
  })

  test('with Work marks on, or for a list made from no marks, there is nothing to say', () => {
    assert.equal(rowsWith(join, NO_JOB)[READ_ROW].refreshNeeds, undefined)
    assert.equal(marksOff()[MARKED_ROW].refreshNeeds, undefined)
  })

  test('Download, which refreshes first, is off with that reason', () => {
    assert.deepEqual(rowAction(marksOff()[READ_ROW], NO_JOB), { kind: 'download', off: REFRESH_OFF.workMarks })
    assert.deepEqual(rowAction(marksOff()[MARKED_ROW], NO_JOB), { kind: 'download', off: null })
  })

  test('the details turn off Refresh list, Download and Refresh the list first, saying why where the reader is looking; Cache works, the retry, Download without refreshing and Remove offline copy stay on', () => {
    const got = offlineDetails(marksOff()[READ_ROW], NO_JOB, NOW, false)
    assert.equal(got.refreshOff, REFRESH_OFF.workMarks)
    assert.ok(notes(got.refreshNote, REFRESH_OFF.workMarks), JSON.stringify(got.refreshNote))
    assert.equal(got.off, null)
    assert.equal(got.note, null)
    assert.equal(got.remove.off, null)
  })

  test('another list\'s job turns the rest off too, and the refresh keeps its own reason, which outlasts the job', () => {
    const other = jobOn('tag-works:Coffee%20Shop%20AU')
    const row = marksOff(other)[READ_ROW]
    assert.ok(othersJob(row.offlineOff), row.offlineOff)
    assert.deepEqual(rowAction(row, other), { kind: 'download', off: REFRESH_OFF.workMarks })
    const got = offlineDetails(row, other, NOW, false)
    assert.equal(got.off, row.offlineOff)
    assert.equal(got.refreshOff, REFRESH_OFF.workMarks)
    assert.ok(notes(got.note, row.offlineOff), JSON.stringify(got.note))
    assert.ok(notes(got.refreshNote, REFRESH_OFF.workMarks), JSON.stringify(got.refreshNote))
  })

  test('with Work marks on, a job is the refresh\'s only reason, as it is every other action\'s', () => {
    const other = jobOn('tag-works:Coffee%20Shop%20AU')
    const row = rowsWith(join, other)[READ_ROW]
    const action = rowAction(row, other)
    assert.equal(action.kind, 'download')
    assert.ok(othersJob(action.off), action.off)
    const got = offlineDetails(row, other, NOW, false)
    assert.equal(got.refreshOff, action.off)
    assert.equal(got.refreshNote, null)
  })
})

describe('naming lists', () => {
  test('copyTitle: the title a stored copy\'s record will take, else its label, else its key', () => {
    assert.equal(copyTitle(described('tag-works:marriage%20problems', 'tag-works', TAG, 'Uncommon tag — marriage problems')), 'Tag: marriage problems')
    assert.equal(copyTitle(described('marked-for-later:them', 'marked-for-later', '/users/them/readings?show=to-read', 'Marked for Later — them')), 'Marked for Later — them')
    assert.equal(copyTitle(copy('tag-works:Old%20Tag')), 'tag-works:Old%20Tag')
  })

  test('describeList: by its title, and what it searches where the title doesn\'t say', () => {
    const mine = describeList({ id: 'm', alias: 'Mine', url: TEA })
    assert.ok(mentions(mine, 'Mine') && mentions(mine, 'Search: tea'), mine)
    const plain = describeList({ id: 'm', alias: 'Search: tea', url: TEA })
    assert.equal(plain.split('Search: tea').length - 1, 1, `named once: ${plain}`)
  })

  test('titleRefusal: names the list that has the title', () => {
    const refusal = titleRefusal(record('lh', '/series/2947183', { kind: 'series-works', title: 'The Long Haul' }))
    assert.ok(mentions(refusal, 'The Long Haul') && mentions(refusal, 'Series: 2947183'), refusal)
  })

  test('titlesInWords: one, two, or more titles, in order', () => {
    assert.ok(mentions(titlesInWords(['Alpha']), 'Alpha'))
    for (const titles of [['Alpha', 'Beta'], ['Alpha', 'Beta', 'Gamma']]) {
      const words = titlesInWords(titles)
      const places = titles.map(title => words.indexOf(title))
      assert.ok(places.every((place, i) => place >= 0 && (i === 0 || place > places[i - 1])), words)
    }
  })

  test('sameSearchNote: the other lists at the address, by title', () => {
    const mine = record('m', TEA, { title: 'Mine' })
    const theirs = record('t', TEA_BY_KUDOS, { filter: SLOW_BURN, title: 'Theirs' })
    assert.ok(mentions(sameSearchNote(rows(joinSavedLists(state([], [mine, theirs]), [])).m), 'Theirs'))
    assert.equal(sameSearchNote(rows(joinSavedLists(state([], [mine]), [])).m), null)
  })
})
