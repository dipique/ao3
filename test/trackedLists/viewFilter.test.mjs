import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { filteredKey } from '../../src/common/trackedLists.ts'
import { emptyFilterState, matches } from '../../src/content_script/searchView/engine.ts'
import { excludedTagNames, filterStateOf, trackedFilterOf } from '../../src/content_script/tracked/viewFilter.ts'

/**
 * A custom search view's filter as a tracked list keeps it, and back: what a
 * list is made with, what it is put back on screen with, what its works are
 * tested against in the review, and what the archive is asked to leave out.
 */

/** A work as the engine reads one — only plain fields, never a node. */
function work(overrides = {}) {
  return {
    workId: '1',
    title: 'Untitled',
    authors: [{ userId: 'someone', text: 'someone' }],
    summaryText: '',
    language: 'English',
    words: 1000,
    complete: true,
    rating: 'General Audiences',
    warnings: ['No Archive Warnings Apply'],
    categories: [],
    fandoms: [],
    relationships: [],
    characters: [],
    freeforms: [],
    ...overrides,
  }
}

describe('trackedFilterOf', () => {
  test('include, exclude and require become in, ex and req, sorted', () => {
    const state = emptyFilterState()
    state.facets.characters.exclude.add('Ron Weasley')
    state.facets.characters.exclude.add('Draco Malfoy')
    state.facets.freeforms.include.add('Fluff')
    state.facets.fandoms.require.add('Harry Potter - J. K. Rowling')
    assert.deepEqual(trackedFilterOf(state), {
      facets: {
        characters: { ex: ['Draco Malfoy', 'Ron Weasley'] },
        fandoms: { req: ['Harry Potter - J. K. Rowling'] },
        freeforms: { in: ['Fluff'] },
      },
    })
  })

  test('the text box and the word count come along; the sort does not', () => {
    const state = emptyFilterState()
    state.text = '  slow   burn '
    state.wordsMin = 5000
    state.sort = 'kudos'
    assert.deepEqual(trackedFilterOf(state), { text: 'slow burn', words: [5000, null] })
  })

  test('status and list source are never kept', () => {
    const state = emptyFilterState()
    state.facets.status.include.add('Ready')
    state.facets.source.exclude.add('Alpha')
    assert.equal(trackedFilterOf(state), undefined)
  })

  test('a view that narrows nothing is no filter at all', () => {
    assert.equal(trackedFilterOf(emptyFilterState()), undefined)
  })

  test('the same selections made in another order key alike', () => {
    const one = emptyFilterState()
    one.facets.characters.exclude.add('B')
    one.facets.characters.exclude.add('A')
    const two = emptyFilterState()
    two.facets.characters.exclude.add('A')
    two.facets.characters.exclude.add('B')
    assert.equal(filteredKey('k', trackedFilterOf(one)), filteredKey('k', trackedFilterOf(two)))
  })
})

describe('filterStateOf', () => {
  const stored = {
    facets: {
      characters: { ex: ['Draco Malfoy'] },
      freeforms: { in: ['Fluff'], req: ['Hurt/Comfort'] },
    },
    text: 'slow burn',
    words: [1000, 50000],
  }

  test('reads a stored filter back as the view’s own', () => {
    const state = filterStateOf(stored)
    assert.deepEqual([...state.facets.characters.exclude], ['Draco Malfoy'])
    assert.deepEqual([...state.facets.freeforms.include], ['Fluff'])
    assert.deepEqual([...state.facets.freeforms.require], ['Hurt/Comfort'])
    assert.equal(state.text, 'slow burn')
    assert.deepEqual([state.wordsMin, state.wordsMax], [1000, 50000])
  })

  test('there and back is the same filter', () => {
    assert.deepEqual(trackedFilterOf(filterStateOf(stored)), stored)
  })

  test('null when there is none', () => {
    assert.equal(filterStateOf(undefined), null)
    assert.equal(filterStateOf({}), null)
    assert.equal(filterStateOf({ facets: { characters: {} } }), null)
  })

  test('a group this build doesn’t know passes every work, as do status and list source', () => {
    const state = filterStateOf({ facets: { future: { ex: ['X'] }, status: { in: ['Waiting'] }, source: { in: ['Alpha'] } } })
    assert.ok(state, 'there is a filter, even if nothing in it can be applied here')
    assert.ok(matches(work(), state))
    assert.equal(state.facets.status.include.size, 0)
    assert.equal(state.facets.source.include.size, 0)
  })

  test('what it rejects is what the view rejected', () => {
    const state = filterStateOf({ facets: { characters: { ex: ['Draco Malfoy'] } } })
    assert.equal(matches(work({ characters: ['Draco Malfoy', 'Harry Potter'] }), state), false)
    assert.equal(matches(work({ characters: ['Harry Potter'] }), state), true)
  })
})

describe('excludedTagNames', () => {
  test('every excluded tag, whatever its kind', () => {
    assert.deepEqual(excludedTagNames({
      facets: {
        characters: { ex: ['Draco Malfoy'] },
        freeforms: { ex: ['Fluff'], in: ['Angst'] },
        rating: { ex: ['Explicit'] },
        warnings: { ex: ['Major Character Death'] },
        categories: { ex: ['M/M'] },
        fandoms: { ex: ['Naruto'] },
        relationships: { ex: ['Draco Malfoy/Harry Potter'] },
      },
    }), ['Draco Malfoy', 'Draco Malfoy/Harry Potter', 'Explicit', 'Fluff', 'M/M', 'Major Character Death', 'Naruto'])
  })

  test('not language or completion, which aren’t tags, nor anything included or required', () => {
    assert.deepEqual(excludedTagNames({
      facets: {
        language: { ex: ['Français'] },
        completion: { ex: ['Work in Progress'] },
        freeforms: { in: ['Fluff'], req: ['Angst'] },
      },
      text: 'coffee',
    }), [])
  })

  test('none without a filter', () => {
    assert.deepEqual(excludedTagNames(undefined), [])
  })
})
