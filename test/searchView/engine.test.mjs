import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// Node 25 strips the TS types on import; engine.ts is DOM-free and its only
// non-erasable import is a type, so it loads without a build or a DOM.
import {
  applyFilters,
  buildFacets,
  buildFilteredFacets,
  cloneFilterState,
  computeView,
  emptyFilterState,
  matches,
  sortWorks,
} from '../../src/content_script/searchView/engine.ts'

/** Minimal work-like object — the engine only reads plain fields, never `el`. */
function work(overrides = {}) {
  return {
    el: null,
    workId: String(overrides.workId ?? Math.floor(Math.random() * 1e6)),
    title: 'Untitled',
    authors: [{ userId: 'someone', text: 'someone' }],
    summaryText: '',
    language: 'English',
    words: 1000,
    chapters: { written: 1, total: 1 },
    complete: true,
    kudos: 0,
    hits: 0,
    comments: 0,
    bookmarks: 0,
    dateUpdated: 0,
    dateText: '',
    markedOrder: 0,
    fandoms: [],
    rating: 'General Audiences',
    warnings: ['No Archive Warnings Apply'],
    categories: [],
    relationships: [],
    characters: [],
    freeforms: [],
    restricted: false,
    ...overrides,
  }
}

const works = [
  work({ workId: '1', title: 'Alpha', words: 500, kudos: 10, fandoms: ['Naruto'], freeforms: ['Fluff'], markedOrder: 0, rating: 'Teen And Up Audiences' }),
  work({ workId: '2', title: 'Bravo', words: 5000, kudos: 99, fandoms: ['Naruto', 'Bleach'], freeforms: ['Angst'], markedOrder: 1, complete: false }),
  work({ workId: '3', title: 'charlie', words: 50000, kudos: 1, fandoms: ['Bleach'], freeforms: ['Fluff', 'Angst'], markedOrder: 2, language: 'Français' }),
]

describe('searchView in-memory engine', () => {
  test('buildFacets counts values across the set', () => {
    const facets = buildFacets(works)
    const fandoms = Object.fromEntries(facets.fandoms.map(f => [f.value, f.count]))
    assert.equal(fandoms.Naruto, 2)
    assert.equal(fandoms.Bleach, 2)
    const freeforms = Object.fromEntries(facets.freeforms.map(f => [f.value, f.count]))
    assert.equal(freeforms.Fluff, 2)
    assert.equal(freeforms.Angst, 2)
    // Status facet is derived from `complete`.
    const status = Object.fromEntries(facets.status.map(f => [f.value, f.count]))
    assert.equal(status.Complete, 2)
    assert.equal(status['Work in Progress'], 1)
  })

  test('include facet is OR within a group', () => {
    const state = emptyFilterState()
    state.facets.fandoms.include.add('Bleach')
    const result = applyFilters(works, state)
    assert.deepEqual(result.map(w => w.workId).sort(), ['2', '3'])
  })

  test('across groups facets are AND', () => {
    const state = emptyFilterState()
    state.facets.fandoms.include.add('Naruto')
    state.facets.freeforms.include.add('Angst')
    const result = applyFilters(works, state)
    assert.deepEqual(result.map(w => w.workId), ['2'])
  })

  test('exclude wins over include', () => {
    const state = emptyFilterState()
    state.facets.freeforms.include.add('Fluff') // works 1 and 3
    state.facets.fandoms.exclude.add('Bleach') // drops work 3
    const result = applyFilters(works, state)
    assert.deepEqual(result.map(w => w.workId), ['1'])
  })

  test('free-text matches across title and tags, all terms required', () => {
    assert.equal(matches(works[0], { ...emptyFilterState(), text: 'alpha' }), true)
    assert.equal(matches(works[0], { ...emptyFilterState(), text: 'naruto fluff' }), true)
    assert.equal(matches(works[0], { ...emptyFilterState(), text: 'naruto angst' }), false)
  })

  test('word-count bounds are inclusive', () => {
    const state = { ...emptyFilterState(), wordsMin: 1000, wordsMax: 10000 }
    assert.deepEqual(applyFilters(works, state).map(w => w.workId), ['2'])
  })

  test('sort by words ascending and descending', () => {
    assert.deepEqual(sortWorks(works, 'words', 'asc').map(w => w.workId), ['1', '2', '3'])
    assert.deepEqual(sortWorks(works, 'words', 'desc').map(w => w.workId), ['3', '2', '1'])
  })

  test('sort by title is case-insensitive (natural collation)', () => {
    // "charlie" should sort after "Bravo" despite lowercasing.
    assert.deepEqual(sortWorks(works, 'title', 'asc').map(w => w.title), ['Alpha', 'Bravo', 'charlie'])
  })

  test('default sort is marked order', () => {
    const result = applyFilters(works, emptyFilterState())
    assert.deepEqual(result.map(w => w.markedOrder), [0, 1, 2])
  })

  test('buildFilteredFacets with no filter matches the full-set counts', () => {
    const filtered = buildFilteredFacets(works, emptyFilterState())
    assert.equal(filtered.fandoms.get('Naruto'), 2)
    assert.equal(filtered.fandoms.get('Bleach'), 2)
    assert.equal(filtered.freeforms.get('Fluff'), 2)
    assert.equal(filtered.freeforms.get('Angst'), 2)
  })

  test('drill-down counts shrink to the filtered subset', () => {
    // wordsMin 1000 keeps works 2 (5000) and 3 (50000).
    const filtered = buildFilteredFacets(works, { ...emptyFilterState(), wordsMin: 1000 })
    assert.equal(filtered.fandoms.get('Naruto'), 1) // only work 2
    assert.equal(filtered.fandoms.get('Bleach'), 2) // works 2 and 3
  })

  test('a group\'s own selection is ignored when counting that group', () => {
    const state = emptyFilterState()
    state.facets.fandoms.include.add('Naruto')
    const filtered = buildFilteredFacets(works, state)
    // Selecting Naruto must NOT zero out its sibling values in the same group,
    // so the user can still see what picking Bleach (OR) would add.
    assert.equal(filtered.fandoms.get('Naruto'), 2)
    assert.equal(filtered.fandoms.get('Bleach'), 2)
    // Other groups DO narrow to the Naruto works (1 and 2).
    assert.equal(filtered.freeforms.get('Fluff'), 1) // work 1
    assert.equal(filtered.freeforms.get('Angst'), 1) // work 2
  })

  test('an exclude narrows other groups but not its own counts', () => {
    const state = emptyFilterState()
    state.facets.fandoms.exclude.add('Bleach') // drops works 2 and 3
    const filtered = buildFilteredFacets(works, state)
    assert.equal(filtered.fandoms.get('Bleach'), 2) // own group ignores the exclude
    assert.equal(filtered.freeforms.get('Fluff'), 1) // only work 1 remains
    assert.equal(filtered.freeforms.get('Angst'), undefined)
  })

  // cloneFilterState backs the view-state snapshot used to reopen the view after
  // a global re-run; the clone must be fully independent of the original.
  test('cloneFilterState deep-copies, leaving the original untouched', () => {
    const original = emptyFilterState()
    original.text = 'naruto'
    original.facets.fandoms.include.add('Naruto')
    original.facets.freeforms.exclude.add('Angst')
    original.wordsMin = 100
    original.wordsMax = 5000
    original.sort = 'kudos'
    original.dir = 'desc'

    const copy = cloneFilterState(original)
    assert.equal(copy.text, 'naruto')
    assert.deepEqual([...copy.facets.fandoms.include], ['Naruto'])
    assert.deepEqual([...copy.facets.freeforms.exclude], ['Angst'])
    assert.deepEqual([copy.wordsMin, copy.wordsMax, copy.sort, copy.dir], [100, 5000, 'kudos', 'desc'])

    // Mutating the copy must not bleed into the original (independent Sets).
    copy.text = 'changed'
    copy.facets.fandoms.include.add('Bleach')
    assert.equal(original.text, 'naruto')
    assert.deepEqual([...original.facets.fandoms.include], ['Naruto'])
  })

  // computeView is the optimized hot path; it must stay equivalent to running
  // applyFilters (as a set) and buildFilteredFacets separately.
  test('computeView matches applyFilters + buildFilteredFacets for varied states', () => {
    const mkState = (mut) => {
      const s = emptyFilterState()
      mut?.(s)
      return s
    }
    const states = [
      emptyFilterState(),
      mkState((s) => { s.text = 'naruto fluff' }),
      mkState((s) => { s.wordsMin = 1000 }),
      mkState(s => s.facets.fandoms.include.add('Naruto')),
      mkState(s => s.facets.fandoms.exclude.add('Bleach')),
      mkState((s) => {
        s.facets.fandoms.include.add('Naruto')
        s.facets.freeforms.exclude.add('Angst')
      }),
    ]
    for (const state of states) {
      const { visible, facetCounts } = computeView(works, state)
      const expectedVisible = new Set(applyFilters(works, state))
      assert.deepEqual([...visible].map(w => w.workId).sort(), [...expectedVisible].map(w => w.workId).sort())
      const expectedCounts = buildFilteredFacets(works, state)
      for (const key of Object.keys(expectedCounts))
        assert.deepEqual([...facetCounts[key].entries()].sort(), [...expectedCounts[key].entries()].sort())
    }
  })
})
