import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { loadModuleInPage, skipWithoutChrome } from '../siteExport/helpers.mjs'

/**
 * A work's own page, made into a listing blurb.
 *
 * The read list fetches this for a marked work that isn't in the reader's AO3
 * history, so the blurb it builds has to come out of `parseWork` saying what a
 * real blurb for the same work would: the facets are built from it, and it is
 * stored and exported as though it had been scraped. It needs a DOM, not an
 * extension, so it runs on the esbuild-and-blank-page rig.
 */

/** A work page in miniature, in AO3's markup: the meta block and the preface. */
function workPage({ id = 42, restricted = false } = {}) {
  return `<!DOCTYPE html><html><body class="logged-in"><div id="main">
  <div class="wrapper"><dl class="work meta group">
    <dt class="rating tags">Rating:</dt>
    <dd class="rating tags"><ul class="commas"><li><a class="tag" href="/tags/Teen%20And%20Up%20Audiences/works">Teen And Up Audiences</a></li></ul></dd>
    <dt class="warning tags">Archive Warning:</dt>
    <dd class="warning tags"><ul class="commas"><li><a class="tag" href="/tags/No%20Archive%20Warnings%20Apply/works">No Archive Warnings Apply</a></li></ul></dd>
    <dt class="category tags">Categories:</dt>
    <dd class="category tags"><ul class="commas"><li><a class="tag" href="/tags/F*s*F/works">F/F</a></li><li><a class="tag" href="/tags/Gen/works">Gen</a></li></ul></dd>
    <dt class="fandom tags">Fandom:</dt>
    <dd class="fandom tags"><ul class="commas"><li><a class="tag" href="/tags/Criminal%20Minds/works">Criminal Minds</a></li><li><a class="tag" href="/tags/X-Men/works">X-Men</a></li></ul></dd>
    <dt class="relationship tags">Relationship:</dt>
    <dd class="relationship tags"><ul class="commas"><li><a class="tag" href="/tags/Emma*s*Emily/works">Emma Frost/Emily Prentiss</a></li></ul></dd>
    <dt class="character tags">Characters:</dt>
    <dd class="character tags"><ul class="commas"><li><a class="tag" href="/tags/Emma%20Frost/works">Emma Frost</a></li><li><a class="tag" href="/tags/Emily%20Prentiss/works">Emily Prentiss</a></li></ul></dd>
    <dt class="freeform tags">Additional Tags:</dt>
    <dd class="freeform tags"><ul class="commas"><li><a class="tag" href="/tags/Fluff/works">Fluff</a></li></ul></dd>
    <dt class="language">Language:</dt>
    <dd class="language" lang="en">English</dd>
    <dt class="stats">Stats:</dt>
    <dd class="stats"><dl class="stats">
      <dt class="published">Published:</dt><dd class="published">2012-06-01</dd>
      <dt class="status">Updated:</dt><dd class="status">2012-06-19</dd>
      <dt class="words">Words:</dt><dd class="words">3,169</dd>
      <dt class="chapters">Chapters:</dt><dd class="chapters">2/3</dd>
      <dt class="comments">Comments:</dt><dd class="comments"><a href="/works/${id}?show_comments=true">11</a></dd>
      <dt class="kudos">Kudos:</dt><dd class="kudos">86</dd>
      <dt class="bookmarks">Bookmarks:</dt><dd class="bookmarks"><a href="/works/${id}/bookmarks">8</a></dd>
      <dt class="hits">Hits:</dt><dd class="hits">1,101</dd>
    </dl></dd>
  </dl></div>
  <div id="workskin"><div class="preface group">
    <h2 class="title heading">Almost Ever After ${restricted ? '<img alt="(Restricted)" title="Restricted" src="/images/lockblue.png">' : ''}</h2>
    <h3 class="byline heading"><a rel="author" href="/users/Alsike/pseuds/Alsike">Alsike</a>, <a rel="author" href="/users/Other/pseuds/Pen">Pen (Other)</a></h3>
    <div class="summary module"><h3 class="heading">Summary:</h3>
      <blockquote class="userstuff"><p>Elizabeth is having a party.</p><p>Emily has to go.</p></blockquote>
    </div>
  </div></div>
</div></body></html>`
}

describe('blurbs from work pages', { skip: skipWithoutChrome }, () => {
  let page
  let close

  before(async () => {
    ({ page, close } = await loadModuleInPage('src/content_script/searchView/workPageBlurb.tsx', 'WorkPage', {
      stubBrowser: true,
      // The blurb keeps AO3's relative links, as a scraped one does, and
      // `parseWork` resolves them — which a blank page has no base URL to do.
      prepare: p => p.evaluate(() => {
        const base = document.createElement('base')
        base.href = 'https://archiveofourown.org/'
        document.head.append(base)
      }),
    }))
  }, { timeout: 120000 })

  after(async () => {
    await close?.()
  })

  /**
   * Fetch `ids` against a scripted archive: `pages` maps a work id to the answer
   * its page gives (`{ status }`, or `{ html }` for a 200).
   */
  const fetchBlurbs = (ids, pages) => page.evaluate(async ({ ids, pages }) => {
    const asked = []
    globalThis.fetch = async (url) => {
      const id = new URL(url).pathname.match(/\/works\/(\d+)/)?.[1]
      asked.push(id)
      const answer = pages[id] ?? { status: 404 }
      if (answer.html)
        return new Response(answer.html, { status: 200 })
      const headers = new Headers()
      // Short: the pause a refusal opens is shared with every later fetch, the
      // next test's included.
      if (answer.status === 429)
        headers.set('Retry-After', '1')
      return new Response('', { status: answer.status, headers })
    }
    // Patience 0: a refusal comes straight back rather than being waited out.
    const result = await globalThis.WorkPage.fetchWorkBlurbs(ids, { patience: 0, concurrency: 1 })
    return {
      asked,
      failed: result.failed,
      blocked: result.blocked,
      works: result.works.map(({ el, ...work }) => ({ ...work, html: el.outerHTML })),
    }
  }, { ids, pages })

  test('everything a blurb says comes out of the work page', async () => {
    const { works, failed, blocked } = await fetchBlurbs(['42'], { 42: { html: workPage() } })
    assert.deepEqual(failed, [])
    assert.equal(blocked, false)
    const [work] = works
    assert.equal(work.workId, '42')
    assert.equal(work.title, 'Almost Ever After')
    assert.deepEqual(work.authors, [
      { userId: 'Alsike', pseud: 'Alsike', text: 'Alsike' },
      { userId: 'Other', pseud: 'Pen', text: 'Pen (Other)' },
    ])
    assert.equal(work.rating, 'Teen And Up Audiences')
    assert.deepEqual(work.warnings, ['No Archive Warnings Apply'])
    assert.deepEqual(work.categories, ['F/F', 'Gen'])
    assert.deepEqual(work.fandoms, ['Criminal Minds', 'X-Men'])
    assert.deepEqual(work.relationships, ['Emma Frost/Emily Prentiss'])
    assert.deepEqual(work.characters, ['Emma Frost', 'Emily Prentiss'])
    assert.deepEqual(work.freeforms, ['Fluff'])
    assert.equal(work.language, 'English')
    assert.equal(work.words, 3169)
    assert.deepEqual(work.chapters, { written: 2, total: 3 })
    assert.equal(work.complete, false)
    assert.equal(work.comments, 11)
    assert.equal(work.kudos, 86)
    assert.equal(work.bookmarks, 8)
    assert.equal(work.hits, 1101)
    assert.equal(work.summaryText.replace(/\s+/g, ' '), 'Elizabeth is having a party.Emily has to go.')
    // The last update, as a day — the most a work page says.
    assert.equal(work.dateUpdated, Date.UTC(2012, 5, 19) / 1000)
    assert.equal(work.dateText, '19 Jun 2012')
    assert.equal(work.restricted, false)
  })

  test('a locked work is still marked as one', async () => {
    const { works } = await fetchBlurbs(['42'], { 42: { html: workPage({ restricted: true }) } })
    assert.equal(works[0].restricted, true)
  })

  test('it is laid out as AO3 lays out a blurb, so it draws like one', async () => {
    const { works } = await fetchBlurbs(['42'], { 42: { html: workPage() } })
    const html = works[0].html
    assert.match(html, /^<li id="work_42" class="work blurb group"/)
    assert.match(html, /<span class="rating-teen rating"/)
    assert.match(html, /<span class="category-multi category"/)
    assert.match(html, /<span class="complete-no iswip"/)
    // No script, no handler: nothing but markup went into it.
    assert.doesNotMatch(html, /<script|\son\w+=/i)
  })

  test('a page that is not a work is a failure, and says nothing about the rest', async () => {
    const { works, failed, blocked } = await fetchBlurbs(['1', '2', '3'], {
      1: { html: workPage({ id: 1 }) },
      2: { status: 404 },
      3: { html: '<!DOCTYPE html><html><body><p>This work could not be found.</p></body></html>' },
    })
    assert.deepEqual(works.map(w => w.workId), ['1'])
    assert.deepEqual(failed.sort(), ['2', '3'])
    assert.equal(blocked, false)
  })

  test('being refused stops the fetch, and writes nothing off', async () => {
    const { works, failed, blocked, asked } = await fetchBlurbs(['1', '2', '3'], {
      1: { html: workPage({ id: 1 }) },
      2: { status: 429 },
      3: { html: workPage({ id: 3 }) },
    })
    assert.equal(blocked, true)
    assert.deepEqual(works.map(w => w.workId), ['1'])
    assert.deepEqual(failed, [], 'a work AO3 wouldn’t serve right now is not a work that can’t be had')
    assert.deepEqual(asked, ['1', '2'], 'and nothing more is asked for once AO3 has said no')
  })

  test('a server error is AO3’s bad moment, not a verdict on the work', async () => {
    const { failed } = await fetchBlurbs(['5'], { 5: { status: 503 } })
    assert.deepEqual(failed, [])
  })
})
