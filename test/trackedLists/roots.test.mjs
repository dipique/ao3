import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { defaultTitle, normalizeTrackedUrl, sameRoot, titleTakenBy, TRACKED_TYPES, trackedMeta, trackedRoot, uniqueTitle } from '../../src/common/trackedLists.ts'

const AO3 = 'https://archiveofourown.org'
const key = path => normalizeTrackedUrl(`${AO3}${path}`)?.key ?? null
const root = path => trackedRoot({ url: path })
const meta = (url, stored = {}) => trackedMeta({ url, ...stored })

describe('an author\'s listing, in both its spellings', () => {
  // Reached by a link, a listing has its path form; its Sort & Filter sidebar
  // submits the same works to /works with the owner as hidden inputs, and the
  // listing stays in that form from then on.
  const USER = 'BuckysGrace'

  test('/works?user_id=X and /users/X/works share a key and a root', () => {
    assert.equal(key(`/works?user_id=${USER}`), key(`/users/${USER}/works`))
    assert.equal(root(`/works?user_id=${USER}`), root(`/users/${USER}/works`))
    assert.equal(root(`/users/${USER}/works`), `works-filter:/users/${USER}/works`)
  })

  test('with the sidebar\'s filters first and the owner last, as it submits them', () => {
    const submitted = `/works?work_search[sort_column]=revised_at&work_search[language_id]=en&user_id=${USER}`
    assert.equal(key(submitted), key(`/users/${USER}/works?work_search[language_id]=en`))
    assert.equal(key(submitted), `works-filter:/users/${USER}/works?work_search[language_id]=en`)
  })

  test('a pseud\'s query form and path form share a key, which is not the author\'s', () => {
    const query = `/works?work_search[complete]=T&pseud_id=Grace+Notes&user_id=${USER}`
    const path = `/users/${USER}/pseuds/Grace%20Notes/works?work_search[complete]=T`
    assert.equal(key(query), key(path))
    assert.equal(key(path), `works-filter:/users/${USER}/pseuds/Grace%20Notes/works?work_search[complete]=T`)
    assert.notEqual(key(`/users/${USER}/pseuds/Grace%20Notes/works`), key(`/users/${USER}/works`), 'they match different works')
  })

  test('…and a root, which is the author\'s', () => {
    const author = root(`/users/${USER}/works`)
    assert.equal(root(`/users/${USER}/pseuds/Grace%20Notes/works`), author)
    assert.equal(root(`/works?pseud_id=Grace+Notes&user_id=${USER}`), author)
    assert.equal(sameRoot({ url: `/users/${USER}/pseuds/Grace%20Notes/works` }, { url: `/works?user_id=${USER}&work_search[complete]=T` }), true)
  })

  test('the owner is read by name, wherever it sits', () => {
    assert.equal(key(`/works?user_id=${USER}&work_search[language_id]=en`), key(`/works?work_search[language_id]=en&user_id=${USER}`))
    assert.equal(key(`/works?user_id=${USER}&pseud_id=Grace+Notes`), key(`/works?pseud_id=Grace+Notes&user_id=${USER}`))
  })

  test('the stored URL keeps the spelling the reader had', () => {
    assert.equal(normalizeTrackedUrl(`${AO3}/works?pseud_id=Grace+Notes&user_id=${USER}`).url, `/works?pseud_id=Grace+Notes&user_id=${USER}`)
  })

  test('a pseud_id with no user_id to belong to folds nothing', () => {
    assert.equal(key('/works?pseud_id=Grace+Notes&tag_id=Bees'), 'works-filter:/tags/Bees/works?pseud_id=Grace+Notes')
  })
})

describe('whose listing a query with several owners is', () => {
  test('the archive\'s order: an author, then a collection, then a tag', () => {
    assert.equal(key('/works?tag_id=Bees&user_id=someone'), 'works-filter:/users/someone/works?tag_id=Bees')
    assert.equal(root('/works?tag_id=Bees&user_id=someone'), 'works-filter:/users/someone/works')
    // A collection isn't folded, and outranks the tag, which stays a filter of it.
    assert.equal(key('/works?tag_id=Bees&collection_id=SomeFest2026'), 'works-filter:/works?collection_id=SomeFest2026&tag_id=Bees')
    assert.equal(root('/works?tag_id=Bees&collection_id=SomeFest2026'), 'works-filter:/works?collection_id=SomeFest2026')
  })
})

describe('trackedRoot', () => {
  test('a tag\'s listing roots at the tag, reached either way', () => {
    assert.equal(root('/works?tag_id=Slow+Burn'), 'works-filter:/tags/Slow%20Burn/works')
    assert.equal(root('/tags/Slow%20Burn/works'), 'works-filter:/tags/Slow%20Burn/works')
  })

  test('whatever category the tag is in, each roots its own listing', () => {
    const roots = [
      '/tags/Harry%20Potter%20-%20J*d*%20K*d*%20Rowling/works', // a fandom
      '/tags/Draco%20Malfoy/works', // a character
      '/tags/Slow%20Burn/works', // a freeform
      '/tags/Explicit/works', // a rating
    ].map(root)
    assert.equal(new Set(roots).size, 4)
    for (const one of roots)
      assert.match(one, /^works-filter:\/tags\/[^/]+\/works$/)
  })

  test('every other part of a listing\'s query is a filter of it', () => {
    const narrow = '/works?exclude_work_search[character_ids][]=12&work_search[complete]=T&work_search[query]=coffee&tag_id=Bees'
    assert.equal(root(narrow), root('/tags/Bees/works'))
    assert.notEqual(key(narrow), key('/tags/Bees/works'))
    assert.equal(sameRoot({ url: narrow }, { url: '/tags/Bees/works?work_search[language_id]=en' }), true)
  })

  test('a collection, an uncommon tag and a series root at their own page', () => {
    assert.equal(root('/collections/SomeFest2026/works?work_search[complete]=T'), 'works-filter:/collections/SomeFest2026/works')
    assert.equal(root('/tags/marriage%20problems'), 'tag-works:/tags/marriage%20problems')
    assert.equal(root('/series/4232377'), 'series-works:/series/4232377')
  })

  test('a works search roots at its words, trimmed, lower-cased and collapsed', () => {
    assert.equal(root('/works/search?work_search[query]=+Coffee++Shop%09AU+&work_search[complete]=T'), 'text-search:coffee shop au')
    assert.equal(sameRoot(
      { url: '/works/search?work_search[query]=coffee+shop+AU' },
      { url: '/works/search?work_search[query]=Coffee+Shop+AU&work_search[excluded_tag_names]=Angst' },
    ), true)
  })

  test('a works search without words has no root, and shares none', () => {
    const url = '/works/search?work_search[title]=bees&work_search[complete]=T'
    assert.equal(root(url), null)
    assert.equal(sameRoot({ url }, { url }), false)
  })

  test('kinds never share a root', () => {
    assert.notEqual(root('/tags/Bees'), root('/tags/Bees/works'))
    assert.equal(sameRoot({ url: '/tags/Bees' }, { url: '/tags/Bees/works' }), false)
    assert.equal(sameRoot({ url: '/works/search?work_search[query]=Bees' }, { url: '/tags/Bees/works' }), false)
  })

  test('none for an address that isn\'t a trackable archive page', () => {
    assert.equal(root('https://example.com/tags/Bees/works'), null)
    assert.equal(root('/users/someone/readings?show=to-read'), null)
    assert.equal(sameRoot({ url: '//example.com/series/1' }, { url: '//example.com/series/1' }), false)
  })
})

describe('trackedMeta', () => {
  test('what the URL alone says, for every kind', () => {
    for (const [url, expected] of [
      ['/tags/Harry%20Potter%20-%20J*d*%20K*d*%20Rowling/works', { type: 'tag', entity: 'Harry Potter - J. K. Rowling' }],
      ['/works?tag_id=Harry+Potter+-+J*d*+K*d*+Rowling&work_search[complete]=T', { type: 'tag', entity: 'Harry Potter - J. K. Rowling' }],
      ['/users/BuckysGrace/works', { type: 'author', entity: 'BuckysGrace' }],
      ['/users/BuckysGrace/pseuds/Grace%20Notes/works', { type: 'author', entity: 'BuckysGrace' }],
      ['/works?pseud_id=Grace+Notes&user_id=BuckysGrace', { type: 'author', entity: 'BuckysGrace' }],
      ['/collections/SomeFest2026/works', { type: 'collection', entity: 'SomeFest2026' }],
      ['/works?collection_id=SomeFest2026', { type: 'collection', entity: 'SomeFest2026' }],
      ['/tags/*a*%20Juliet%20-%20Martin*s*West%20Read', { type: 'tag', entity: '& Juliet - Martin/West Read' }],
      ['/series/4232377', { type: 'series', entity: '4232377' }],
      ['/works/search?work_search[query]=coffee++shop%20AU', { type: 'search', entity: 'coffee shop AU' }],
      ['/works/search?work_search[title]=Bees&work_search[complete]=T', { type: 'search', entity: 'Bees' }],
      ['/works/search?work_search[other_tag_names]=marriage+problems', { type: 'search', entity: 'marriage problems' }],
      ['/works/search?work_search[complete]=T&work_search[single_chapter]=1', { type: 'search', entity: '' }],
    ]) {
      assert.deepEqual(meta(url), expected, url)
    }
  })

  test('a stored category stands in for "tag" on a tag\'s list', () => {
    assert.deepEqual(meta('/tags/Draco%20Malfoy/works', { type: 'character' }), { type: 'character', entity: 'Draco Malfoy' })
    assert.deepEqual(meta('/tags/Draco%20Malfoy', { type: 'character', entity: '' }), { type: 'character', entity: 'Draco Malfoy' })
  })

  test('a stored title stands in for a series\' id', () => {
    assert.deepEqual(meta('/series/4232377', { type: 'series', entity: '  The Long  Way Round ' }), { type: 'series', entity: 'The Long Way Round' })
  })

  test('what is stored and doesn\'t fit the URL is ignored, entity and all', () => {
    assert.deepEqual(meta('/users/someone/works', { type: 'character', entity: 'Draco Malfoy' }), { type: 'author', entity: 'someone' })
    assert.deepEqual(meta('/tags/Bees/works', { type: 'series', entity: 'Something' }), { type: 'tag', entity: 'Bees' })
    assert.deepEqual(meta('/tags/Bees/works', { type: 'bogus', entity: 'Something' }), { type: 'tag', entity: 'Bees' })
    assert.deepEqual(meta('/tags/Bees/works', { entity: 'Something' }), { type: 'tag', entity: 'Bees' }, 'an entity with no type to fit')
  })

  test('so is what was stored for a root the list has since moved off', () => {
    // Stored for Draco Malfoy, then updated to another tag without them.
    assert.deepEqual(meta('/works?tag_id=Harry+Potter', { type: 'character', entity: 'Draco Malfoy' }), { type: 'tag', entity: 'Harry Potter' })
    // The same tag in another case is the same root; the URL's spelling is shown.
    assert.deepEqual(meta('/tags/Draco%20Malfoy/works', { type: 'character', entity: 'draco  malfoy' }), { type: 'character', entity: 'Draco Malfoy' })
  })

  test('none for an entry whose URL isn\'t trackable', () => {
    assert.equal(meta('https://example.com/tags/Bees/works'), null)
  })
})

describe('titles', () => {
  test('the default is "Type: entity", or the type alone', () => {
    assert.equal(defaultTitle({ type: 'character', entity: 'Draco Malfoy' }), 'Character: Draco Malfoy')
    assert.equal(defaultTitle({ type: 'freeform', entity: 'Slow Burn' }), 'Additional tag: Slow Burn')
    assert.equal(defaultTitle(meta('/works?pseud_id=Grace+Notes&user_id=BuckysGrace')), 'Author: BuckysGrace')
    assert.equal(defaultTitle(meta('/works/search?work_search[query]=coffee+shop+AU')), 'Search: coffee shop AU')
    assert.equal(defaultTitle({ type: 'search', entity: '' }), 'Search')
    for (const type of TRACKED_TYPES)
      assert.match(defaultTitle({ type, entity: 'x' }), /^[A-Z][a-z ]+: x$/, type)
  })

  const lists = [
    { id: 'a', alias: 'Character: Draco Malfoy' },
    { id: 'b', alias: '' },
    { id: 'c', alias: '' },
  ]

  test('a title is taken when another list has it, compared trimmed and in any case', () => {
    assert.equal(titleTakenBy('  character: draco MALFOY ', lists)?.id, 'a')
    assert.equal(titleTakenBy('Character: Draco', lists), null)
    assert.equal(titleTakenBy('Character:  Draco Malfoy', lists), null, 'only the ends are trimmed')
  })

  test('a list never takes a title from itself', () => {
    assert.equal(titleTakenBy('CHARACTER: DRACO MALFOY', lists, 'a'), null)
    assert.equal(titleTakenBy('Character: Draco Malfoy', lists, 'b')?.id, 'a')
  })

  test('an empty title is never taken, so blank aliases never collide', () => {
    assert.equal(titleTakenBy('', lists), null)
    assert.equal(titleTakenBy('   ', lists), null)
  })

  test('a taken default gets " (2)", " (3)"… until it isn\'t', () => {
    const taken = [{ id: 'a', alias: 'Tag: Bees' }, { id: 'b', alias: 'tag: bees (2)' }]
    assert.equal(uniqueTitle('Tag: Bees', taken), 'Tag: Bees (3)')
    assert.equal(uniqueTitle('  Tag: Wasps ', taken), 'Tag: Wasps')
    assert.equal(uniqueTitle('Tag: Bees', taken, 'a'), 'Tag: Bees', 'a list keeps its own title')
    assert.equal(uniqueTitle('', taken), '')
  })
})
