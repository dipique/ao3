import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { fragmentTarget, workRoute } from '../../src/site/workNav.ts'

describe('workRoute', () => {
  test('a work\'s route names the work', () => {
    assert.equal(workRoute('#work/123'), '123')
  })

  test('anything else is the list', () => {
    for (const hash of ['', '#', '#work/', '#work/12a', '#chapter-2', '#work/12/chapters/3'])
      assert.equal(workRoute(hash), undefined, hash)
  })
})

describe('fragmentTarget', () => {
  test('a link to a place in the work names that place', () => {
    assert.equal(fragmentTarget('#chapter-2'), 'chapter-2')
    assert.equal(fragmentTarget('#chapter_1_endnotes'), 'chapter_1_endnotes')
  })

  test('decodes what the link escaped', () => {
    assert.equal(fragmentTarget('#notes%20one'), 'notes one')
    assert.equal(fragmentTarget('#bad%zz'), 'bad%zz', 'a broken escape is taken as written')
  })

  test('the list, a work\'s route and an address are routes, not places', () => {
    for (const href of [null, '', '#', '#work/12', 'https://archiveofourown.org/works/1#chapter-2', '/works/1'])
      assert.equal(fragmentTarget(href), null, String(href))
  })
})
