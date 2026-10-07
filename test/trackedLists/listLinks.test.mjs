import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { hostPage, listUrlFor, openAsk, openLink, openTarget } from '../../src/common/listLinks.ts'
import { isListId, onListPage } from '../../src/common/trackedLists.ts'

const AO3 = 'https://archiveofourown.org'

const record = (id, kind, url, fields = {}) => ({ id, kind, url, title: 'A list', ...fields })

/** The lists with no record, each with the page it is hosted on for the reader `me`. */
const BUILTINS = [
  { ref: { kind: 'marked-for-later' }, page: '/users/me/readings?show=to-read' },
  { ref: { kind: 'read-works' }, page: '/users/me/readings' },
  { ref: { kind: 'review' }, page: '/users/me/readings' },
]

/** The fragment a page opened at `link` reads. */
const hashOf = link => new URL(link, AO3).hash

describe('open URLs', () => {
  test('a saved list of every kind opens on its own page, by its id, and the page reads the list back', () => {
    const lists = [
      record('f1lt3r', 'works-filter', '/tags/Harry%20Potter/works'),
      record('qu3ry', 'works-filter', '/works?work_search[complete]=T&tag_id=Bees'),
      record('s34rch', 'text-search', '/works/search?work_search[query]=tea', { filter: { text: 'slow burn' } }),
      record('t4g', 'tag-works', '/tags/marriage%20problems', { scan: true }),
      record('s3r', 'series-works', '/series/9991'),
    ]
    for (const list of lists) {
      const ref = { kind: 'list', id: list.id }
      const page = hostPage(ref, list)
      assert.equal(page, list.url, list.kind)
      assert.equal(openLink(ref, page), `${list.url}#ao3e-open=${list.id}`)
      assert.deepEqual(openTarget(hashOf(openLink(ref, page))), ref)
    }
  })

  test('Marked for Later opens on its own page, and Read works and the review, which have none on AO3, on the reader\'s readings', () => {
    for (const { ref, page } of BUILTINS) {
      assert.equal(hostPage(ref, null, 'me'), page, ref.kind)
      assert.deepEqual(openTarget(hashOf(openLink(ref, page))), ref)
    }
    assert.equal(openLink({ kind: 'marked-for-later' }, '/users/me/readings?show=to-read'), '/users/me/readings?show=to-read#ao3e-open=marked-for-later')
    assert.equal(openLink({ kind: 'read-works' }, '/users/me/readings'), '/users/me/readings#ao3e-open=read-works')
    assert.equal(openLink({ kind: 'review' }, '/users/me/readings'), '/users/me/readings#ao3e-open=tracked-review')
  })

  test('without the reader\'s account, nothing hosted on the readings has a page', () => {
    for (const { ref } of BUILTINS) {
      assert.equal(hostPage(ref, null), null, ref.kind)
      assert.equal(hostPage(ref, null, ''), null, ref.kind)
    }
  })

  test('the account is one segment of the path, whatever it holds', () => {
    assert.equal(hostPage({ kind: 'read-works' }, null, 'a/b?c#d'), '/users/a%2Fb%3Fc%23d/readings')
  })

  test('the review\'s own link still opens it', () => {
    assert.deepEqual(openTarget('#ao3e-tracked'), { kind: 'review' })
    assert.deepEqual(openTarget('ao3e-tracked'), { kind: 'review' }, 'with or without the #')
    assert.deepEqual(openTarget('ao3e-open=read-works'), { kind: 'read-works' }, 'with or without the #')
  })

  test('no name a list without a record goes by can be a list\'s id, so a list whose id spells a word is still that list', () => {
    for (const { ref, page } of BUILTINS) {
      const name = hashOf(openLink(ref, page)).slice('#ao3e-open='.length)
      assert.equal(isListId(name), false, name)
    }
    for (const id of ['review', 'marked', 'read', 'tracked', 'works'])
      assert.deepEqual(openTarget(`#ao3e-open=${id}`), { kind: 'list', id })
  })

  test('a page with a fragment of its own takes the reference in its place', () => {
    assert.equal(openLink({ kind: 'review' }, `${AO3}/users/me/readings#ao3e-tracked`), openLink({ kind: 'review' }, `${AO3}/users/me/readings`))
    assert.equal(openLink({ kind: 'list', id: 's3r' }, `${AO3}/series/9991#main`), `${AO3}/series/9991#ao3e-open=s3r`)
  })

  test('no page for a list whose address isn\'t an archive page of its kind, whose id no link can carry, or that isn\'t the list named', () => {
    assert.equal(hostPage({ kind: 'list', id: 'b' }, record('b', 'tag-works', 'https://example.com/tags/x')), null)
    assert.equal(hostPage({ kind: 'list', id: 'k' }, record('k', 'series-works', '/works/search?work_search[query]=tea')), null)
    assert.equal(hostPage({ kind: 'list', id: 'a/b' }, record('a/b', 'series-works', '/series/1')), null)
    assert.equal(hostPage({ kind: 'list', id: '' }, record('', 'series-works', '/series/1')), null)
    assert.equal(hostPage({ kind: 'list', id: 'x' }, null), null)
    assert.equal(hostPage({ kind: 'list', id: 'x' }, record('y', 'series-works', '/series/1')), null)
  })

  test('any other fragment opens nothing', () => {
    const hashes = [
      '',
      '#',
      '#ao3e-open=',
      '#ao3e-open=a/b',
      '#ao3e-open=abc&x=1',
      '#ao3e-open=abc#x',
      '#ao3e-open=Read-Works',
      '#ao3e-open=read_works',
      '#ao3e-opens=abc',
      '#x#ao3e-open=abc',
      '#AO3E-OPEN=abc',
      '#ao3e-tracked=1',
      '#ao3e-tracked#x',
      '#ao3e-list=abc',
      '#work_123',
      undefined,
      null,
    ]
    for (const hash of hashes)
      assert.equal(openTarget(hash), null, String(hash))
  })
})

describe('what an open URL asks of the page it opens', () => {
  const LISTS = [
    record('f1lt3r', 'works-filter', '/tags/Bees/works', { filter: { facets: { characters: { ex: ['Draco Malfoy'] } } } }),
    record('s34rch', 'text-search', '/works/search?work_search[query]=tea&work_search[complete]=T'),
    record('t4g', 'tag-works', '/tags/marriage%20problems'),
    record('s3r', 'series-works', '/series/9991'),
  ]
  const byId = id => LISTS.find(list => list.id === id)

  test('a saved list, on its own page, in the view of its kind', () => {
    for (const list of LISTS) {
      const ref = { kind: 'list', id: list.id }
      assert.deepEqual(openAsk(ref, LISTS, `${AO3}${list.url}`), { ref, host: list.kind, list }, list.kind)
    }
  })

  test('its own page in any of its spellings, sorts or page numbers', () => {
    const at = (id, href) => openAsk({ kind: 'list', id }, LISTS, href)?.list.id ?? null
    assert.equal(at('f1lt3r', `${AO3}/works?work_search[sort_column]=title&tag_id=Bees`), 'f1lt3r')
    assert.equal(at('f1lt3r', `${AO3}/tags/Bees/works?page=3`), 'f1lt3r')
    assert.equal(at('s34rch', `${AO3}/works/search?work_search[complete]=T&work_search[query]=tea&page=2&commit=Search`), 's34rch')
    assert.equal(at('t4g', `${AO3}/tags/marriage%20problems?page=2`), 't4g')
    assert.equal(at('s3r', `${AO3}/series/9991/`), 's3r')
  })

  test('nothing on any other page: another list\'s, the same tag as a listing, or no list at all', () => {
    const elsewhere = [
      ['f1lt3r', `${AO3}/tags/Wasps/works`],
      ['f1lt3r', `${AO3}/tags/Bees/works?work_search[complete]=T`],
      ['s34rch', `${AO3}/works/search?work_search[query]=tea`],
      ['t4g', `${AO3}/tags/marriage%20problems/works`],
      ['s3r', `${AO3}/series/9992`],
      ['s3r', `${AO3}/users/me/readings`],
      ['s3r', 'https://example.com/series/9991'],
    ]
    for (const [id, href] of elsewhere)
      assert.equal(openAsk({ kind: 'list', id }, LISTS, href), null, `${id} at ${href}`)
  })

  test('nothing for an id no saved list has', () => {
    assert.equal(openAsk({ kind: 'list', id: 'g0n3' }, LISTS, `${AO3}/series/9991`), null)
    assert.equal(openAsk({ kind: 'list', id: 's3r' }, [], `${AO3}/series/9991`), null)
  })

  test('the lists named are the ones given, so an entry not yet filed resolves as the record it will be', () => {
    const entry = { ...byId('s3r'), id: 'n3w', alias: 'Pulled' }
    assert.equal(openAsk({ kind: 'list', id: 'n3w' }, [...LISTS, entry], `${AO3}/series/9991`)?.list, entry)
  })

  test('Marked for Later on a reader\'s to-read list, and only there', () => {
    const ref = { kind: 'marked-for-later' }
    for (const href of [`${AO3}/users/me/readings?show=to-read`, `${AO3}/users/me/readings/?show=to-read&page=2`])
      assert.deepEqual(openAsk(ref, LISTS, href), { ref, host: 'marked-for-later', list: null }, href)
    for (const href of [`${AO3}/users/me/readings`, `${AO3}/users/me/works?show=to-read`, 'https://example.com/users/me/readings?show=to-read'])
      assert.equal(openAsk(ref, LISTS, href), null, href)
  })

  test('the works read and the review on either half of a reader\'s readings, where their views open', () => {
    for (const kind of ['read-works', 'review']) {
      const ref = { kind }
      for (const href of [`${AO3}/users/me/readings`, `${AO3}/users/me/readings/?page=3`, `${AO3}/users/me/readings?show=to-read`])
        assert.deepEqual(openAsk(ref, LISTS, href), { ref, host: kind, list: null }, `${kind} at ${href}`)
      for (const href of [`${AO3}/users/me/readings/confirm_clear`, `${AO3}/users/me`, `${AO3}/series/9991`, 'https://example.com/users/me/readings'])
        assert.equal(openAsk(ref, LISTS, href), null, `${kind} at ${href}`)
    }
  })
})

describe('a list\'s own page', () => {
  test('is its address in either spelling, in any sort, at any page', () => {
    const list = record('f1lt3r', 'works-filter', '/tags/Bees/works')
    for (const href of [`${AO3}/tags/Bees/works`, `${AO3}/tags/Bees/works?page=2`, `${AO3}/works?work_search[sort_column]=title&tag_id=Bees`, '/tags/Bees/works#ao3e-open=f1lt3r'])
      assert.equal(onListPage(list, href), true, href)
  })

  test('isn\'t a page of other criteria, of another kind, off the archive, or what a list of the wrong kind names', () => {
    const list = record('f1lt3r', 'works-filter', '/tags/Bees/works')
    for (const href of [`${AO3}/tags/Bees/works?work_search[complete]=T`, `${AO3}/tags/Bees`, 'https://example.com/tags/Bees/works', ''])
      assert.equal(onListPage(list, href), false, href)
    assert.equal(onListPage(record('x', 'tag-works', '/tags/Bees/works'), `${AO3}/tags/Bees/works`), false, 'a list whose kind its address isn\'t')
    assert.equal(onListPage(record('x', 'series-works', 'nonsense'), `${AO3}/series/1`), false, 'an address that isn\'t a page')
  })
})

describe('listUrlFor', () => {
  test('a stored list\'s address, as its descriptor has it', () => {
    assert.equal(listUrlFor('tag-works:Coffee%20Shop%20AU', { listUrl: `${AO3}/tags/Coffee%20Shop%20AU/works` }), `${AO3}/tags/Coffee%20Shop%20AU/works`)
  })

  test('with no descriptor, a page rebuilt from the key', () => {
    assert.equal(listUrlFor('marked-for-later:me'), '/users/me/readings?show=to-read')
    assert.equal(listUrlFor('tag-works:Coffee%20Shop%20AU'), '/tags/Coffee%20Shop%20AU')
    assert.equal(listUrlFor('series-works:9991'), '/series/9991')
    assert.equal(listUrlFor('text-search:work_search%5Bquery%5D=tea'), '/works/search?work_search%5Bquery%5D=tea')
    assert.equal(listUrlFor('series-works:9991', { listUrl: '' }), '/series/9991', 'an empty address is none')
  })

  test('none for a key no page is rebuilt from, the works read and the review among them', () => {
    for (const key of ['read-works:me', 'tracked-review', 'tag-works:', 'tag-works', 'unknown:x', ''])
      assert.equal(listUrlFor(key), undefined, key)
  })
})
