import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// Node strips the TS types on import; listUrl.ts is pure (no `#common`, no
// `browser`, no DOM) and declares nothing that emits at runtime, so it loads
// with a plain `node --test`.
import { withPage } from '../../src/common/listUrl.ts'

const READINGS = 'https://archiveofourown.org/users/someone/readings?show=to-read'

describe('withPage', () => {
  test('adds a page to a listing that has none', () => {
    assert.equal(
      withPage(READINGS, 3),
      'https://archiveofourown.org/users/someone/readings?show=to-read&page=3',
    )
  })

  test('replaces a page the stored URL already carried', () => {
    // A snapshot can be captured from page 3; refreshing it must still start at 1.
    assert.equal(
      withPage(`${READINGS}&page=7`, 1),
      'https://archiveofourown.org/users/someone/readings?show=to-read&page=1',
    )
  })

  test('never leaves two page parameters behind', () => {
    const url = new URL(withPage(`${READINGS}&page=7`, 2))
    assert.deepEqual(url.searchParams.getAll('page'), ['2'])
  })

  test('keeps every other parameter', () => {
    // The whole point for a text search: the query is the listing's identity.
    const search = 'https://archiveofourown.org/works/search?work_search%5Bquery%5D=bees&work_search%5Bsort_column%5D=revised_at&page=4'
    const url = new URL(withPage(search, 2))
    assert.equal(url.searchParams.get('work_search[query]'), 'bees')
    assert.equal(url.searchParams.get('work_search[sort_column]'), 'revised_at')
    assert.equal(url.searchParams.get('page'), '2')
  })

  test('keeps the path untouched, encoding and all', () => {
    // AO3 tag paths carry their own escapes (`*s*` for a slash, %-encoding for
    // the rest); re-encoding one would point the refresh at a different tag.
    const tag = 'https://archiveofourown.org/tags/Batman%20-%20All%20Media%20Types'
    assert.equal(
      withPage(tag, 5),
      'https://archiveofourown.org/tags/Batman%20-%20All%20Media%20Types?page=5',
    )
  })

  test('keeps a fragment after the query', () => {
    assert.equal(
      withPage('https://archiveofourown.org/tags/Bees?page=2#main', 6),
      'https://archiveofourown.org/tags/Bees?page=6#main',
    )
  })

  test('refuses a relative URL rather than guessing a base', () => {
    assert.throws(() => withPage('/users/someone/readings', 2), TypeError)
  })
})
