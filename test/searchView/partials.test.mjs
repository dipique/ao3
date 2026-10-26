import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { contiguousPrefix, mergeRefresh } from '../../src/content_script/searchView/partials.ts'

const work = (workId, from = 'fresh') => ({ workId, from })
const ids = works => works.map(w => w.workId)

describe('contiguousPrefix', () => {
  test('is every page when none is missing', () => {
    assert.deepEqual(contiguousPrefix(['a', 'b', 'c']), ['a', 'b', 'c'])
  })

  test('stops at the first page not yet landed', () => {
    const pages = []
    pages[0] = 'a'
    pages[2] = 'c'
    assert.deepEqual(contiguousPrefix(pages), ['a'])
  })

  test('stops at a page held as undefined', () => {
    assert.deepEqual(contiguousPrefix(['a', undefined, 'c']), ['a'])
  })

  test('is empty while page 1 is missing, whatever landed after it', () => {
    const pages = []
    pages[1] = 'b'
    pages[2] = 'c'
    assert.deepEqual(contiguousPrefix(pages), [])
    assert.deepEqual(contiguousPrefix([]), [])
  })

  test('keeps a page that landed empty', () => {
    assert.deepEqual(contiguousPrefix([[], ['x']]), [[], ['x']])
  })
})

describe('mergeRefresh', () => {
  test('puts the fresh works first, then the stored works they lack, each in its own order', () => {
    const merged = mergeRefresh([work('9'), work('1')], [work('1', 'stored'), work('2', 'stored'), work('3', 'stored')])
    assert.deepEqual(ids(merged), ['9', '1', '2', '3'])
  })

  test('a work in both is the fresh one, at its fresh place', () => {
    const merged = mergeRefresh([work('3'), work('1')], [work('1', 'stored'), work('2', 'stored'), work('3', 'stored')])
    assert.deepEqual(merged.map(w => `${w.workId}:${w.from}`), ['3:fresh', '1:fresh', '2:stored'])
  })

  test('a work the listing moved across a page boundary is listed once, where it was first seen', () => {
    const merged = mergeRefresh([work('1'), work('2'), work('2'), work('3')], [work('4', 'stored')])
    assert.deepEqual(ids(merged), ['1', '2', '3', '4'])
  })

  test('an empty prefix is the stored list as it was', () => {
    const stored = [work('1', 'stored'), work('2', 'stored')]
    assert.deepEqual(mergeRefresh([], stored), stored)
  })

  test('keeps every stored work the prefix has not reached', () => {
    const stored = Array.from({ length: 6 }, (_, i) => work(String(i + 1), 'stored'))
    assert.deepEqual(ids(mergeRefresh([work('7'), work('2')], stored)), ['7', '2', '1', '3', '4', '5', '6'])
  })

  test('with nothing stored, is the fresh works', () => {
    assert.deepEqual(ids(mergeRefresh([work('1'), work('2')], [])), ['1', '2'])
  })

  test('a work with no id is never taken for another', () => {
    assert.deepEqual(ids(mergeRefresh([work(''), work('1')], [work('', 'stored')])), ['', '1', ''])
  })

  test('changes neither list', () => {
    const fresh = [work('1')]
    const stored = [work('2', 'stored')]
    mergeRefresh(fresh, stored)
    assert.deepEqual(ids(fresh), ['1'])
    assert.deepEqual(ids(stored), ['2'])
  })
})
