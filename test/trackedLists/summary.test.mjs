import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { describeFilters, describeUpdate, FILTER_SUMMARY_LENGTH } from '../../src/common/trackedLists.ts'

/** An uncommon tag's page: a custom search, so the view filter is all it can have. */
const TAG = '/tags/marriage%20problems'

/** What a list with nothing to say gets. */
const NONE = { text: '', full: '', more: 0 }

/** The whole line, however long. */
const full = entry => describeFilters(entry, { maxLength: Infinity }).full

describe('describeFilters: the view filter, by name', () => {
  test('includes, requires and excludes, in that order, each list sorted', () => {
    const filter = { facets: { characters: { ex: ['Ron Weasley', 'Draco Malfoy'] }, fandoms: { in: ['Harry Potter'] }, freeforms: { req: ['Fluff'] } } }
    assert.equal(full({ url: TAG, filter }), 'Includes: Harry Potter · Requires: Fluff · Excludes: Draco Malfoy, Ron Weasley')
  })

  test('one verb across several groups is one clause', () => {
    const filter = { facets: { characters: { ex: ['Draco Malfoy'] }, relationships: { ex: ['Draco Malfoy/Harry Potter'] } } }
    assert.equal(full({ url: TAG, filter }), 'Excludes: Draco Malfoy, Draco Malfoy/Harry Potter')
  })

  test('the text box, quoted', () => {
    assert.equal(full({ url: TAG, filter: { text: '  dragons  ' } }), 'Text: “dragons”')
  })

  test('the word-count range, open at either end or neither', () => {
    assert.equal(full({ url: TAG, filter: { words: [5000, null] } }), 'Word count: ≥ 5,000')
    assert.equal(full({ url: TAG, filter: { words: [null, 20000] } }), 'Word count: ≤ 20,000')
    assert.equal(full({ url: TAG, filter: { words: [1000, 5000] } }), 'Word count: 1,000–5,000')
  })

  test('reads as the lines an update adding the same filter would show', () => {
    // One vocabulary: the summary is the "after" side of each change line.
    const filter = { facets: { characters: { ex: ['Draco Malfoy'] }, fandoms: { in: ['Harry Potter'] }, freeforms: { req: ['Fluff'] } }, text: 'dragons', words: [1000, 5000] }
    const lines = describeUpdate({ url: TAG }, { url: TAG, filter }).changes.map(change => change.text.replace('any → ', ''))
    assert.equal(full({ url: TAG, filter }), lines.join(' · '))
  })

  test('the stored spelling doesn\'t matter', () => {
    assert.equal(
      full({ url: TAG, filter: { facets: { characters: { ex: ['b', 'a', 'b', ' '], in: [] }, fandoms: {} }, text: ' x  y ' } }),
      'Excludes: a, b · Text: “x y”',
    )
  })

  test('a series has only a view filter too', () => {
    assert.equal(full({ url: '/series/9991', filter: { facets: { characters: { req: ['Draco Malfoy'] } } } }), 'Requires: Draco Malfoy')
  })
})

describe('describeFilters: the archive\'s filters, counted', () => {
  test('each criterion once, however the listing is spelled', () => {
    const filters = 'work_search[complete]=T&work_search[language_id]=en&exclude_work_search[character_ids][]=12&exclude_work_search[character_ids][]=34'
    assert.equal(full({ url: `/tags/Harry%20Potter/works?${filters}` }), '4 search filters')
    assert.equal(full({ url: `/works?${filters}&tag_id=Harry+Potter` }), '4 search filters')
    // The key holds each parameter and value once, and so does the count.
    assert.equal(full({ url: `/works?${filters}&exclude_work_search[character_ids][]=12&tag_id=Harry+Potter` }), '4 search filters')
  })

  test('one is one search filter', () => {
    assert.equal(full({ url: '/tags/Bees/works?work_search[complete]=T' }), '1 search filter')
  })

  test('the sort, a relative date and the listing\'s owner aren\'t filters', () => {
    const sorted = 'work_search[sort_column]=kudos_count&work_search[sort_direction]=desc&work_search[revised_at]=<+2+weeks'
    assert.deepEqual(describeFilters({ url: `/works?${sorted}&tag_id=Bees` }), NONE)
    assert.deepEqual(describeFilters({ url: `/users/BuckysGrace/works?${sorted}` }), NONE)
    assert.deepEqual(describeFilters({ url: '/works?user_id=BuckysGrace' }), NONE)
    assert.deepEqual(describeFilters({ url: '/collections/yuletide/works' }), NONE)
    assert.equal(full({ url: `/works?${sorted}&work_search[complete]=T&tag_id=Bees` }), '1 search filter')
  })

  test('a collection named in the query is its owner, not a filter of it', () => {
    assert.deepEqual(describeFilters({ url: '/works?collection_id=yuletide' }), NONE)
    assert.equal(full({ url: '/works?collection_id=yuletide&work_search[complete]=T' }), '1 search filter')
  })

  test('a pseud, and a tag beside an author, are filters of the author\'s listing', () => {
    assert.equal(full({ url: '/users/BuckysGrace/pseuds/Grace%20Notes/works' }), '1 search filter')
    assert.equal(full({ url: '/works?pseud_id=Grace+Notes&user_id=BuckysGrace' }), '1 search filter')
    assert.equal(full({ url: '/works?tag_id=Fluff&user_id=BuckysGrace' }), '1 search filter')
  })

  test('a works search\'s words are what it searches, not a filter', () => {
    assert.deepEqual(describeFilters({ url: '/works/search?work_search[query]=coffee' }), NONE)
    assert.equal(
      full({ url: '/works/search?work_search[query]=coffee&work_search[complete]=T&work_search[excluded_tag_names]=Angst,Fluff&work_search[sort_column]=kudos_count' }),
      '2 search filters',
    )
  })

  test('without words, a works search\'s subject field is what it searches, and its other fields filter', () => {
    // Its fandom is its root; the character and the completion narrow it.
    const url = '/works/search?work_search[fandom_names]=Harry+Potter+-+J.+K.+Rowling&work_search[character_names]=Draco+Malfoy&work_search[complete]=T'
    assert.equal(full({ url }), '2 search filters')
    assert.equal(full({ url: '/works/search?work_search[character_names]=Draco+Malfoy&work_search[complete]=T' }), '1 search filter')
    assert.deepEqual(describeFilters({ url: '/works/search?work_search[fandom_names]=Harry+Potter+-+J.+K.+Rowling' }), NONE)
    // With none of those fields, it's a search of nothing in particular, and every field filters.
    assert.equal(full({ url: '/works/search?work_search[complete]=T&work_search[excluded_tag_names]=Angst' }), '2 search filters')
  })

  test('what describeUpdate calls the root is what the count leaves out', () => {
    // A change to the one field the count leaves out moves the root; a change to any it counts doesn't.
    const url = '/works/search?work_search[fandom_names]=Harry+Potter&work_search[character_names]=Draco+Malfoy&work_search[complete]=T'
    const edit = (field, value) => {
      const next = new URL(url, 'https://archiveofourown.org')
      next.searchParams.set(field, value)
      return `${next.pathname}${next.search}`
    }
    assert.notEqual(describeUpdate({ url }, { url: edit('work_search[fandom_names]', 'Marvel') }).root, null)
    assert.equal(describeUpdate({ url }, { url: edit('work_search[character_names]', 'Ron Weasley') }).root, null)
    assert.equal(describeUpdate({ url }, { url: edit('work_search[complete]', 'F') }).root, null)
  })

  test('a tag\'s or a series\' own page takes no filters of the archive\'s', () => {
    assert.deepEqual(describeFilters({ url: '/tags/Bees?work_search[complete]=T' }), NONE)
    assert.deepEqual(describeFilters({ url: '/series/9991?page=2' }), NONE)
  })
})

describe('describeFilters: both, and neither', () => {
  test('the count comes first, as an update lists the query\'s changes first', () => {
    assert.deepEqual(
      describeFilters({ url: '/works/search?work_search[query]=coffee&work_search[complete]=T', filter: { facets: { characters: { ex: ['Draco Malfoy'] } } } }),
      { text: '1 search filter · Excludes: Draco Malfoy', full: '1 search filter · Excludes: Draco Malfoy', more: 0 },
    )
  })

  test('nothing at all for a list with neither', () => {
    for (const filter of [undefined, {}, { facets: { characters: { ex: [] } } }, { text: '  ' }, { words: [null, null] }])
      assert.deepEqual(describeFilters({ url: TAG, filter }), NONE, JSON.stringify(filter))
    assert.deepEqual(describeFilters({ url: '/tags/Harry%20Potter/works' }), NONE)
  })

  test('nothing for an entry whose URL isn\'t an archive page', () => {
    assert.deepEqual(describeFilters({ url: 'https://example.com/tags/Bees/works?work_search[complete]=T', filter: { text: 'x' } }), NONE)
  })
})

describe('describeFilters: more than fits', () => {
  const MANY = { url: TAG, filter: { facets: { characters: { ex: ['Draco Malfoy', 'Ron Weasley', 'Hermione Granger', 'Ginny Weasley', 'Neville Longbottom'] } }, words: [5000, null] } }
  const ALL = 'Excludes: Draco Malfoy, Ginny Weasley, Hermione Granger, Neville Longbottom, Ron Weasley · Word count: ≥ 5,000'

  test('a line that fits is all there', () => {
    const got = describeFilters({ url: TAG, filter: { facets: { characters: { ex: ['Draco Malfoy'] } } } })
    assert.deepEqual(got, { text: 'Excludes: Draco Malfoy', full: 'Excludes: Draco Malfoy', more: 0 })
  })

  test('cut between two names, saying how many conditions are left out', () => {
    assert.deepEqual(describeFilters(MANY, { maxLength: 50 }), { text: 'Excludes: Draco Malfoy, Ginny Weasley +4 more', full: ALL, more: 4 })
  })

  test('by default, cut to about a line of small print', () => {
    const got = describeFilters(MANY)
    assert.equal(got.full, ALL)
    assert.ok(ALL.length > FILTER_SUMMARY_LENGTH, 'the whole line is too long')
    assert.ok(got.text.length <= FILTER_SUMMARY_LENGTH, got.text)
    assert.deepEqual(got, { text: 'Excludes: Draco Malfoy, Ginny Weasley, Hermione Granger +3 more', full: ALL, more: 3 })
  })

  test('the text box and the word range count as one condition each', () => {
    const got = describeFilters({ url: TAG, filter: { facets: { characters: { ex: ['Draco Malfoy'] } }, text: 'dragons', words: [5000, null] } }, { maxLength: 40 })
    assert.deepEqual(got, {
      text: 'Excludes: Draco Malfoy +2 more',
      full: 'Excludes: Draco Malfoy · Text: “dragons” · Word count: ≥ 5,000',
      more: 2,
    })
  })

  test('a clause that doesn\'t fit is left out whole, not shown headless', () => {
    const got = describeFilters({ url: TAG, filter: { facets: { characters: { req: ['Draco Malfoy'], ex: ['Ron Weasley'] } } } }, { maxLength: 30 })
    assert.deepEqual(got, { text: 'Requires: Draco Malfoy +1 more', full: 'Requires: Draco Malfoy · Excludes: Ron Weasley', more: 1 })
  })

  test('the count, and one of the view\'s names, show however little room there is', () => {
    const got = describeFilters({ url: '/works/search?work_search[query]=coffee&work_search[complete]=T', filter: { facets: { characters: { ex: ['Draco Malfoy', 'Ron Weasley'] } } } }, { maxLength: 10 })
    assert.deepEqual(got, {
      text: '1 search filter · Excludes: Draco Malfoy +1 more',
      full: '1 search filter · Excludes: Draco Malfoy, Ron Weasley',
      more: 1,
    })
  })
})
