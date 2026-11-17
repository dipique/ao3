import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { authorFromURL, entityIdFromURL } from '../../src/common/data.ts'

const ARCHIVE = 'https://archiveofourown.org'

describe('authorFromURL', () => {
  test('reads the user, and the pseud when the link names one', () => {
    assert.deepEqual(authorFromURL(`${ARCHIVE}/users/someone/pseuds/sideblog`), { userId: 'someone', pseud: 'sideblog' })
    assert.deepEqual(authorFromURL(`${ARCHIVE}/users/someone/pseuds/sideblog/works`), { userId: 'someone', pseud: 'sideblog' })
    assert.deepEqual(authorFromURL(`${ARCHIVE}/users/someone`), { userId: 'someone', pseud: undefined })
    assert.deepEqual(authorFromURL(`${ARCHIVE}/users/someone/works`), { userId: 'someone', pseud: undefined })
  })

  test('a link that isn’t to a user is none', () => {
    assert.equal(authorFromURL(`${ARCHIVE}/works/12`), null)
    assert.equal(authorFromURL(`${ARCHIVE}/users/`), null)
  })
})

describe('entityIdFromURL', () => {
  test('reads a work’s or a series’ id, whatever follows it', () => {
    assert.equal(entityIdFromURL(`${ARCHIVE}/works/12`, 'works'), '12')
    assert.equal(entityIdFromURL(`${ARCHIVE}/works/12/chapters/34?view_adult=true`, 'works'), '12')
    assert.equal(entityIdFromURL(`${ARCHIVE}/series/56/`, 'series'), '56')
  })

  test('a link to anything else, or no address at all, is none', () => {
    assert.equal(entityIdFromURL(`${ARCHIVE}/series/56`, 'works'), undefined)
    assert.equal(entityIdFromURL(`${ARCHIVE}/works/12abc`, 'works'), undefined)
    assert.equal(entityIdFromURL(`${ARCHIVE}/collections/x/works/12`, 'works'), undefined)
    assert.equal(entityIdFromURL('not a url', 'works'), undefined)
  })
})
