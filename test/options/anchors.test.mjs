import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'

import { anchorCategory, registerAnchor, resolveAnchor } from '../../src/options_ui/composables/useAnchors.ts'
import { ANCHOR_ALIASES, anchorKey, anchorSlug, currentBookmarks, isAnchorKey } from '../../src/options_ui/model/anchors.ts'
import { landingCategory } from '../../src/options_ui/model/rail.ts'

describe('anchorSlug', () => {
  test('is how a hash is read: lowercase words joined by hyphens, accents and apostrophes dropped, acronyms whole', () => {
    assert.equal(anchorSlug('Marks & status'), 'marks-status')
    assert.equal(anchorSlug('Compress filter URLs'), 'compress-filter-urls')
    assert.equal(anchorSlug('Reader’s précis'), 'readers-precis')
  })
})

describe('isAnchorKey', () => {
  test('a key is written as a hash is read, so a link to it finds it', () => {
    assert.ok(isAnchorKey('hide-author-toolbar'))
    assert.ok(isAnchorKey('reading'))
    assert.ok(!isAnchorKey('hideAuthorToolbar'))
    assert.ok(!isAnchorKey('Reader mode'))
    assert.ok(!isAnchorKey(''))
  })

  test('every key the aliases lead to is one', () => {
    for (const [from, to] of Object.entries(ANCHOR_ALIASES)) {
      assert.ok(isAnchorKey(from), from)
      assert.ok(isAnchorKey(to), to)
    }
  })
})

describe('anchorKey', () => {
  test('an alias leads to its key, and anything else is itself', () => {
    const [[from, to]] = Object.entries(ANCHOR_ALIASES)
    assert.equal(anchorKey(from), to)
    assert.equal(anchorKey('hide-author-toolbar'), 'hide-author-toolbar')
    assert.equal(anchorKey('no-such-setting'), 'no-such-setting')
  })

  test('no alias is itself a key an alias leads to, so one step always lands', () => {
    const keys = new Set(Object.values(ANCHOR_ALIASES))
    assert.deepEqual(Object.keys(ANCHOR_ALIASES).filter(from => keys.has(from)), [])
  })
})

describe('currentBookmarks', () => {
  test('each bookmark by its key, in order, a row bookmarked under two of its ids once', () => {
    const [[from, to]] = Object.entries(ANCHOR_ALIASES)
    assert.deepEqual(currentBookmarks(['reader-mode', from, to, 'saved-lists-tea']), ['reader-mode', to, 'saved-lists-tea'])
  })

  test('leaves the bookmarks it was given alone', () => {
    const [[from]] = Object.entries(ANCHOR_ALIASES)
    const ids = Object.freeze([from])
    currentBookmarks(ids)
    assert.deepEqual(ids, [from])
  })
})

/** The page registers these as it renders: categories, sub-sections, then rows, each by its key. */
describe('resolveAnchor and anchorCategory', () => {
  before(() => {
    registerAnchor({ id: 'site-features-appearance', kind: 'category', name: 'Site features & appearance', category: 'site-features-appearance', subsection: null })
    registerAnchor({ id: 'reading', kind: 'category', name: 'Reading', category: 'reading', subsection: null })
    registerAnchor({ id: 'work-text', kind: 'subsection', name: 'Work text', category: 'reading', subsection: 'work-text' })
    registerAnchor({ id: 'reader-mode', kind: 'row', name: 'Reader mode', category: 'reading', subsection: 'work-text' })
    registerAnchor({ id: 'theme', kind: 'row', name: 'Extension theme', category: 'site-features-appearance', subsection: 'appearance' })
  })

  test('a category\'s hash names the category', () => {
    assert.equal(anchorCategory('#site-features-appearance'), 'site-features-appearance')
    assert.equal(anchorCategory('#reading'), 'reading')
  })

  test('a sub-section\'s or a row\'s hash names the category holding it', () => {
    assert.equal(anchorCategory('#work-text'), 'reading')
    assert.equal(anchorCategory('#reader-mode'), 'reading')
    assert.equal(anchorCategory('#theme'), 'site-features-appearance')
  })

  test('a hash spelled as the page shows the name finds the same thing', () => {
    assert.equal(anchorCategory('#Work%20text'), 'reading')
    assert.equal(anchorCategory('#Extension theme'), 'site-features-appearance')
  })

  test('a row\'s alias finds the row', () => {
    const alias = Object.entries(ANCHOR_ALIASES).find(([, to]) => to === 'reader-mode')?.[0]
    assert.ok(alias, 'reader mode has an alias')
    assert.equal(resolveAnchor(`#${alias}`)?.id, 'reader-mode')
  })

  test('a hash naming nothing names no category', () => {
    assert.equal(anchorCategory('#no-such-setting'), null)
    assert.equal(anchorCategory('#'), null)
    assert.equal(anchorCategory(''), null)
  })

  test('landing on a row\'s hash opens its category', () => {
    assert.equal(landingCategory('#reader-mode', anchorCategory, 'site-features-appearance'), 'reading')
    assert.equal(landingCategory('#no-such-setting', anchorCategory, 'site-features-appearance'), 'site-features-appearance')
  })
})
