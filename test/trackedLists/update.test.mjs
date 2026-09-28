import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { canonicalFilter, describeUpdate, filteredKey, normalizeTrackedUrl, refineLink, refiningId, trackedKey } from '../../src/common/trackedLists.ts'

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
    assert.deepEqual(texts(update), ['Includes: Slow Burn', 'Excludes: Fluff', 'No longer excludes: Major Character Death'])
    assert.ok(update.changes.every(change => change.layer === 'query'))
  })

  test('the sidebar\'s ids are counted, unless the page can name them', () => {
    const before = { url: '/tags/Harry%20Potter/works' }
    const after = { url: '/works?exclude_work_search[character_ids][]=12&exclude_work_search[character_ids][]=34&include_work_search[rating_ids][]=13&tag_id=Harry+Potter' }
    assert.deepEqual(texts(describeUpdate(before, after)), ['+2 excluded characters', '+1 included rating'])

    const nameId = (param, id) => (param === 'exclude_work_search[character_ids][]' && id === '12' ? 'Draco Malfoy' : null)
    assert.deepEqual(texts(describeUpdate(before, after, { nameId })), ['Excludes: Draco Malfoy', '+1 excluded character', '+1 included rating'])
    assert.deepEqual(texts(describeUpdate(after, before, { nameId })), ['No longer excludes: Draco Malfoy', '−1 excluded character', '−1 included rating'])
  })

  test('word counts, as ranges', () => {
    assert.deepEqual(texts(describeUpdate({ url: '/tags/Bees/works?work_search[words_from]=5000' }, { url: '/tags/Bees/works' })), ['Word count: ≥ 5,000 → any'])
    assert.deepEqual(
      texts(describeUpdate({ url: '/tags/Bees/works?work_search[words_from]=1000&work_search[words_to]=5000' }, { url: '/works?work_search[words_to]=10000&tag_id=Bees' })),
      ['Word count: 1,000–5,000 → ≤ 10,000'],
    )
  })

  test('other fields say what they were and would be', () => {
    assert.deepEqual(
      texts(describeUpdate(
        { url: '/tags/Bees/works?work_search[complete]=T&work_search[language_id]=en&work_search[crossover]=F' },
        { url: '/tags/Bees/works?work_search[complete]=F&work_search[query]=coffee' },
      )),
      ['Completion: complete only → in progress only', 'Crossovers: no crossovers → any', 'Language: en → any', 'Search within results: any → “coffee”'],
    )
  })

  test('a pseud is a filter of its author, not a new root', () => {
    const update = describeUpdate({ url: '/users/BuckysGrace/works' }, { url: '/works?pseud_id=Grace+Notes&user_id=BuckysGrace' })
    assert.equal(update.root, null)
    assert.deepEqual(texts(update), ['Pseud: any → Grace Notes'])
  })

  test('the view\'s filters, by name, after the query\'s', () => {
    const url = '/tags/marriage%20problems'
    const update = describeUpdate(
      { url, filter: { facets: { characters: { ex: ['Draco Malfoy'] } } } },
      { url, filter: { facets: { characters: { ex: ['Draco Malfoy', 'Harry Potter'] }, freeforms: { req: ['Fluff'] } }, text: 'dragons', words: [1000, null] } },
    )
    assert.deepEqual(update.changes, [
      { layer: 'view', text: 'Requires: Fluff' },
      { layer: 'view', text: 'Excludes: Harry Potter' },
      { layer: 'view', text: 'Text: any → “dragons”' },
      { layer: 'view', text: 'Word count: any → ≥ 1,000' },
    ])

    const both = describeUpdate(
      { url: '/works/search?work_search[query]=coffee' },
      { url: '/works/search?work_search[query]=coffee&work_search[complete]=T', filter: { facets: { fandoms: { in: ['Bees'] } } } },
    )
    assert.deepEqual(both.changes, [
      { layer: 'query', text: 'Completion: any → complete only' },
      { layer: 'view', text: 'Includes: Bees' },
    ])
  })

  test('a move to another root is flagged, with what it was and would be a search of', () => {
    const tag = describeUpdate({ url: '/tags/Harry%20Potter/works', type: 'fandom' }, { url: '/works?tag_id=Marvel&work_search[complete]=T' })
    assert.deepEqual(tag.root, { from: { type: 'fandom', entity: 'Harry Potter' }, to: { type: 'tag', entity: 'Marvel' } })
    assert.deepEqual(texts(tag), ['Completion: any → complete only'], 'the owner itself is not a line')

    const search = describeUpdate({ url: '/works/search?work_search[query]=coffee' }, { url: '/works/search?work_search[query]=tea' })
    assert.deepEqual(search.root, { from: { type: 'search', entity: 'coffee' }, to: { type: 'search', entity: 'tea' } })
    assert.deepEqual(texts(search), ['Search words: “coffee” → “tea”'])
  })

  test('a works search without words moves only when its subject field does', () => {
    const was = { url: '/works/search?work_search[fandom_names]=Harry+Potter&work_search[character_names]=Draco+Malfoy' }
    const narrowed = describeUpdate(was, { url: '/works/search?work_search[fandom_names]=Harry+Potter&work_search[character_names]=Ron+Weasley' })
    assert.equal(narrowed.root, null)
    assert.deepEqual(texts(narrowed), ['Includes: Ron Weasley', 'No longer includes: Draco Malfoy'])

    const moved = describeUpdate(was, { url: '/works/search?work_search[fandom_names]=Marvel&work_search[character_names]=Draco+Malfoy' })
    assert.deepEqual(moved.root, { from: { type: 'search', entity: 'Harry Potter' }, to: { type: 'search', entity: 'Marvel' } })
    assert.deepEqual(texts(moved), ['Includes: Marvel', 'No longer includes: Harry Potter'])
  })

  test('nothing for a URL that isn\'t trackable', () => {
    assert.deepEqual(describeUpdate({ url: '/tags/Bees/works' }, { url: 'https://example.com/tags/Bees/works' }), { root: null, changes: [] })
  })
})
