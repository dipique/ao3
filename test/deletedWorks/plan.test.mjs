import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { deletedEntryFacts, isReadingsListing, planDeleted, readingFacts } from '../../src/common/deletedWorks.ts'

const NOW = Date.UTC(2026, 10, 23)

/** A readings page's "Deleted work" entry, as AO3 serves it. */
const entryHtml = (reading, visited) => `<li class="deleted reading work blurb group" role="article">
  <div class="user module group">
    <h4 class="viewed heading">
        (Deleted work, last visited ${visited})
    </h4>
    <ul class="actions">
      <li>
        <form class="ajax-remove" action="/users/someone/readings/${reading}?page=36" accept-charset="UTF-8" method="post"><input type="hidden" name="_method" value="delete"><input type="hidden" name="authenticity_token" value="tok">
          <input type="hidden" name="reading" id="reading" value="${reading}" class="text">
          <input type="submit" name="commit" value="Delete from History">
</form>      </li>
    </ul>
  </div>
</li>`

/** The block a list keeps for one of its works, as `normalizeBlurb` leaves it. */
const ctxHtml = (visited, reading) => `<div class="user module group"${reading ? ` data-reading="${reading}"` : ''}>
    <h4 class="viewed heading">
      <span>Last visited:</span> ${visited} (Latest version.)
      Visited 5 times
      (Marked for Later.)
    </h4>
    <ul class="actions"></ul>
  </div>`

const held = (id, visited = null, readingId = null) => ({ id, visited, readingId })
const entry = (after, readingId, visited = null) => ({ after, entry: { readingId, visited } })

const plan = over => planDeleted({ order: [], entries: [], held: [], known: {}, entriesShown: true, now: NOW, ...over, seen: over.seen ?? over.order ?? [] })

describe('deletedEntryFacts', () => {
  test('reads the history entry id and the day last visited', () => {
    assert.deepEqual(deletedEntryFacts(entryHtml('37956871836', '16 Sep 2026')), { readingId: '37956871836', visited: '16 Sep 2026' })
  })

  test('an entry with neither says so', () => {
    assert.deepEqual(deletedEntryFacts('<li class="deleted reading work blurb group"></li>'), { readingId: null, visited: null })
  })
})

describe('readingFacts', () => {
  test('a block that kept its history entry id', () => {
    assert.deepEqual(readingFacts(ctxHtml('17 Nov 2026', '123')), { readingId: '123', visited: '17 Nov 2026' })
  })

  test('a block as a readings page served it, form and all', () => {
    const served = '<div class="user module group"><h4 class="viewed heading"><span>Last visited:</span> 2 Oct 2026</h4><form action="/users/me/readings/77"><input type="hidden" name="reading" value="77"></form></div>'
    assert.deepEqual(readingFacts(served), { readingId: '77', visited: '2 Oct 2026' })
  })

  test('a block stored before the id was kept has the day alone', () => {
    assert.deepEqual(readingFacts(ctxHtml('3 Feb 2025')), { readingId: null, visited: '3 Feb 2025' })
  })

  test('no block', () => {
    assert.deepEqual(readingFacts(undefined), { readingId: null, visited: null })
  })
})

describe('isReadingsListing', () => {
  test('Marked for Later and History are', () => {
    assert.equal(isReadingsListing('https://archiveofourown.org/users/someone/readings?show=to-read'), true)
    assert.equal(isReadingsListing('https://archiveofourown.org/users/someone/readings'), true)
  })

  test('a tag listing is not', () => {
    assert.equal(isReadingsListing('https://archiveofourown.org/tags/Fluff/works'), false)
  })
})

describe('planDeleted: matching entries', () => {
  test('an entry takes the place of the held work with its history entry id', () => {
    const result = plan({
      order: ['1', '3'],
      entries: [entry('1', 'r2', '16 Sep 2026')],
      held: [held('1'), held('2', '16 Sep 2026', 'r2'), held('3')],
    })
    assert.deepEqual(result.order, ['1', '2', '3'])
    assert.deepEqual(result.noticed, { 2: { at: NOW, reading: 'r2' } })
    assert.deepEqual(result.deleted, { 2: { at: NOW, reading: 'r2' } })
  })

  test('without ids, the one vanished work last visited that day', () => {
    const result = plan({
      order: ['1', '3'],
      entries: [entry('1', 'r2', '16 Sep 2026')],
      held: [held('1', '20 Sep 2026'), held('2', '16 Sep 2026'), held('3', '16 Sep 2026')],
    })
    // 3 was visited that day too, but is still listed: not a candidate.
    assert.deepEqual(result.order, ['1', '2', '3'])
    assert.deepEqual(result.noticed, { 2: { at: NOW, reading: 'r2' } })
  })

  test('two vanished works visited that day and one entry: neither is taken for it', () => {
    const result = plan({
      order: ['1'],
      entries: [entry('1', 'r9', '16 Sep 2026')],
      held: [held('1'), held('2', '16 Sep 2026'), held('3', '16 Sep 2026')],
    })
    assert.deepEqual(result.order, ['1'])
    assert.deepEqual(result.noticed, {})
  })

  test('as many entries as vanished works that day: all of them, in held order', () => {
    const result = plan({
      order: ['1'],
      entries: [entry('1', 'ra', '16 Sep 2026'), entry('1', 'rb', '16 Sep 2026')],
      held: [held('1'), held('2', '16 Sep 2026'), held('3', '16 Sep 2026')],
    })
    assert.deepEqual(result.order, ['1', '2', '3'])
    assert.deepEqual(result.noticed, { 2: { at: NOW, reading: 'ra' }, 3: { at: NOW, reading: 'rb' } })
  })

  test('a held work whose id names another entry is not taken by date', () => {
    const result = plan({
      order: [],
      entries: [entry(null, 'r1', '16 Sep 2026')],
      held: [held('2', '16 Sep 2026', 'r2')],
    })
    assert.deepEqual(result.order, [])
  })

  test('an entry at the top of the listing goes first', () => {
    const result = plan({ order: ['1'], entries: [entry(null, 'r2')], held: [held('2', null, 'r2'), held('1')] })
    assert.deepEqual(result.order, ['2', '1'])
  })

  test('an entry nothing held answers to is left out', () => {
    const result = plan({ order: ['1'], entries: [entry('1', 'r5', '1 Jan 2020')], held: [held('1')] })
    assert.deepEqual(result.order, ['1'])
    assert.deepEqual(result.deleted, {})
  })
})

describe('planDeleted: works already known deleted', () => {
  test('matched by the id recorded for it: kept, nothing to write', () => {
    const known = { 2: { at: NOW - 1000, reading: 'r2' } }
    const result = plan({ order: ['1'], entries: [entry('1', 'r2')], held: [held('1'), held('2')], known })
    assert.deepEqual(result.order, ['1', '2'])
    assert.deepEqual(result.noticed, {})
    assert.deepEqual(result.deleted, known)
  })

  test('recorded without an id, then matched: the id is learned, the day kept', () => {
    const known = { 2: { at: NOW - 1000 } }
    const result = plan({ order: ['1'], entries: [entry('1', 'r2', '16 Sep 2026')], held: [held('1'), held('2', '16 Sep 2026')], known })
    assert.deepEqual(result.noticed, { 2: { at: NOW - 1000, reading: 'r2' } })
  })

  test('on a listing that shows its deleted works, one whose entry has gone goes too', () => {
    const known = { 2: { at: NOW - 1000, reading: 'r2' } }
    const result = plan({ order: ['1'], held: [held('1'), held('2')], known })
    assert.deepEqual(result.order, ['1'])
    assert.deepEqual(result.deleted, {})
  })

  test('on any other listing it stays, after the work it followed', () => {
    const known = { 2: { at: NOW - 1000 } }
    const result = plan({ order: ['3', '1', '4'], held: [held('1'), held('2'), held('3')], known, entriesShown: false })
    assert.deepEqual(result.order, ['3', '1', '2', '4'])
    assert.deepEqual(result.deleted, known)
    assert.deepEqual(result.noticed, {})
  })

  test('with nothing before it still listed, it goes first', () => {
    const known = { 1: { at: NOW - 1000 }, 2: { at: NOW - 1000 } }
    const result = plan({ order: ['3'], held: [held('1'), held('2'), held('3')], known, entriesShown: false })
    assert.deepEqual(result.order, ['1', '2', '3'])
  })

  test('a work not held is not brought in', () => {
    const result = plan({ order: ['1'], held: [held('1')], known: { 9: { at: NOW } }, entriesShown: false })
    assert.deepEqual(result.order, ['1'])
  })

  test('carried from the stored copy without being read: still deleted', () => {
    const known = { 2: { at: NOW - 1000, reading: 'r2' } }
    const result = plan({ order: ['1', '2'], seen: ['1'], held: [held('1'), held('2')], known })
    assert.deepEqual(result.order, ['1', '2'])
    assert.deepEqual(result.deleted, known)
    assert.deepEqual(result.revived, [])
  })

  test('listed again: back on AO3, no longer deleted', () => {
    const result = plan({ order: ['1', '2'], held: [held('1'), held('2')], known: { 2: { at: NOW - 1000 } } })
    assert.deepEqual(result.order, ['1', '2'])
    assert.deepEqual(result.revived, ['2'])
    assert.deepEqual(result.deleted, {})
  })
})
