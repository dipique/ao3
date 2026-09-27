import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { dayOf, normalizeTrackedUrl, pageUrl, sourceLabel, tagSearchUrl, trackedKey } from '../../src/common/trackedLists.ts'

const AO3 = 'https://archiveofourown.org'

/** A page's query parameters, as the archive would read them. */
function paramsOf(pathAndQuery) {
  return new URL(pathAndQuery, AO3).searchParams
}

describe('normalizeTrackedUrl — kinds', () => {
  test('a filtered works listing, in each of its shapes', () => {
    for (const path of [
      '/tags/Baldur\'s%20Gate%20(Video%20Games)/works',
      '/works?tag_id=Baldur%27s+Gate+%28Video+Games%29',
      '/works?user_id=someone',
      '/works?collection_id=SomeFest2026',
      '/users/someone/works',
      '/users/someone/pseuds/other/works',
      '/collections/SomeFest2026/works',
    ]) {
      assert.equal(normalizeTrackedUrl(`${AO3}${path}`)?.kind, 'works-filter', path)
    }
  })

  test('works search results', () => {
    const entry = normalizeTrackedUrl(`${AO3}/works/search?work_search%5Bquery%5D=coffee`)
    assert.deepEqual(entry, {
      kind: 'text-search',
      url: '/works/search?work_search[query]=coffee',
      key: 'text-search:/works/search?work_search[query]=coffee',
      relativeDate: null,
    })
  })

  test('a tag page, with anything on its query string dropped', () => {
    assert.deepEqual(normalizeTrackedUrl(`${AO3}/tags/marriage%20problems?page=3&view_adult=true`), {
      kind: 'tag-works',
      url: '/tags/marriage%20problems',
      key: 'tag-works:/tags/marriage%20problems',
      relativeDate: null,
    })
  })

  test('a series', () => {
    assert.deepEqual(normalizeTrackedUrl(`${AO3}/series/4232377?page=2`), {
      kind: 'series-works',
      url: '/series/4232377',
      key: 'series-works:/series/4232377',
      relativeDate: null,
    })
  })

  test('takes a rooted path as well as a full URL', () => {
    assert.deepEqual(normalizeTrackedUrl('/series/4232377'), normalizeTrackedUrl(`${AO3}/series/4232377`))
  })

  test('a trailing slash changes nothing', () => {
    assert.deepEqual(normalizeTrackedUrl(`${AO3}/tags/Bees/works/`), normalizeTrackedUrl(`${AO3}/tags/Bees/works`))
    assert.deepEqual(normalizeTrackedUrl(`${AO3}/series/12/`), normalizeTrackedUrl(`${AO3}/series/12`))
  })
})

describe('normalizeTrackedUrl — parameters', () => {
  test('drops page, commit, utf8, edit_search and empty values', () => {
    const entry = normalizeTrackedUrl(
      `${AO3}/works/search?utf8=%E2%9C%93&commit=Search&page=4&edit_search=true`
      + '&work_search%5Bquery%5D=bees&work_search%5Btitle%5D=&work_search%5Bcreators%5D=+',
    )
    assert.equal(entry.url, '/works/search?work_search[query]=bees')
  })

  test('drops date bounds, which a review always sets for itself', () => {
    const entry = normalizeTrackedUrl(
      `${AO3}/tags/Bees/works?work_search[date_from]=2026-01-01&work_search[date_to]=2026-02-01&work_search[complete]=T`,
    )
    assert.equal(entry.url, '/tags/Bees/works?work_search[complete]=T')
  })

  test('keeps every criterion, repeated ones included', () => {
    const entry = normalizeTrackedUrl(
      `${AO3}/works?exclude_work_search%5Bfreeform_ids%5D%5B%5D=1&exclude_work_search%5Bfreeform_ids%5D%5B%5D=2`
      + '&work_search%5Bwords_from%5D=1000&work_search%5Blanguage_id%5D=en&work_search%5Bcrossover%5D=F'
      + '&work_search%5Bcomplete%5D=T&work_search%5Bquery%5D=slow+burn&tag_id=Bees',
    )
    const params = paramsOf(entry.url)
    assert.deepEqual(params.getAll('exclude_work_search[freeform_ids][]'), ['1', '2'])
    assert.equal(params.get('work_search[words_from]'), '1000')
    assert.equal(params.get('work_search[language_id]'), 'en')
    assert.equal(params.get('work_search[crossover]'), 'F')
    assert.equal(params.get('work_search[complete]'), 'T')
    assert.equal(params.get('work_search[query]'), 'slow burn')
    assert.equal(params.get('tag_id'), 'Bees')
  })

  test('keeps the sort in the stored URL but leaves it out of the key', () => {
    const entry = normalizeTrackedUrl(
      `${AO3}/works/search?work_search[query]=bees&work_search[sort_column]=kudos_count&work_search[sort_direction]=desc`,
    )
    assert.equal(paramsOf(entry.url).get('work_search[sort_column]'), 'kudos_count')
    assert.equal(paramsOf(entry.url).get('work_search[sort_direction]'), 'desc')
    assert.equal(entry.key, 'text-search:/works/search?work_search[query]=bees')
  })

  test('the key is stable across parameter order, sort and spelling', () => {
    const keys = [
      '/works?tag_id=Bees&work_search[complete]=T&include_work_search[freeform_ids][]=7&include_work_search[freeform_ids][]=3',
      '/works?include_work_search%5Bfreeform_ids%5D%5B%5D=3&work_search%5Bcomplete%5D=T&tag_id=Bees&include_work_search%5Bfreeform_ids%5D%5B%5D=7',
      '/works?work_search[sort_column]=title&include_work_search[freeform_ids][]=3&include_work_search[freeform_ids][]=7&tag_id=Bees&work_search[complete]=T&page=9',
    ].map(path => normalizeTrackedUrl(`${AO3}${path}`).key)
    assert.equal(new Set(keys).size, 1)
  })

  test('a tag\'s listing keys the same reached by path or by tag_id', () => {
    // The Sort & Filter sidebar on /tags/NAME/works submits to /works with
    // tag_id=NAME, so one submit moves the reader between these two spellings of
    // the same works. `tag_id` carries the name already escaped the way a tag's
    // path spells it, so the two only differ in the URL layer.
    for (const [path, query] of [
      ['/tags/Bees/works', '/works?tag_id=Bees'],
      ['/tags/Baldur\'s%20Gate%20(Video%20Games)/works', '/works?tag_id=Baldur%27s+Gate+%28Video+Games%29'],
      ['/tags/*a*%20Juliet%20-%20Martin*s*West%20Read/works', '/works?tag_id=*a*+Juliet+-+Martin*s*West+Read'],
      ['/tags/Michael%20J*d*%20Himes/works', '/works?tag_id=Michael+J*d*+Himes'],
      ['/tags/100%25%20Done/works', '/works?tag_id=100%25+Done'],
    ]) {
      assert.equal(normalizeTrackedUrl(`${AO3}${query}`).key, normalizeTrackedUrl(`${AO3}${path}`).key, query)
    }
  })

  test('the same, with the rest of the filters along for the ride', () => {
    const a = normalizeTrackedUrl(`${AO3}/works?tag_id=Bees&work_search[complete]=T&work_search[language_id]=en`)
    const b = normalizeTrackedUrl(`${AO3}/tags/Bees/works?work_search[language_id]=en&work_search[complete]=T`)
    assert.equal(a.key, b.key)
    assert.equal(a.key, 'works-filter:/tags/Bees/works?work_search[complete]=T&work_search[language_id]=en')
  })

  test('folding tag_id into the key leaves the stored URL as the reader had it', () => {
    // "Open on the archive" should show the page they were looking at, and both
    // spellings are pages the archive serves.
    const entry = normalizeTrackedUrl(`${AO3}/works?tag_id=Bees&work_search[complete]=T`)
    assert.equal(entry.url, '/works?tag_id=Bees&work_search[complete]=T')
  })

  test('two different tags still key apart', () => {
    assert.notEqual(
      normalizeTrackedUrl(`${AO3}/works?tag_id=Bees`).key,
      normalizeTrackedUrl(`${AO3}/works?tag_id=Wasps`).key,
    )
  })

  test('a user\'s listing folds like a tag\'s; a collection\'s stays where it is', () => {
    // The sidebar on /users/NAME/works submits user_id=NAME, exactly as a tag's
    // submits tag_id. A collection's hasn't been seen to, so it isn't folded.
    assert.equal(normalizeTrackedUrl(`${AO3}/works?user_id=someone`).key, 'works-filter:/users/someone/works')
    assert.equal(
      normalizeTrackedUrl(`${AO3}/works?user_id=someone`).key,
      normalizeTrackedUrl(`${AO3}/users/someone/works`).key,
    )
    assert.equal(normalizeTrackedUrl(`${AO3}/works?collection_id=SomeFest2026`).key, 'works-filter:/works?collection_id=SomeFest2026')
    assert.notEqual(
      normalizeTrackedUrl(`${AO3}/works?collection_id=SomeFest2026`).key,
      normalizeTrackedUrl(`${AO3}/collections/SomeFest2026/works`).key,
    )
  })

  test('keeps the relative date bound in the URL, out of the key, and reports it', () => {
    // "< 2 weeks" means something different every day it is read, and a review
    // supplies its own absolute bound — so it can't be part of what a list is.
    const entry = normalizeTrackedUrl(`${AO3}/works/search?work_search[query]=bees&work_search[revised_at]=%3C+2+weeks`)
    assert.equal(paramsOf(entry.url).get('work_search[revised_at]'), '< 2 weeks')
    assert.equal(entry.key, 'text-search:/works/search?work_search[query]=bees')
    assert.equal(entry.relativeDate, '< 2 weeks')
    assert.equal(normalizeTrackedUrl(`${AO3}/works/search?work_search[query]=bees`).relativeDate, null)
  })

  test('a search whose only criterion was a relative date is no query at all', () => {
    assert.equal(normalizeTrackedUrl(`${AO3}/works/search?work_search[revised_at]=%3C+2+weeks`), null)
  })

  test('a different criterion is a different key', () => {
    const a = normalizeTrackedUrl(`${AO3}/works?tag_id=Bees&work_search[complete]=T`).key
    const b = normalizeTrackedUrl(`${AO3}/works?tag_id=Bees&work_search[complete]=F`).key
    assert.notEqual(a, b)
  })

  test('writes the compact spelling: literal brackets, + for a space', () => {
    const entry = normalizeTrackedUrl(`${AO3}/works/search?work_search%5Bquery%5D=coffee%20shop%20AU%2Bfluff`)
    assert.equal(entry.url, '/works/search?work_search[query]=coffee+shop+AU%2Bfluff')
    assert.equal(paramsOf(entry.url).get('work_search[query]'), 'coffee shop AU+fluff')
  })

  test('one spelling for a path, however it was escaped', () => {
    const a = normalizeTrackedUrl(`${AO3}/tags/Caf%c3%a9 AU/works`)
    const b = normalizeTrackedUrl(`${AO3}/tags/Café%20AU/works`)
    assert.equal(a.key, b.key)
    assert.equal(a.url, '/tags/Caf%C3%A9%20AU/works')
  })
})

describe('normalizeTrackedUrl — rejected', () => {
  test('any origin but the archive\'s', () => {
    for (const href of [
      'https://example.com/works/search?work_search[query]=bees',
      'https://evilarchiveofourown.org/series/1',
      'https://archiveofourown.org.example.com/series/1',
      '//example.com/series/1',
      '/\\example.com/series/1',
      'ftp://archiveofourown.org/series/1',
      'javascript:alert(1)',
    ]) {
      assert.equal(normalizeTrackedUrl(href), null, href)
    }
  })

  test('accepts the archive over http and on a subdomain', () => {
    assert.equal(normalizeTrackedUrl('http://archiveofourown.org/series/1')?.url, '/series/1')
    assert.equal(normalizeTrackedUrl('https://www.archiveofourown.org/series/1')?.url, '/series/1')
  })

  test('a path that is not rooted', () => {
    assert.equal(normalizeTrackedUrl('series/1'), null)
    assert.equal(normalizeTrackedUrl(''), null)
    assert.equal(normalizeTrackedUrl(undefined), null)
  })

  test('readings: Marked for Later and History', () => {
    assert.equal(normalizeTrackedUrl(`${AO3}/users/someone/readings?show=to-read`), null)
    assert.equal(normalizeTrackedUrl(`${AO3}/users/someone/readings`), null)
  })

  test('bookmark listings', () => {
    for (const path of ['/users/someone/bookmarks', '/bookmarks?bookmark_search[query]=x', '/tags/Bees/bookmarks', '/series/1/bookmarks'])
      assert.equal(normalizeTrackedUrl(`${AO3}${path}`), null, path)
  })

  test('pages that are not a list of works', () => {
    for (const path of [
      '/',
      '/works/123',
      '/works',
      '/works?work_search[complete]=T',
      '/works/search',
      '/works/search?edit_search=true',
      '/works/search?work_search[sort_column]=kudos_count',
      '/works/search?work_search[query]=',
      '/tags/search?tag_search[name]=bees',
      '/tags/new',
      '/series/abc',
      '/users/someone',
      '/collections/SomeFest2026',
    ]) {
      assert.equal(normalizeTrackedUrl(`${AO3}${path}`), null, path)
    }
  })
})

describe('trackedKey', () => {
  test('matches the key of the page the entry was made from', () => {
    const page = `${AO3}/works/search?work_search[query]=bees&work_search[sort_column]=kudos_count&page=2`
    const { url } = normalizeTrackedUrl(page)
    assert.equal(trackedKey({ url }), normalizeTrackedUrl(page).key)
    // …and of the same search sorted differently.
    assert.equal(trackedKey({ url }), normalizeTrackedUrl(`${AO3}/works/search?work_search[query]=bees`).key)
  })

  test('is null for an entry that does not name an archive page', () => {
    assert.equal(trackedKey({ url: '//example.com/series/1' }), null)
    assert.equal(trackedKey({ url: '/users/someone/readings?show=to-read' }), null)
  })
})

describe('sourceLabel', () => {
  const entry = (id, alias, url) => ({ id, alias, url })

  test('is the alias when there is one', () => {
    assert.equal(sourceLabel(entry('a', '  Slow burns  ', '/series/1')), 'Slow burns')
  })

  test('is … and the last 30 characters of the decoded URL without one', () => {
    const label = sourceLabel(entry('a', '', '/works/search?work_search[query]=coffee+shop+AU'))
    assert.equal(label, '…k_search[query]=coffee shop AU')
    assert.equal([...label].length, 31)
  })

  test('shows a short URL whole, without an ellipsis', () => {
    assert.equal(sourceLabel(entry('a', '', '/tags/marriage%20problems')), '/tags/marriage problems')
  })

  test('given every entry, makes duplicate labels unique in list order', () => {
    const all = [entry('a', 'Bees', '/series/1'), entry('b', 'Bees', '/series/2'), entry('c', 'Bees', '/series/3')]
    assert.deepEqual(all.map(one => sourceLabel(one, all)), ['Bees', 'Bees (2)', 'Bees (3)'])
  })

  test('never collides with an alias that already reads like a duplicate', () => {
    const all = [entry('a', 'Bees', '/series/1'), entry('b', 'Bees', '/series/2'), entry('c', 'Bees (2)', '/series/3')]
    const labels = all.map(one => sourceLabel(one, all))
    assert.equal(new Set(labels).size, 3)
    assert.deepEqual(labels.slice(0, 2), ['Bees', 'Bees (2)'])
  })

  test('disambiguates URL-tail labels too', () => {
    const all = [entry('a', '', '/series/1'), entry('b', '', '/series/1')]
    assert.deepEqual(all.map(one => sourceLabel(one, all)), ['/series/1', '/series/1 (2)'])
  })

  test('an entry not in the list is labelled as if it came last', () => {
    const all = [entry('a', 'Bees', '/series/1')]
    assert.equal(sourceLabel(entry('z', 'Bees', '/series/9'), all), 'Bees (2)')
  })
})

describe('tagSearchUrl', () => {
  test('searches the tag\'s name with no date bound, for the count check', () => {
    const url = tagSearchUrl({ kind: 'tag-works', url: '/tags/*a*%20Juliet%20-%20Martin*s*West%20Read' })
    assert.ok(url.startsWith('/works/search?'))
    const params = paramsOf(url)
    assert.equal(params.get('work_search[other_tag_names]'), '& Juliet - Martin/West Read')
    // No bound of any kind: the count has to cover every work the tag holds.
    assert.equal(params.has('work_search[date_from]'), false)
    assert.equal(params.has('page'), false)
  })

  test('is null for any other kind of entry', () => {
    assert.equal(tagSearchUrl({ kind: 'series-works', url: '/series/1' }), null)
    assert.equal(tagSearchUrl({ kind: 'tag-works', url: '/series/1' }), null)
    assert.equal(tagSearchUrl({ kind: 'tag-works', url: 'https://example.com/tags/Bees' }), null)
  })
})

describe('pageUrl', () => {
  const FROM = dayOf('1 Sep 2026')

  test('reads a filtered listing oldest first from the day given', () => {
    const url = pageUrl({ kind: 'works-filter', url: '/tags/Bees/works?work_search[complete]=T&work_search[sort_column]=kudos_count' }, FROM, 3)
    assert.ok(url.startsWith('/tags/Bees/works?'))
    const params = paramsOf(url)
    assert.equal(params.get('work_search[sort_column]'), 'revised_at')
    assert.equal(params.get('work_search[sort_direction]'), 'asc')
    assert.equal(params.get('work_search[date_from]'), '2026-09-01')
    assert.equal(params.get('page'), '3')
    assert.equal(params.get('work_search[complete]'), 'T')
    // One of each: the entry's own sort is replaced, not joined.
    assert.deepEqual(params.getAll('work_search[sort_column]'), ['revised_at'])
  })

  test('never sends a date_to, even when the stored URL carries one', () => {
    const url = pageUrl({ kind: 'text-search', url: '/works/search?work_search[query]=bees&work_search[date_to]=2020-01-01&work_search[date_from]=2019-01-01' }, FROM, 1)
    const params = paramsOf(url)
    assert.equal(params.has('work_search[date_to]'), false)
    assert.deepEqual(params.getAll('work_search[date_from]'), ['2026-09-01'])
  })

  test('keeps every criterion of a search', () => {
    const url = pageUrl({ kind: 'text-search', url: '/works/search?work_search[query]=coffee+shop&work_search[language_id]=en' }, FROM, 1)
    assert.ok(url.startsWith('/works/search?'))
    assert.equal(paramsOf(url).get('work_search[query]'), 'coffee shop')
    assert.equal(paramsOf(url).get('work_search[language_id]'), 'en')
  })

  test('fetches an uncommon tag through a search by its name', () => {
    const url = pageUrl({ kind: 'tag-works', url: '/tags/*a*%20Juliet%20-%20Martin*s*West%20Read' }, FROM, 2)
    assert.ok(url.startsWith('/works/search?'))
    const params = paramsOf(url)
    assert.equal(params.get('work_search[other_tag_names]'), '& Juliet - Martin/West Read')
    assert.equal(params.get('work_search[sort_column]'), 'revised_at')
    assert.equal(params.get('work_search[sort_direction]'), 'asc')
    assert.equal(params.get('work_search[date_from]'), '2026-09-01')
    assert.equal(params.get('page'), '2')
  })

  test('leaves the relative date bound off the page it fetches', () => {
    // Combined with the review's own date_from, "< 2 weeks" would quietly empty
    // the window of a reader further behind than that.
    const url = pageUrl({ kind: 'text-search', url: '/works/search?work_search[query]=bees&work_search[revised_at]=%3C+2+weeks' }, FROM, 1)
    assert.equal(paramsOf(url).has('work_search[revised_at]'), false)
    assert.equal(paramsOf(url).get('work_search[date_from]'), '2026-09-01')
  })

  test('reads a tag marked scan from its own page, undated', () => {
    assert.equal(pageUrl({ kind: 'tag-works', url: '/tags/marriage%20problems', scan: true }, FROM, 12), '/tags/marriage%20problems?page=12')
  })

  test('reads a series from its own page, undated', () => {
    assert.equal(pageUrl({ kind: 'series-works', url: '/series/4232377' }, FROM, 2), '/series/4232377?page=2')
  })

  test('refuses an entry that does not name an archive page, or not the kind it claims', () => {
    assert.equal(pageUrl({ kind: 'series-works', url: '//example.com/series/1' }, FROM, 1), null)
    assert.equal(pageUrl({ kind: 'series-works', url: 'https://example.com/series/1' }, FROM, 1), null)
    assert.equal(pageUrl({ kind: 'text-search', url: '/series/1' }, FROM, 1), null)
    assert.equal(pageUrl({ kind: 'works-filter', url: '/users/someone/readings?show=to-read' }, FROM, 1), null)
  })

  test('always returns a path rooted at a single slash', () => {
    for (const entry of [
      { kind: 'works-filter', url: 'https://archiveofourown.org/tags/Bees/works' },
      { kind: 'series-works', url: 'https://www.archiveofourown.org/series/1' },
    ]) {
      const url = pageUrl(entry, FROM, 1)
      assert.match(url, /^\/[^/]/)
      assert.equal(new URL(url, AO3).origin, AO3)
    }
  })

  test('throws on a page or a day that is not a whole number', () => {
    const entry = { kind: 'series-works', url: '/series/1' }
    assert.throws(() => pageUrl(entry, FROM, 0), RangeError)
    assert.throws(() => pageUrl(entry, FROM, 1.5), RangeError)
    assert.throws(() => pageUrl(entry, Number.NaN, 1), RangeError)
  })
})
