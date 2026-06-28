import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// Node 25 strips the TS types on import; engine.ts is DOM-free and its only
// non-erasable import is a type, so it loads without a build or a DOM.
import {
  applyFilters,
  buildFacets,
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
})
