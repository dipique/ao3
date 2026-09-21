import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// Node 25 strips the TS types on import; engine.ts is DOM-free and its only
// non-erasable import is a type, so it loads without a build or a DOM.
import {
  applyFilters,
  buildFacets,
  buildFilteredFacets,
  cloneFilterState,
  completionOf,
  completionValue,
  computeView,
  emptyFilterState,
  FACET_KEYS,
  facetValues,
  layoutStablePages,
  matches,
  orderFacetKeys,
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
    // Completion facet is derived from `complete`.
    const completion = Object.fromEntries(facets.completion.map(f => [f.value, f.count]))
    assert.equal(completion.Complete, 2)
    assert.equal(completion['Work in Progress'], 1)
  })

  test('include facet is OR within a group', () => {
    const state = emptyFilterState()
    state.facets.fandoms.include.add('Bleach')
    const result = applyFilters(works, state)
    assert.deepEqual(result.map(w => w.workId).sort(), ['2', '3'])
  })

  test('require is AND within a group', () => {
    // work 3 has both Fluff and Angst; work 1 only Fluff; work 2 only Angst.
    const state = emptyFilterState()
    state.facets.freeforms.require.add('Fluff')
    state.facets.freeforms.require.add('Angst')
    const result = applyFilters(works, state)
    assert.deepEqual(result.map(w => w.workId), ['3'])
  })

  test('require composes with exclude (exclude still wins)', () => {
    const state = emptyFilterState()
    state.facets.freeforms.require.add('Fluff') // works 1 and 3
    state.facets.fandoms.exclude.add('Bleach') // drops work 3
    assert.deepEqual(applyFilters(works, state).map(w => w.workId), ['1'])
  })

  test('computeView resultCounts count the visible set (require preview)', () => {
    const state = emptyFilterState()
    state.facets.fandoms.include.add('Naruto') // visible: works 1 and 2
    const { visible, resultCounts } = computeView(works, state)
    assert.deepEqual([...visible].map(w => w.workId).sort(), ['1', '2'])
    // Among the two visible works, Fluff is on work 1 and Angst on work 2.
    assert.equal(resultCounts.freeforms.get('Fluff'), 1)
    assert.equal(resultCounts.freeforms.get('Angst'), 1)
    // Requiring Naruto leaves both visible works (its drill-down stays 2).
    assert.equal(resultCounts.fandoms.get('Naruto'), 2)
    // Bleach is on only one of the visible works (work 2).
    assert.equal(resultCounts.fandoms.get('Bleach'), 1)
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

describe('the status facet', () => {
  test('an unstamped work reads as Ready', () => {
    // Untracked works — everything on a to-read list that isn't marked ongoing —
    // are ready to read by definition, and the fallback is also what keeps every
    // other test in this file (whose factory has no statuses field) honest.
    assert.deepEqual(facetValues(work(), 'status'), ['Ready'])
  })

  test('precomputed values are used as-is', () => {
    // The host stamps these in a post-pass; the engine never derives them, since
    // they depend on the mark table, the saved-work index and today's date.
    assert.deepEqual(
      facetValues(work({ statuses: ['Ongoing', 'Waiting'] }), 'status'),
      ['Ongoing', 'Waiting'],
    )
  })

  test('filtering to Ready drops the works that are not', () => {
    const set = [
      work({ workId: '1', markedOrder: 0 }),
      work({ workId: '2', markedOrder: 1, statuses: ['Ongoing', 'Waiting'] }),
      work({ workId: '3', markedOrder: 2, statuses: ['Ongoing', 'Caught up'] }),
    ]
    const state = emptyFilterState()
    state.facets.status.include.add('Ready')
    assert.deepEqual(applyFilters(set, state).map(w => w.workId), ['1'])
  })

  test('a work carries several statuses at once, so require and exclude both bite', () => {
    // The point of merging readiness and the marks into one group: "ongoing and
    // still ready" is an AND within it, which only `require` can express.
    const set = [
      work({ workId: '1', markedOrder: 0, statuses: ['Ongoing', 'Ready'] }),
      work({ workId: '2', markedOrder: 1, statuses: ['Ongoing', 'Caught up'] }),
      work({ workId: '3', markedOrder: 2, statuses: ['Unread', 'Ready'] }),
    ]
    const required = emptyFilterState()
    required.facets.status.require.add('Ongoing')
    required.facets.status.require.add('Ready')
    assert.deepEqual(applyFilters(set, required).map(w => w.workId), ['1'])

    // Excluding Unread is how you ask for "everything I've formed a view on".
    const excluded = emptyFilterState()
    excluded.facets.status.exclude.add('Unread')
    assert.deepEqual(applyFilters(set, excluded).map(w => w.workId), ['1', '2'])
  })
})

describe('the completion facet', () => {
  test('reads the work’s own complete flag', () => {
    assert.deepEqual(facetValues(work(), 'completion'), ['Complete'])
    assert.deepEqual(facetValues(work({ complete: false }), 'completion'), ['Work in Progress'])
  })

  /** A completion selection from `{ include, exclude, require }` value lists. */
  const sel = ({ include = [], exclude = [], require = [] } = {}) =>
    ({ include: new Set(include), exclude: new Set(exclude), require: new Set(require) })

  test('an empty selection shows both sides', () => {
    assert.equal(completionOf(sel()), null)
  })

  test('including one side, or excluding the other, narrows to it', () => {
    assert.equal(completionOf(sel({ include: ['Complete'] })), 'complete')
    assert.equal(completionOf(sel({ exclude: ['Work in Progress'] })), 'complete')
    assert.equal(completionOf(sel({ require: ['Work in Progress'] })), 'incomplete')
    assert.equal(completionOf(sel({ exclude: ['Complete'] })), 'incomplete')
  })

  test('a selection admitting both sides, or neither, is no single choice', () => {
    assert.equal(completionOf(sel({ include: ['Complete', 'Work in Progress'] })), null)
    assert.equal(completionOf(sel({ exclude: ['Complete', 'Work in Progress'] })), null)
  })

  test('each choice writes the value that reads back as it', () => {
    for (const choice of ['complete', 'incomplete'])
      assert.equal(completionOf(sel({ include: [completionValue(choice)] })), choice)
  })
})

describe('the list-source facet', () => {
  test('reads the sources the host stamped, and is empty without them', () => {
    assert.deepEqual(facetValues(work({ sources: ['Hurt/comfort', 'coffee'] }), 'source'), ['Hurt/comfort', 'coffee'])
    // Every view but a merged one leaves it unset, which is what keeps the group
    // out of the sidebar there: no values, no group.
    assert.deepEqual(facetValues(work(), 'source'), [])
    assert.deepEqual(buildFacets([work(), work()]).source, [])
  })
})

describe('the saved facet order', () => {
  test('no saved order is the default one', () => {
    assert.deepEqual(orderFacetKeys(undefined), FACET_KEYS)
    assert.deepEqual(orderFacetKeys([]), FACET_KEYS)
  })

  test('a saved order is kept, and unknown keys in it are dropped', () => {
    const saved = [...FACET_KEYS].reverse()
    assert.deepEqual(orderFacetKeys([...saved, 'kudos-per-word']), saved)
  })

  test('a key the saved order never heard of lands at its default position', () => {
    // What a reader who reordered their groups before `source` existed has
    // stored. It belongs between status and rating, as it does for everyone
    // else — not at the bottom, under Completion Status.
    const saved = FACET_KEYS.filter(key => key !== 'source')
    assert.deepEqual(orderFacetKeys(saved), FACET_KEYS)

    // And relative to where its predecessors actually are now, not to where
    // they started: status has been dragged to the end, so source follows it.
    const moved = [...saved.filter(key => key !== 'status'), 'status']
    assert.deepEqual(orderFacetKeys(moved), [...moved, 'source'])
  })

  test('a key with none of its predecessors saved goes to the front', () => {
    assert.deepEqual(orderFacetKeys(['language']), ['status', 'source', 'rating', 'warnings', 'categories', 'fandoms', 'relationships', 'characters', 'freeforms', 'language', 'completion'])
  })

  test('every key comes back exactly once, whatever the saved order says', () => {
    for (const saved of [['completion', 'completion', 'status'], ['freeforms'], [...FACET_KEYS].reverse()]) {
      const ordered = orderFacetKeys(saved)
      assert.deepEqual([...ordered].sort(), [...FACET_KEYS].sort())
    }
  })
})

describe('a frozen page layout', () => {
  /** `layoutStablePages` over `sorted`, with `visible` named by work id. */
  const lay = (order, sorted, visibleIds) =>
    layoutStablePages(order, sorted, new Set(sorted.filter(w => visibleIds.includes(w.workId))))

  const five = ['1', '2', '3', '4', '5'].map(workId => work({ workId }))

  test('with everything still passing, it is the order itself', () => {
    const { ordered, dropped } = lay(['1', '2', '3', '4', '5'], five, ['1', '2', '3', '4', '5'])
    assert.deepEqual(ordered.map(w => w.workId), ['1', '2', '3', '4', '5'])
    assert.equal(dropped.size, 0)
  })

  test('a work that stopped passing keeps its slot instead of letting the rest slide back', () => {
    // The point of the whole exercise: without the freeze, 4 and 5 move up a
    // place each and whatever was first on the next page lands on the last one.
    const { ordered, dropped } = lay(['1', '2', '3', '4', '5'], five, ['1', '2', '4', '5'])
    assert.deepEqual(ordered.map(w => w.workId), ['1', '2', '3', '4', '5'])
    assert.deepEqual([...dropped.keys()].map(w => w.workId), ['3'])
  })

  test('the reason separates the reader’s rules from the reader’s filter', () => {
    const hidden = work({ workId: 'h', hidden: true })
    const handed = work({ workId: 'f', filtered: true })
    const unmatched = work({ workId: 'u' })
    const { dropped } = lay(['h', 'f', 'u'], [hidden, handed, unmatched], [])
    assert.equal(dropped.get(hidden), 'hidden')
    // Handed to the view's own filter by the hide pass is still a rule hiding it.
    assert.equal(dropped.get(handed), 'hidden')
    assert.equal(dropped.get(unmatched), 'filtered')
  })

  test('an id nothing answers to any more takes its slot with it', () => {
    const { ordered, dropped } = lay(['1', 'gone', '2'], [five[0], five[1]], ['1', '2'])
    assert.deepEqual(ordered.map(w => w.workId), ['1', '2'])
    assert.equal(dropped.size, 0)
  })

  test('a repeated id claims one slot', () => {
    const { ordered } = lay(['1', '1', '2'], five, ['1', '2', '3', '4', '5'])
    // 3–5 are newcomers as far as this order is concerned, so they follow.
    assert.deepEqual(ordered.map(w => w.workId), ['1', '2', '3', '4', '5'])
  })

  test('a work the order never heard of goes on the end, in sort order', () => {
    const { ordered, dropped } = lay(['5', '3'], five, ['1', '2', '3', '4', '5'])
    assert.deepEqual(ordered.map(w => w.workId), ['5', '3', '1', '2', '4'])
    assert.equal(dropped.size, 0)
  })

  test('a newcomer that does not pass is not added at all', () => {
    // Only the frozen slots are held open; nothing earns one by failing.
    const { ordered } = lay(['1'], five, ['1', '2'])
    assert.deepEqual(ordered.map(w => w.workId), ['1', '2'])
  })

  test('an empty order lays out exactly what passes', () => {
    const { ordered, dropped } = lay([], five, ['2', '4'])
    assert.deepEqual(ordered.map(w => w.workId), ['2', '4'])
    assert.equal(dropped.size, 0)
  })

  test('it agrees with the plain layout the view would otherwise compute', () => {
    const state = emptyFilterState()
    state.facets.fandoms.include.add('Naruto')
    const { visible } = computeView(works, state)
    const plain = sortWorks(works, state.sort, state.dir).filter(w => visible.has(w))
    const { ordered, dropped } = layoutStablePages([], sortWorks(works, state.sort, state.dir), visible)
    assert.deepEqual(ordered, plain)
    assert.equal(dropped.size, 0)
  })

  test('holding the layout across a filter that narrows it keeps every slot', () => {
    const state = emptyFilterState()
    const before = computeView(works, state)
    const order = sortWorks(works, state.sort, state.dir).filter(w => before.visible.has(w)).map(w => w.workId)
    state.facets.fandoms.include.add('Naruto')
    const after = computeView(works, state)
    const { ordered, dropped } = layoutStablePages(order, sortWorks(works, state.sort, state.dir), after.visible)
    assert.deepEqual(ordered.map(w => w.workId), order)
    // "charlie" is Bleach only, so it is the one the new filter drops.
    assert.deepEqual([...dropped.keys()].map(w => w.workId), ['3'])
    assert.deepEqual([...dropped.values()], ['filtered'])
  })
})
