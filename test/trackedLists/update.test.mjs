import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { ADDED_VERBS, canonicalFilter, describeUpdate, filteredKey, ID_NOUNS, normalizeTrackedUrl, refineLink, refiningId, REMOVED_VERBS, trackedKey } from '../../src/common/trackedLists.ts'
import { figures, mentions } from '../facts.mjs'

const AO3 = 'https://archiveofourown.org'

describe('canonicalFilter', () => {
  test('value order and repeats don\'t matter, nor does the order of groups', () => {
    const a = canonicalFilter({ facets: { freeforms: { req: ['Fluff'] }, characters: { ex: ['b', 'a', 'b'], in: ['c'] } } })
    const b = canonicalFilter({ facets: { characters: { in: ['c'], ex: ['a', 'b'] }, freeforms: { req: ['Fluff', 'Fluff'] } } })
    assert.deepEqual(a, { facets: { characters: { in: ['c'], ex: ['a', 'b'] }, freeforms: { req: ['Fluff'] } } })
    assert.equal(JSON.stringify(a), JSON.stringify(b))
  })

  test('empty values, lists and groups vanish', () => {
    assert.deepEqual(
      canonicalFilter({ facets: { characters: { in: [], ex: ['', '  ', 'Draco Malfoy'] }, fandoms: {}, rating: { req: [] } } }),
      { facets: { characters: { ex: ['Draco Malfoy'] } } },
    )
  })

  test('a filter that filters nothing is no filter', () => {
    for (const empty of [undefined, null, {}, 'text', [], { facets: {} }, { facets: { characters: { in: [] } } }, { text: '   ' }, { words: [null, null] }])
      assert.equal(canonicalFilter(empty), undefined, JSON.stringify(empty))
  })

  test('text is trimmed with its spaces collapsed', () => {
    assert.deepEqual(canonicalFilter({ text: '  Slow   burn\t' }), { text: 'Slow burn' })
  })

  test('a word bound is a whole, non-negative count or open', () => {
    assert.deepEqual(canonicalFilter({ words: [1000, null] }), { words: [1000, null] })
    assert.deepEqual(canonicalFilter({ words: ['1000', 5000] }), { words: [null, 5000] })
    assert.equal(canonicalFilter({ words: [-5, 2.5] }), undefined)
    assert.equal(canonicalFilter({ words: 1000 }), undefined)
  })

  test('keeps facet keys it doesn\'t know, and drops what isn\'t a filter', () => {
    assert.deepEqual(
      canonicalFilter({ facets: { someLaterGroup: { req: ['x', 7] }, characters: ['not a selection'] }, sort: 'title', dir: 'desc', text: 'x' }),
      { facets: { someLaterGroup: { req: ['x'] } }, text: 'x' },
    )
  })

  test('always spells its fields in one order', () => {
    const filter = canonicalFilter({ words: [1, 2], text: 't', facets: { a: { req: ['r'], ex: ['e'], in: ['i'] } } })
    assert.equal(JSON.stringify(filter), '{"facets":{"a":{"in":["i"],"ex":["e"],"req":["r"]}},"text":"t","words":[1,2]}')
  })

  test('a key spelled __proto__ is kept as a key, not a prototype', () => {
    const filter = canonicalFilter(JSON.parse('{"facets":{"__proto__":{"in":["x"]}}}'))
    assert.deepEqual(Object.keys(filter.facets), ['__proto__'])
    assert.equal(Object.getPrototypeOf(filter.facets), Object.prototype)
  })
})

describe('the key, with a view filter', () => {
  const url = '/tags/marriage%20problems'
  const filter = { facets: { characters: { ex: ['Draco Malfoy'] } } }

  test('the same URL with and without a filter keys apart', () => {
    assert.notEqual(trackedKey({ url, filter }), trackedKey({ url }))
    assert.equal(trackedKey({ url }), 'tag-works:/tags/marriage%20problems')
  })

  test('an empty filter keys the same as none', () => {
    assert.equal(trackedKey({ url, filter: {} }), trackedKey({ url }))
    assert.equal(trackedKey({ url, filter: { facets: { characters: { ex: [] } } } }), trackedKey({ url }))
  })

  test('how the filter is spelled doesn\'t matter', () => {
    assert.equal(
      trackedKey({ url, filter: { facets: { characters: { ex: ['b', 'a'] } }, text: ' x ' } }),
      trackedKey({ url, filter: { text: 'x', facets: { characters: { ex: ['a', 'b', 'a'] } } } }),
    )
  })

  test('a page and its live filter key the way a list made from them does', () => {
    assert.equal(filteredKey(normalizeTrackedUrl(`${AO3}${url}?page=2`).key, filter), trackedKey({ url, filter }))
  })

  test('still none for an entry that doesn\'t name an archive page', () => {
    assert.equal(trackedKey({ url: '//example.com/tags/Bees', filter }), null)
  })
})

describe('refineLink and refiningId', () => {
  test('a list\'s own page, with its id on the fragment', () => {
    assert.equal(
      refineLink({ id: 'k3j9x2', kind: 'works-filter', url: '/works?tag_id=Bees&work_search[complete]=T' }),
      '/works?tag_id=Bees&work_search[complete]=T#ao3e-list=k3j9x2',
    )
    assert.equal(refineLink({ id: 'k3j9x2', kind: 'text-search', url: '/works/search?work_search[query]=coffee' }), '/works/search?work_search[query]=coffee#ao3e-list=k3j9x2')
    assert.equal(refineLink({ id: 'k3j9x2', kind: 'tag-works', url: '/tags/marriage%20problems', scan: true }), '/tags/marriage%20problems#ao3e-list=k3j9x2')
    assert.equal(refineLink({ id: 'k3j9x2', kind: 'series-works', url: '/series/4232377' }), '/series/4232377#ao3e-list=k3j9x2')
  })

  test('the page it opens reads the id back', () => {
    const link = refineLink({ id: 'k3j9x2', kind: 'works-filter', url: '/tags/Bees/works' })
    assert.equal(refiningId(new URL(link, AO3).hash), 'k3j9x2')
    assert.equal(refiningId('ao3e-list=k3j9x2'), 'k3j9x2', 'with or without the #')
  })

  test('no link for an entry that isn\'t an archive page of its kind, or has an id no link can carry', () => {
    assert.equal(refineLink({ id: 'k3j9x2', kind: 'series-works', url: 'https://example.com/series/1' }), null)
    assert.equal(refineLink({ id: 'k3j9x2', kind: 'text-search', url: '/series/1' }), null)
    assert.equal(refineLink({ id: 'a/b', kind: 'series-works', url: '/series/1' }), null)
    assert.equal(refineLink({ id: '', kind: 'series-works', url: '/series/1' }), null)
  })

  test('any other fragment is no list at all', () => {
    for (const hash of ['', '#', '#ao3e-list=', '#ao3e-list=a/b', '#ao3e-list=abc&x=1', '#ao3e-list=abc#x', '#work_123', '#ao3e-lists=abc', '#x#ao3e-list=abc', '#AO3E-LIST=abc', undefined, null])
      assert.equal(refiningId(hash), null, String(hash))
  })
})

describe('describeUpdate', () => {
  const texts = update => update.changes.map(change => change.text)

  /** A line adding `names` the `verb` way. */
  const adds = (verb, ...names) => line => mentions(line, ADDED_VERBS[verb]) && !mentions(line, REMOVED_VERBS[verb]) && names.every(name => mentions(line, name))
  /** A line taking `names` away from those selected the `verb` way. */
  const drops = (verb, ...names) => line => mentions(line, REMOVED_VERBS[verb]) && names.every(name => mentions(line, name))
  /** A line counting ids the URL can't name: `change` of them (+2, −1), of what `field` holds. */
  const counts = (change, field) => line => mentions(line, change) && mentions(line, ID_NOUNS[field])
  /** A line giving each of `facts`, in this order, and no other number. */
  const gives = (...facts) => (line) => {
    let from = 0
    for (const fact of facts) {
      const at = line.indexOf(fact, from)
      if (at < 0)
        return false
      from = at + fact.length
    }
    return figures(line, ...facts).length === 0
  }

  /** The lines are as many as `checks`, and each passes its own. */
  function reads(lines, checks) {
    assert.equal(lines.length, checks.length, JSON.stringify(lines))
    lines.forEach((line, i) => assert.ok(checks[i](line), `line ${i}: ${line}`))
  }

  test('nothing a list is matched by changed: no root, no lines', () => {
    assert.deepEqual(
      describeUpdate({ url: '/tags/Bees/works?work_search[complete]=T' }, { url: '/works?work_search[sort_column]=kudos_count&work_search[complete]=T&tag_id=Bees' }),
      { root: null, changes: [] },
    )
  })

  test('names added and removed, by name', () => {
    const update = describeUpdate(
      { url: '/works/search?work_search[query]=coffee&work_search[excluded_tag_names]=Angst,Major+Character+Death' },
      { url: '/works/search?work_search[query]=coffee&work_search[excluded_tag_names]=Angst%2C+Fluff&work_search[other_tag_names]=Slow+Burn' },
    )
    assert.equal(update.root, null)
    reads(texts(update), [adds('include', 'Slow Burn'), adds('exclude', 'Fluff'), drops('exclude', 'Major Character Death')])
    assert.ok(texts(update).every(line => !mentions(line, 'Angst')), 'what stays isn\'t a change')
    assert.ok(update.changes.every(change => change.layer === 'query'))
  })

  test('the sidebar\'s ids are counted, unless the page can name them', () => {
    const before = { url: '/tags/Harry%20Potter/works' }
    const after = { url: '/works?exclude_work_search[character_ids][]=12&exclude_work_search[character_ids][]=34&include_work_search[rating_ids][]=13&tag_id=Harry+Potter' }
    reads(texts(describeUpdate(before, after)), [counts('+2', 'character'), counts('+1', 'rating')])

    const nameId = (param, id) => (param === 'exclude_work_search[character_ids][]' && id === '12' ? 'Draco Malfoy' : null)
    reads(texts(describeUpdate(before, after, { nameId })), [adds('exclude', 'Draco Malfoy'), counts('+1', 'character'), counts('+1', 'rating')])
    reads(texts(describeUpdate(after, before, { nameId })), [drops('exclude', 'Draco Malfoy'), counts('−1', 'character'), counts('−1', 'rating')])
  })

  test('word counts, as ranges, from what they were to what they would be', () => {
    const [dropped] = texts(describeUpdate({ url: '/tags/Bees/works?work_search[words_from]=5000' }, { url: '/tags/Bees/works' }))
    const [added] = texts(describeUpdate({ url: '/tags/Bees/works' }, { url: '/tags/Bees/works?work_search[words_from]=5000' }))
    assert.ok(gives('5,000')(dropped) && gives('5,000')(added), `${dropped} | ${added}`)
    assert.notEqual(dropped, added, 'each says which way it goes')
    reads(
      texts(describeUpdate({ url: '/tags/Bees/works?work_search[words_from]=1000&work_search[words_to]=5000' }, { url: '/works?work_search[words_to]=10000&tag_id=Bees' })),
      [gives('1,000', '5,000', '10,000')],
    )
  })

  test('other fields say what they were and would be', () => {
    const lines = texts(describeUpdate(
      { url: '/tags/Bees/works?work_search[complete]=T&work_search[language_id]=en&work_search[crossover]=F' },
      { url: '/tags/Bees/works?work_search[complete]=F&work_search[query]=coffee' },
    ))
    assert.equal(lines.length, 4, 'completion, crossovers, language and the search within the results')
    assert.equal(lines.filter(line => /\ben\b/.test(line)).length, 1, 'the language it was')
    assert.equal(lines.filter(line => mentions(line, 'coffee')).length, 1, 'the words it would search')
  })

  test('a pseud is a filter of its author, not a new root', () => {
    const update = describeUpdate({ url: '/users/BuckysGrace/works' }, { url: '/works?pseud_id=Grace+Notes&user_id=BuckysGrace' })
    assert.equal(update.root, null)
    reads(texts(update), [line => mentions(line, 'Grace Notes')])
  })

  test('the view\'s filters, by name, after the query\'s', () => {
    const url = '/tags/marriage%20problems'
    const update = describeUpdate(
      { url, filter: { facets: { characters: { ex: ['Draco Malfoy'] } } } },
      { url, filter: { facets: { characters: { ex: ['Draco Malfoy', 'Harry Potter'] }, freeforms: { req: ['Fluff'] } }, text: 'dragons', words: [1000, null] } },
    )
    assert.ok(update.changes.every(change => change.layer === 'view'))
    const [require, exclude, ...values] = texts(update)
    reads([require, exclude], [adds('require', 'Fluff'), adds('exclude', 'Harry Potter')])
    assert.ok(!mentions(exclude, 'Draco Malfoy'), 'what stays isn\'t a change')
    // The text box and the word range, each as it was and would be.
    assert.equal(values.length, 2, JSON.stringify(values))
    assert.equal(values.filter(line => mentions(line, 'dragons')).length, 1)
    assert.equal(values.filter(gives('1,000')).length, 1)

    const both = describeUpdate(
      { url: '/works/search?work_search[query]=coffee' },
      { url: '/works/search?work_search[query]=coffee&work_search[complete]=T', filter: { facets: { fandoms: { in: ['Bees'] } } } },
    )
    assert.deepEqual(both.changes.map(change => change.layer), ['query', 'view'])
    assert.ok(adds('include', 'Bees')(both.changes[1].text), both.changes[1].text)
  })

  test('a move to another root is flagged, with what it was and would be a search of', () => {
    const tag = describeUpdate({ url: '/tags/Harry%20Potter/works', type: 'fandom' }, { url: '/works?tag_id=Marvel&work_search[complete]=T' })
    assert.deepEqual(tag.root, { from: { type: 'fandom', entity: 'Harry Potter' }, to: { type: 'tag', entity: 'Marvel' } })
    assert.equal(tag.changes.length, 1, 'the owner itself is not a line, only the completion')
    assert.ok(!mentions(tag.changes[0].text, 'Marvel'), tag.changes[0].text)

    const search = describeUpdate({ url: '/works/search?work_search[query]=coffee' }, { url: '/works/search?work_search[query]=tea' })
    assert.deepEqual(search.root, { from: { type: 'search', entity: 'coffee' }, to: { type: 'search', entity: 'tea' } })
    reads(texts(search), [gives('coffee', 'tea')])
  })

  test('a works search without words moves only when its subject field does', () => {
    const was = { url: '/works/search?work_search[fandom_names]=Harry+Potter&work_search[character_names]=Draco+Malfoy' }
    const narrowed = describeUpdate(was, { url: '/works/search?work_search[fandom_names]=Harry+Potter&work_search[character_names]=Ron+Weasley' })
    assert.equal(narrowed.root, null)
    reads(texts(narrowed), [adds('include', 'Ron Weasley'), drops('include', 'Draco Malfoy')])

    const moved = describeUpdate(was, { url: '/works/search?work_search[fandom_names]=Marvel&work_search[character_names]=Draco+Malfoy' })
    assert.deepEqual(moved.root, { from: { type: 'search', entity: 'Harry Potter' }, to: { type: 'search', entity: 'Marvel' } })
    reads(texts(moved), [adds('include', 'Marvel'), drops('include', 'Harry Potter')])
  })

  test('nothing for a URL that isn\'t trackable', () => {
    assert.deepEqual(describeUpdate({ url: '/tags/Bees/works' }, { url: 'https://example.com/tags/Bees/works' }), { root: null, changes: [] })
  })
})
