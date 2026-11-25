import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { workPageRedirect } from '../../src/content_script/workPageRedirect.ts'

const AO3 = 'https://archiveofourown.org'
const BOTH = { fullWork: true, comments: true }
const FULL = { fullWork: true, comments: false }
const COMMENTS = { fullWork: false, comments: true }

describe('workPageRedirect', () => {
  test('a work opens as its entire work', () => {
    assert.equal(workPageRedirect(`${AO3}/works/80538176`, FULL), `${AO3}/works/80538176?view_full_work=true`)
  })

  test('a work opens at its comments, as a chapter or as the entire work', () => {
    assert.equal(workPageRedirect(`${AO3}/works/80538176`, COMMENTS), `${AO3}/works/80538176#comments`)
    assert.equal(workPageRedirect(`${AO3}/works/80538176?view_full_work=true`, COMMENTS), `${AO3}/works/80538176?view_full_work=true#comments`)
  })

  test('with both on, a work opens as its entire work at its comments, in one step', () => {
    assert.equal(workPageRedirect(`${AO3}/works/80538176`, BOTH), `${AO3}/works/80538176?view_full_work=true#comments`)
  })

  test('the work\'s other query parameters are kept as they were written', () => {
    assert.equal(workPageRedirect(`${AO3}/works/1?view_adult=true`, FULL), `${AO3}/works/1?view_adult=true&view_full_work=true`)
    assert.equal(workPageRedirect(`${AO3}/works/1?a=b+c`, FULL), `${AO3}/works/1?a=b+c&view_full_work=true`)
  })

  test('a page already as asked for is left alone', () => {
    assert.equal(workPageRedirect(`${AO3}/works/1?view_full_work=true#comments`, BOTH), null)
  })

  test('a work asked for chapter by chapter stays that way', () => {
    assert.equal(workPageRedirect(`${AO3}/works/1?view_full_work=false`, FULL), null)
  })

  test('a page aimed at a place in the work keeps its place, and still opens whole', () => {
    assert.equal(workPageRedirect(`${AO3}/works/1#chapter-2`, COMMENTS), null)
    assert.equal(workPageRedirect(`${AO3}/works/1#workskin`, BOTH), `${AO3}/works/1?view_full_work=true#workskin`)
  })

  test('a page already showing its comments is not sent to them', () => {
    assert.equal(workPageRedirect(`${AO3}/works/1?show_comments=true`, COMMENTS), null)
  })

  test('a work in a collection, and one with a trailing slash, are works too', () => {
    assert.equal(workPageRedirect(`${AO3}/collections/fest/works/1`, BOTH), `${AO3}/collections/fest/works/1?view_full_work=true#comments`)
    assert.equal(workPageRedirect(`${AO3}/works/1/`, FULL), `${AO3}/works/1/?view_full_work=true`)
  })

  test('only a whole work\'s own page: not a chapter, a work\'s other pages, or a works listing', () => {
    for (const path of ['/works/1/chapters/2', '/works/1/bookmarks', '/works/1/navigate', '/works/search?work_search[query]=x', '/works/new', '/works', '/users/me/works'])
      assert.equal(workPageRedirect(`${AO3}${path}`, BOTH), null, path)
  })

  test('nothing happens with both off', () => {
    assert.equal(workPageRedirect(`${AO3}/works/1`, { fullWork: false, comments: false }), null)
  })
})
