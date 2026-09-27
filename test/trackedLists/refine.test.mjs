import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { fillMeta, parseRefiningMark, planUndo, planUpdate, tagTypeFromProfile, trackedKey } from '../../src/common/trackedLists.ts'

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

describe('planUpdate', () => {
  const since = 20_000
  const hp = { id: 'hp', kind: 'works-filter', url: HP, alias: 'Fandom: Harry Potter - J. K. Rowling', type: 'fandom', entity: 'Harry Potter - J. K. Rowling', tracked: true, since }
  const tea = { id: 'tea', kind: 'text-search', url: '/works/search?work_search[query]=tea', alias: 'Tea', tracked: false, since: since - 3 }
  const lists = [hp, tea]
  const refined = '/works?exclude_work_search[character_ids][]=1234&work_search[complete]=T&commit=Sort+and+Filter&tag_id=Harry+Potter+-+J*d*+K*d*+Rowling'

  test('replaces the query and keeps what makes it the same list', () => {
    const plan = planUpdate(lists, 'hp', { url: `https://archiveofourown.org${refined}` })
    assert.equal(plan.ok, true)
    assert.deepEqual(plan.after, {
      ...hp,
      url: '/works?exclude_work_search[character_ids][]=1234&work_search[complete]=T&tag_id=Harry+Potter+-+J*d*+K*d*+Rowling',
    })
    assert.equal(plan.before, hp)
    assert.deepEqual(plan.lists, [plan.after, tea], 'in place, the others untouched')
  })

  test('a paused list stays paused, and a scanned tag stays scanned unless told', () => {
    const plan = planUpdate(lists, 'tea', { url: '/works/search?work_search[query]=tea&work_search[complete]=T' })
    assert.equal(plan.after.tracked, false)
    assert.equal(plan.after.since, since - 3)

    const tag = { id: 't', kind: 'tag-works', url: '/tags/marriage%20problems', alias: 'x', tracked: true, since, scan: true }
    assert.equal(planUpdate([tag], 't', { url: '/tags/marriage%20woes' }).after.scan, true)
    assert.equal('scan' in planUpdate([tag], 't', { url: '/tags/marriage%20woes', scan: false }).after, false)
  })

  test('writes the title it\'s given, trimmed, and keeps the old one when given none', () => {
    assert.equal(planUpdate(lists, 'hp', { url: refined, alias: '  HP, no Draco ' }).after.alias, 'HP, no Draco')
    assert.equal(planUpdate(lists, 'hp', { url: refined }).after.alias, hp.alias)
  })

  test('refuses a title another list has, and says which', () => {
    const plan = planUpdate(lists, 'hp', { url: refined, alias: ' TEA ' })
    assert.equal(plan.ok, false)
    assert.equal(plan.reason, 'title')
    assert.equal(plan.other.id, 'tea')
  })

  test('a title the list already had is never refused, even one sync has doubled up', () => {
    const twin = { ...tea, id: 'twin', alias: hp.alias.toUpperCase(), url: '/works/search?work_search[query]=twin' }
    assert.equal(planUpdate([hp, twin], 'hp', { url: refined }).ok, true)
    assert.equal(planUpdate([hp, twin], 'hp', { url: refined, alias: hp.alias }).ok, true)
  })

  test('refuses to make a list identical to another, and says which', () => {
    const plan = planUpdate(lists, 'hp', { url: '/works/search?work_search[query]=tea&work_search[sort_column]=title' })
    assert.equal(plan.ok, false)
    assert.equal(plan.reason, 'duplicate')
    assert.equal(plan.other.id, 'tea')
  })

  test('the view filter is stored canonical, and dropped when there is none', () => {
    const tag = { id: 't', kind: 'tag-works', url: '/tags/marriage%20problems', alias: 'x', tracked: true, since, filter: { text: 'old' } }
    const plan = planUpdate([tag], 't', { url: tag.url, filter: { facets: { characters: { ex: ['b', 'a', 'b'] } } } })
    assert.deepEqual(plan.after.filter, { facets: { characters: { ex: ['a', 'b'] } } })
    assert.equal('filter' in planUpdate([tag], 't', { url: tag.url }).after, false)
    assert.equal('filter' in planUpdate([tag], 't', { url: tag.url, filter: { facets: {} } }).after, false)
  })

  test('a filtered list can\'t be matched to the unfiltered page as a duplicate of itself', () => {
    const tag = { id: 't', kind: 'tag-works', url: '/tags/marriage%20problems', alias: 'x', tracked: true, since, filter: { text: 'old' } }
    const other = { id: 'o', kind: 'tag-works', url: '/tags/marriage%20problems', alias: 'y', tracked: true, since }
    const plan = planUpdate([tag, other], 't', { url: tag.url })
    assert.equal(plan.reason, 'duplicate')
    assert.equal(plan.other.id, 'o')
  })

  test('type and entity follow the query: what the page knows, else what still fits', () => {
    // The root stays and the page names no category: the stored one still fits.
    assert.deepEqual(pick(planUpdate(lists, 'hp', { url: refined }).after), { type: 'fandom', entity: 'Harry Potter - J. K. Rowling' })
    // Another tag, whose category the page names.
    assert.deepEqual(
      pick(planUpdate(lists, 'hp', { url: '/tags/Draco%20Malfoy/works', meta: { type: 'character', entity: 'Draco Malfoy' } }).after),
      { type: 'character', entity: 'Draco Malfoy' },
    )
    // Another tag, whose category nothing has named yet: the old one doesn't carry over.
    assert.deepEqual(pick(planUpdate(lists, 'hp', { url: '/tags/Draco%20Malfoy/works' }).after), { type: 'tag', entity: 'Draco Malfoy' })
    // A series' title can't be checked against its id, so moving series drops it.
    const series = { id: 's', kind: 'series-works', url: '/series/1', alias: 'One', type: 'series', entity: 'Series One', tracked: true, since }
    assert.deepEqual(pick(planUpdate([series], 's', { url: '/series/2' }).after), { type: 'series', entity: '2' })
    assert.deepEqual(pick(planUpdate([series], 's', { url: '/series/2', meta: { type: 'series', entity: 'Series Two' } }).after), { type: 'series', entity: 'Series Two' })
  })

  test('nothing to update, or nothing to update it to', () => {
    assert.deepEqual(planUpdate(lists, 'gone', { url: refined }), { ok: false, reason: 'missing' })
    assert.deepEqual(planUpdate(lists, 'hp', { url: 'https://example.com/tags/x/works' }), { ok: false, reason: 'invalid' })
  })
})

describe('planUndo', () => {
  const since = 20_000
  const before = { id: 'hp', kind: 'works-filter', url: HP, alias: 'HP', type: 'fandom', entity: 'Harry Potter - J. K. Rowling', tracked: true, since }
  const other = { id: 'o', kind: 'text-search', url: '/works/search?work_search[query]=tea', alias: 'Tea', tracked: true, since }
  const { after, lists } = planUpdate([before, other], 'hp', { url: '/works?work_search[complete]=T&tag_id=Harry+Potter+-+J*d*+K*d*+Rowling', alias: 'HP, complete' })

  test('puts the list back as it was', () => {
    const plan = planUndo(lists, before, after)
    assert.equal(plan.ok, true)
    assert.deepEqual(plan.lists, [before, other])
  })

  test('the entry as storage hands it back — keys in another order — is still the same', () => {
    const stored = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(after).reverse())))
    assert.equal(planUndo([stored, other], before, after).ok, true)
  })

  test('not once the list has changed again since', () => {
    for (const changed of [{ ...after, tracked: false }, { ...after, alias: 'Renamed' }, { ...after, url: HP }])
      assert.deepEqual(planUndo([changed, other], before, after), { ok: false, reason: 'changed' })
  })

  test('not once it\'s gone', () => {
    assert.deepEqual(planUndo([other], before, after), { ok: false, reason: 'missing' })
  })

  test('not if another list has taken its old query, or its old title', () => {
    const copy = { ...other, id: 'copy', url: HP, alias: 'Copy' }
    const plan = planUndo([...lists, copy], before, after)
    assert.equal(plan.reason, 'duplicate')
    assert.equal(plan.other.id, 'copy')
    assert.equal(trackedKey(copy), trackedKey(before))

    const namesake = { ...other, id: 'n', url: '/works/search?work_search[query]=n', alias: 'hp' }
    assert.equal(planUndo([...lists, namesake], before, after).reason, 'title')
  })
})

function pick(entry) {
  return { type: entry.type, entity: entry.entity }
}
