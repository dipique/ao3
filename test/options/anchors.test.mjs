import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'

import { anchorCategory, registerAnchor } from '../../src/options_ui/composables/useAnchors.ts'
import { anchorSlug, categoryId } from '../../src/options_ui/model/anchors.ts'
import { landingCategory } from '../../src/options_ui/model/rail.ts'

const SITE = 'Site features & appearance'

describe('anchor ids', () => {
  test('a category is named by kebabCase', () => {
    assert.equal(categoryId(SITE), 'site-features-appearance')
    assert.equal(categoryId('Sync & Backups'), 'sync-backups')
  })

  test('a sub-section or row is named by its slug, which keeps acronyms whole', () => {
    assert.equal(anchorSlug('Marks & status'), 'marks-status')
    assert.equal(anchorSlug('Page controls Compress filter URLs'), 'page-controls-compress-filter-urls')
    assert.equal(anchorSlug('Work text Reader’s précis'), 'work-text-readers-precis')
  })
})

/** The page registers these as it renders: categories, sub-sections, then rows. */
describe('anchorCategory', () => {
  before(() => {
    registerAnchor({ id: categoryId(SITE), kind: 'category', name: SITE, category: SITE, subsection: null })
    registerAnchor({ id: categoryId('Reading'), kind: 'category', name: 'Reading', category: 'Reading', subsection: null })
    registerAnchor({ id: anchorSlug('Work text'), kind: 'subsection', name: 'Work text', category: 'Reading', subsection: 'Work text' })
    registerAnchor({ id: anchorSlug('Work text Reader mode'), kind: 'row', name: 'Reader mode', category: 'Reading', subsection: 'Work text' })
    registerAnchor({ id: anchorSlug('Appearance Extension theme'), kind: 'row', name: 'Extension theme', category: SITE, subsection: 'Appearance' })
  })

  test('a category\'s hash names the category', () => {
    assert.equal(anchorCategory('#site-features-appearance'), 'site-features-appearance')
    assert.equal(anchorCategory('#reading'), 'reading')
  })

  test('a sub-section\'s or a row\'s hash names the category holding it', () => {
    assert.equal(anchorCategory('#work-text'), 'reading')
    assert.equal(anchorCategory('#work-text-reader-mode'), 'reading')
    assert.equal(anchorCategory('#appearance-extension-theme'), 'site-features-appearance')
  })

  test('a hash spelled as the page shows the name finds the same category', () => {
    assert.equal(anchorCategory('#Work%20text'), 'reading')
    assert.equal(anchorCategory('#Extension theme'), 'site-features-appearance')
  })

  test('a hash naming nothing names no category', () => {
    assert.equal(anchorCategory('#no-such-setting'), null)
    assert.equal(anchorCategory('#'), null)
    assert.equal(anchorCategory(''), null)
  })

  test('landing on a row\'s hash opens its category', () => {
    assert.equal(landingCategory('#work-text-reader-mode', anchorCategory, 'site-features-appearance'), 'reading')
    assert.equal(landingCategory('#no-such-setting', anchorCategory, 'site-features-appearance'), 'site-features-appearance')
  })
})
