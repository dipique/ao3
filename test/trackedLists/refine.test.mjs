import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { fillMeta, parseRefiningMark, requery, tagTypeFromProfile } from '../../src/common/trackedLists.ts'

const HP = '/tags/Harry%20Potter%20-%20J*d*%20K*d*%20Rowling/works'

describe('the refining mark', () => {
  test('reads back what a tab stored', () => {
    assert.deepEqual(parseRefiningMark('{"id":"c0ffee","restore":true}'), { id: 'c0ffee', restore: true })
    assert.deepEqual(parseRefiningMark('{"id":"c0ffee","restore":false}'), { id: 'c0ffee', restore: false })
    assert.deepEqual(parseRefiningMark('{"id":"c0ffee"}'), { id: 'c0ffee', restore: false }, 'restore is only ever set on purpose')
  })

  test('anything else is no mark', () => {
    for (const text of [null, undefined, 42, '', 'c0ffee', '{', '[]', '{"id":7}', '{"id":""}', '{"id":"a b"}', '{"id":"../x"}', `{"id":"${'a'.repeat(33)}"}`])
      assert.equal(parseRefiningMark(text), null, String(text))
  })
})

describe('a tag\'s category, from its own page', () => {
  test('each of the archive\'s categories', () => {
    for (const [category, type] of [
      ['Fandom', 'fandom'],
      ['Character', 'character'],
      ['Relationship', 'relationship'],
      ['Additional Tags', 'freeform'],
      ['Rating', 'rating'],
      ['Archive Warning', 'warning'],
      ['Category', 'category'],
    ])
      assert.equal(tagTypeFromProfile(`This tag belongs to the ${category} Category.`), type, category)
  })

  test('however the page wraps and spaces it', () => {
    assert.equal(tagTypeFromProfile('\n  This tag belongs to the\n    Additional   Tags Category.\n  It\'s a canonical tag.'), 'freeform')
    assert.equal(tagTypeFromProfile('this tag belongs to the character category'), 'character')
  })

  test('nothing for a sentence it doesn\'t know', () => {
    assert.equal(tagTypeFromProfile('This tag belongs to the Media Category.'), null)
    assert.equal(tagTypeFromProfile('This tag has not been marked common.'), null)
    assert.equal(tagTypeFromProfile(''), null)
    assert.equal(tagTypeFromProfile(undefined), null)
  })
})

describe('fillMeta', () => {
  test('a tag\'s list reading "Tag" takes the category the page names', () => {
    assert.deepEqual(fillMeta({ url: '/tags/Draco%20Malfoy/works' }, { type: 'character', entity: 'draco malfoy' }), { type: 'character', entity: 'Draco Malfoy' })
    assert.deepEqual(fillMeta({ url: '/tags/Draco%20Malfoy/works', type: 'tag' }, { type: 'character', entity: 'Draco Malfoy' }), { type: 'character', entity: 'Draco Malfoy' })
    assert.deepEqual(fillMeta({ url: '/tags/marriage%20problems' }, { type: 'freeform', entity: 'marriage problems' }), { type: 'freeform', entity: 'marriage problems' })
  })

  test('a series reading as its id takes the page\'s title', () => {
    assert.deepEqual(fillMeta({ url: '/series/4232377' }, { type: 'series', entity: 'The Long Way Round' }), { type: 'series', entity: 'The Long Way Round' })
  })

  test('only placeholders are filled', () => {
    assert.equal(fillMeta({ url: '/tags/Draco%20Malfoy/works', type: 'freeform' }, { type: 'character', entity: 'Draco Malfoy' }), null)
    assert.equal(fillMeta({ url: '/series/4232377', type: 'series', entity: 'Its Title' }, { type: 'series', entity: 'Another' }), null)
    assert.equal(fillMeta({ url: '/users/someone/works' }, { type: 'author', entity: 'someone' }), null, 'an author is never a placeholder')
  })

  test('nothing learned is nothing to fill', () => {
    assert.equal(fillMeta({ url: '/tags/Draco%20Malfoy/works' }, { type: 'tag', entity: 'Draco Malfoy' }), null)
    assert.equal(fillMeta({ url: '/series/4232377' }, { type: 'series', entity: '4232377' }), null)
    assert.equal(fillMeta({ url: '/series/4232377' }, { type: 'series', entity: '' }), null)
  })

  test('what a page says about another root is ignored', () => {
    assert.equal(fillMeta({ url: '/tags/Draco%20Malfoy/works' }, { type: 'character', entity: 'Harry Potter' }), null)
    assert.equal(fillMeta({ url: '/tags/Draco%20Malfoy/works' }, { type: 'author', entity: 'Draco Malfoy' }), null)
    assert.equal(fillMeta({ url: 'https://example.com/series/1' }, { type: 'series', entity: 'x' }), null)
  })
})

describe('requery', () => {
  const hp = { url: HP, type: 'fandom', entity: 'Harry Potter - J. K. Rowling' }
  const refined = '/works?exclude_work_search[character_ids][]=1234&work_search[complete]=T&commit=Sort+and+Filter&tag_id=Harry+Potter+-+J*d*+K*d*+Rowling'

  test('the page\'s query, its address normalized', () => {
    assert.deepEqual(requery(hp, { url: `https://archiveofourown.org${refined}` }), {
      kind: 'works-filter',
      url: '/works?exclude_work_search[character_ids][]=1234&work_search[complete]=T&tag_id=Harry+Potter+-+J*d*+K*d*+Rowling',
      type: 'fandom',
      entity: 'Harry Potter - J. K. Rowling',
    })
  })

  test('a scanned tag stays scanned unless the page has checked it afresh', () => {
    const tag = { url: '/tags/marriage%20problems', scan: true }
    assert.equal(requery(tag, { url: '/tags/marriage%20woes' }).scan, true)
    assert.equal('scan' in requery(tag, { url: '/tags/marriage%20woes', scan: false }), false)
    assert.equal(requery({ url: tag.url }, { url: '/tags/marriage%20woes', scan: true }).scan, true)
    assert.equal('scan' in requery({ url: tag.url }, { url: '/tags/marriage%20woes' }), false)
  })

  test('the view filter is stored canonical, and dropped when there is none', () => {
    const tag = { url: '/tags/marriage%20problems' }
    assert.deepEqual(requery(tag, { url: tag.url, filter: { facets: { characters: { ex: ['b', 'a', 'b'] } } } }).filter, { facets: { characters: { ex: ['a', 'b'] } } })
    assert.equal('filter' in requery(tag, { url: tag.url }), false)
    assert.equal('filter' in requery(tag, { url: tag.url, filter: { facets: {} } }), false)
  })

  test('type and entity follow the query: what the page knows, else what still fits', () => {
    // The root stays and the page names no category: the stored one still fits.
    assert.deepEqual(pick(requery(hp, { url: refined })), { type: 'fandom', entity: 'Harry Potter - J. K. Rowling' })
    // Another tag, whose category the page names.
    assert.deepEqual(
      pick(requery(hp, { url: '/tags/Draco%20Malfoy/works', meta: { type: 'character', entity: 'Draco Malfoy' } })),
      { type: 'character', entity: 'Draco Malfoy' },
    )
    // Another tag, whose category nothing has named yet: the old one doesn't carry over.
    assert.deepEqual(pick(requery(hp, { url: '/tags/Draco%20Malfoy/works' })), { type: 'tag', entity: 'Draco Malfoy' })
  })

  test('a series\' title can\'t be checked against another series\' id, so moving series drops it', () => {
    const series = { url: '/series/1', type: 'series', entity: 'Series One' }
    assert.deepEqual(pick(requery(series, { url: '/series/1' })), { type: 'series', entity: 'Series One' })
    assert.deepEqual(pick(requery(series, { url: '/series/2' })), { type: 'series', entity: '2' })
    assert.deepEqual(pick(requery(series, { url: '/series/2', meta: { type: 'series', entity: 'Series Two' } })), { type: 'series', entity: 'Series Two' })
  })

  test('nothing for a page that isn\'t trackable', () => {
    assert.equal(requery(hp, { url: 'https://example.com/tags/x/works' }), null)
  })
})

function pick(entry) {
  return { type: entry.type, entity: entry.entity }
}
