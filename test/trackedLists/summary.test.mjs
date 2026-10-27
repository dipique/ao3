import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { ADDED_VERBS, describeFilters, describeUpdate, FILTER_SUMMARY_LENGTH } from '../../src/common/trackedLists.ts'
import { figures, mentions } from '../facts.mjs'

/** An uncommon tag's page: a custom search, so the view filter is all it can have. */
const TAG = '/tags/marriage%20problems'

/** What a list with nothing to say gets. */
const NONE = { text: '', full: '', more: 0 }

/** The whole line, however long. */
const full = entry => describeFilters(entry, { maxLength: Infinity }).full

/** `text` gives each of `parts`, in this order. */
function inOrder(text, parts) {
  let from = 0
  for (const part of parts) {
    const at = text.indexOf(part, from)
    assert.ok(at >= 0, `${JSON.stringify(text)} gives ${JSON.stringify(part)} after what comes before it`)
    from = at + part.length
  }
}

/**
 * How many of `conditions` — what each condition of a cut line is known by, in
 * the order the whole line gives them — the line shows: a run from the first,
 * the rest left out, and counted as left out.
 */
function shown(summary, conditions) {
  const count = conditions.filter(fact => mentions(summary.text, fact)).length
  conditions.forEach((fact, i) => assert.equal(mentions(summary.text, fact), i < count, `${summary.text}: ${fact}`))
  assert.equal(summary.more, conditions.length - count, 'what it leaves out')
  for (const fact of conditions)
    assert.ok(mentions(summary.full, fact), `the whole line gives ${fact}`)
  return count
}

describe('describeFilters: the view filter, by name', () => {
  test('includes, requires and excludes, in that order, each list sorted', () => {
    const filter = { facets: { characters: { ex: ['Ron Weasley', 'Draco Malfoy'] }, fandoms: { in: ['Harry Potter'] }, freeforms: { req: ['Fluff'] } } }
    inOrder(full({ url: TAG, filter }), [ADDED_VERBS.include, 'Harry Potter', ADDED_VERBS.require, 'Fluff', ADDED_VERBS.exclude, 'Draco Malfoy', 'Ron Weasley'])
  })

  test('one verb across several groups is one clause', () => {
    const filter = { facets: { characters: { ex: ['Draco Malfoy'] }, relationships: { ex: ['Draco Malfoy/Harry Potter'] } } }
    const line = full({ url: TAG, filter })
    inOrder(line, [ADDED_VERBS.exclude, 'Draco Malfoy', 'Draco Malfoy/Harry Potter'])
    assert.equal(line.split(ADDED_VERBS.exclude).length - 1, 1, line)
  })

  test('the text box, trimmed', () => {
    const line = full({ url: TAG, filter: { text: '  dragons  ' } })
    assert.ok(mentions(line, 'dragons'), line)
    assert.equal(line, full({ url: TAG, filter: { text: 'dragons' } }))
  })

  test('the word-count range, open at either end or neither', () => {
    const atLeast = full({ url: TAG, filter: { words: [5000, null] } })
    const atMost = full({ url: TAG, filter: { words: [null, 5000] } })
    assert.deepEqual(figures(atLeast), [5000])
    assert.deepEqual(figures(atMost), [5000])
    assert.notEqual(atLeast, atMost, 'each says which end is open')
    assert.deepEqual(figures(full({ url: TAG, filter: { words: [null, 20000] } })), [20000])
    inOrder(full({ url: TAG, filter: { words: [1000, 5000] } }), ['1,000', '5,000'])
  })

  test('the stored spelling doesn\'t matter', () => {
    assert.equal(
      full({ url: TAG, filter: { facets: { characters: { ex: ['b', 'a', 'b', ' '], in: [] }, fandoms: {} }, text: ' x  y ' } }),
      full({ url: TAG, filter: { facets: { characters: { ex: ['a', 'b'] } }, text: 'x y' } }),
    )
  })

  test('a series has only a view filter too', () => {
    inOrder(full({ url: '/series/9991', filter: { facets: { characters: { req: ['Draco Malfoy'] } } } }), [ADDED_VERBS.require, 'Draco Malfoy'])
  })
})

describe('describeFilters: the archive\'s filters, counted', () => {
  /** The archive's filters a listing's line counts. */
  const counted = url => figures(full({ url }))

  test('each criterion once, however the listing is spelled', () => {
    const filters = 'work_search[complete]=T&work_search[language_id]=en&exclude_work_search[character_ids][]=12&exclude_work_search[character_ids][]=34'
    assert.deepEqual(counted(`/tags/Harry%20Potter/works?${filters}`), [4])
    assert.deepEqual(counted(`/works?${filters}&tag_id=Harry+Potter`), [4])
    // The key holds each parameter and value once, and so does the count.
    assert.deepEqual(counted(`/works?${filters}&exclude_work_search[character_ids][]=12&tag_id=Harry+Potter`), [4])
  })

  test('one is one search filter', () => {
    assert.deepEqual(counted('/tags/Bees/works?work_search[complete]=T'), [1])
  })

  test('the sort, a relative date and the listing\'s owner aren\'t filters', () => {
    const sorted = 'work_search[sort_column]=kudos_count&work_search[sort_direction]=desc&work_search[revised_at]=<+2+weeks'
    assert.deepEqual(describeFilters({ url: `/works?${sorted}&tag_id=Bees` }), NONE)
    assert.deepEqual(describeFilters({ url: `/users/BuckysGrace/works?${sorted}` }), NONE)
    assert.deepEqual(describeFilters({ url: '/works?user_id=BuckysGrace' }), NONE)
    assert.deepEqual(describeFilters({ url: '/collections/yuletide/works' }), NONE)
    assert.deepEqual(counted(`/works?${sorted}&work_search[complete]=T&tag_id=Bees`), [1])
  })

  test('a collection named in the query is its owner, not a filter of it', () => {
    assert.deepEqual(describeFilters({ url: '/works?collection_id=yuletide' }), NONE)
    assert.deepEqual(counted('/works?collection_id=yuletide&work_search[complete]=T'), [1])
  })

  test('a pseud, and a tag beside an author, are filters of the author\'s listing', () => {
    assert.deepEqual(counted('/users/BuckysGrace/pseuds/Grace%20Notes/works'), [1])
    assert.deepEqual(counted('/works?pseud_id=Grace+Notes&user_id=BuckysGrace'), [1])
    assert.deepEqual(counted('/works?tag_id=Fluff&user_id=BuckysGrace'), [1])
  })

  test('a works search\'s words are what it searches, not a filter', () => {
    assert.deepEqual(describeFilters({ url: '/works/search?work_search[query]=coffee' }), NONE)
    assert.deepEqual(counted('/works/search?work_search[query]=coffee&work_search[complete]=T&work_search[excluded_tag_names]=Angst,Fluff&work_search[sort_column]=kudos_count'), [2])
  })

  test('without words, a works search\'s subject field is what it searches, and its other fields filter', () => {
    // Its fandom is its root; the character and the completion narrow it.
    const url = '/works/search?work_search[fandom_names]=Harry+Potter+-+J.+K.+Rowling&work_search[character_names]=Draco+Malfoy&work_search[complete]=T'
    assert.deepEqual(counted(url), [2])
    assert.deepEqual(counted('/works/search?work_search[character_names]=Draco+Malfoy&work_search[complete]=T'), [1])
    assert.deepEqual(describeFilters({ url: '/works/search?work_search[fandom_names]=Harry+Potter+-+J.+K.+Rowling' }), NONE)
    // With none of those fields, it's a search of nothing in particular, and every field filters.
    assert.deepEqual(counted('/works/search?work_search[complete]=T&work_search[excluded_tag_names]=Angst'), [2])
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
    const got = describeFilters({ url: '/works/search?work_search[query]=coffee&work_search[complete]=T', filter: { facets: { characters: { ex: ['Draco Malfoy'] } } } })
    assert.deepEqual({ ...got, text: null, full: null }, { text: null, full: null, more: 0 })
    assert.equal(got.text, got.full)
    assert.deepEqual(figures(got.full), [1])
    const count = got.full.search(/\b1\b/)
    assert.ok(count < got.full.indexOf(ADDED_VERBS.exclude), got.full)
    inOrder(got.full, [ADDED_VERBS.exclude, 'Draco Malfoy'])
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
  /** Its conditions in the whole line's order: the names sorted, then the word range. */
  const CONDITIONS = ['Draco Malfoy', 'Ginny Weasley', 'Hermione Granger', 'Neville Longbottom', 'Ron Weasley', '5,000']

  test('a line that fits is all there', () => {
    const got = describeFilters({ url: TAG, filter: { facets: { characters: { ex: ['Draco Malfoy'] } } } })
    assert.equal(got.text, got.full)
    assert.equal(shown(got, ['Draco Malfoy']), 1)
  })

  test('cut between two names, saying how many conditions are left out', () => {
    const got = describeFilters(MANY, { maxLength: 50 })
    const count = shown(got, CONDITIONS)
    assert.ok(count > 0 && count < CONDITIONS.length, got.text)
    assert.ok(got.text.length <= 50, got.text)
    assert.deepEqual(figures(got.text, ...CONDITIONS.slice(0, count)), [got.more], 'how many it left out')
    assert.ok(shown(describeFilters(MANY, { maxLength: 70 }), CONDITIONS) >= count, 'more room shows as many or more')
  })

  test('by default, cut to about a line of small print', () => {
    const got = describeFilters(MANY)
    assert.equal(got.full, full(MANY))
    assert.ok(got.full.length > FILTER_SUMMARY_LENGTH, 'the whole line is too long')
    assert.ok(got.text.length <= FILTER_SUMMARY_LENGTH, got.text)
    const count = shown(got, CONDITIONS)
    assert.ok(count > 0 && count < CONDITIONS.length, got.text)
    assert.deepEqual(got, describeFilters(MANY, { maxLength: FILTER_SUMMARY_LENGTH }))
  })

  test('the text box and the word range count as one condition each', () => {
    const got = describeFilters({ url: TAG, filter: { facets: { characters: { ex: ['Draco Malfoy'] } }, text: 'dragons', words: [5000, null] } }, { maxLength: 40 })
    const count = shown(got, ['Draco Malfoy', 'dragons', '5,000'])
    assert.ok(count > 0 && count < 3, got.text)
  })

  test('a clause that doesn\'t fit is left out whole, not shown headless', () => {
    const got = describeFilters({ url: TAG, filter: { facets: { characters: { req: ['Draco Malfoy'], ex: ['Ron Weasley'] } } } }, { maxLength: 30 })
    assert.equal(shown(got, ['Draco Malfoy', 'Ron Weasley']), 1)
    assert.ok(mentions(got.text, ADDED_VERBS.require), got.text)
    assert.ok(!mentions(got.text, ADDED_VERBS.exclude), `no verb without its names: ${got.text}`)
  })

  test('the count, and one of the view\'s names, show however little room there is', () => {
    const got = describeFilters({ url: '/works/search?work_search[query]=coffee&work_search[complete]=T', filter: { facets: { characters: { ex: ['Draco Malfoy', 'Ron Weasley'] } } } }, { maxLength: 10 })
    assert.equal(shown(got, ['Draco Malfoy', 'Ron Weasley']), 1)
    assert.deepEqual(figures(got.full, 'Draco Malfoy', 'Ron Weasley'), [1], 'the archive\'s one filter')
    assert.ok(got.text.search(/\b1\b/) < got.text.indexOf('Draco Malfoy'), `the count first: ${got.text}`)
  })
})
