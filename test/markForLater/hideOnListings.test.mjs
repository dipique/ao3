import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { hidesMarkedForLaterOn } from '../../src/common/markedForLater.ts'

describe('hidesMarkedForLaterOn', () => {
  test('a works search hides them', () => {
    assert.equal(hidesMarkedForLaterOn('/works/search'), true)
  })

  test('a tag\'s, an author\'s and a collection\'s listings hide them', () => {
    for (const path of ['/tags/Fluff/works', '/works', '/users/writer/works', '/users/writer/pseuds/pen/works', '/collections/fest/works', '/users/me/bookmarks'])
      assert.equal(hidesMarkedForLaterOn(path), true, path)
  })

  test('the reader\'s readings pages leave them, being where the list is kept', () => {
    for (const path of ['/users/me/readings', '/users/me/readings/'])
      assert.equal(hidesMarkedForLaterOn(path), false, path)
  })
})
