import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { loadModuleInPage, skipWithoutChrome } from '../siteExport/helpers.mjs'

/**
 * The listing scraper's behaviour when AO3 pushes back.
 *
 * It needs a DOM — it parses fetched pages and adopts blurbs into the document —
 * but not the extension, so this uses the site-export rig: one module bundled
 * with esbuild and dropped into a blank page, which costs a Chrome launch and no
 * build.
 *
 * `patience: 0` is what makes any of it testable. It means "don't wait out a
 * 429 inside the request" — so the fetch layer hands the refusal straight back,
 * which is precisely the state the scraper's rounds exist to recover from, and
 * the state a real reader reaches after two minutes of being turned away.
 */
describe('scrapeListing under a rate limit', { skip: skipWithoutChrome }, () => {
  let page
  let close

  before(async () => {
    ({ page, close } = await loadModuleInPage(
      'src/content_script/searchView/scrape.ts',
      'Scrape',
      { stubBrowser: true },
    ))
  }, { timeout: 120000 })

  after(async () => {
    await close?.()
  })

  /**
   * Run a scrape against a scripted archive.
   *
   * `refuseFirst` is how a rate limit really behaves: the next N requests are
   * refused *whatever they ask for*, because the refusal is about us and not
   * about any page. `script` is for the other kind of answer — a 404 belongs to
   * one page, so it is keyed by page number (its last step repeats).
   *
   * Returns what the scrape produced plus a log of every request, which is the
   * half that says whether we were polite about it.
   */
  const scrape = opts => page.evaluate(async ({ script = {}, pageCount, waitBudget, refuseFirst = 0, want }) => {
    const asked = []
    const answers = new Map(Object.entries(script).map(([n, steps]) => [n, [...steps]]))
    let refusals = refuseFirst

    const refused = (retryAfter) => {
      const headers = new Headers()
      headers.set('Retry-After', String(retryAfter))
      return new Response('', { status: 429, headers })
    }

    globalThis.fetch = async (url) => {
      const n = new URL(url).searchParams.get('page')
      asked.push({ page: Number(n), at: Date.now() })
      if (refusals > 0) {
        refusals--
        return refused(1)
      }
      const steps = answers.get(n)
      const step = steps ? (steps.length > 1 ? steps.shift() : steps[0]) : { status: 200 }
      if (step.status === 429)
        return refused(step.retryAfter ?? 1)
      if (step.status !== 200)
        return new Response('', { status: step.status })
      const blurbs = Array.from({ length: 2 }, (_, i) => {
        const id = (Number(n) - 1) * 2 + i + 1
        return `<li class="work blurb group" id="work_${id}">
          <div class="header module"><h4 class="heading">
            <a href="https://archiveofourown.org/works/${id}">Work ${id}</a>
            by <a rel="author" href="https://archiveofourown.org/users/someone/pseuds/someone">someone</a>
          </h4></div>
          <dl class="stats"><dt class="words">Words:</dt><dd class="words">100</dd>
          <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd></dl>
        </li>`
      }).join('')
      return new Response(`<ol class="work index group">${blurbs}</ol>`, { status: 200 })
    }

    const result = await globalThis.Scrape.scrapeListing({
      pageCount,
      pageUrl: p => `https://archiveofourown.org/list?page=${p}`,
      // A listing being searched rather than shown: stop once every wanted work
      // has turned up. Two works per page, so work n is on page ceil(n / 2).
      satisfied: want ? ids => want.every(id => ids.has(id)) : undefined,
      // See the suite's own note: no waiting inside a single request, so a
      // refusal reaches the scraper rather than being absorbed below it.
      patience: 0,
      waitBudget,
      concurrency: 3,
    })
    return {
      titles: result.works.map(w => w.title),
      loadedPages: result.loadedPages,
      totalPages: result.totalPages,
      blocked: !!result.blocked,
      satisfied: !!result.satisfied,
      asked,
    }
  }, opts)

  /** Gaps between consecutive requests long enough to be a pause, not a fetch. */
  const pauses = asked => asked.slice(1)
    .map((call, i) => call.at - asked[i].at)
    .filter(gap => gap >= 500)

  test('one refusal costs the listing nothing, and stops the pool exactly once', async () => {
    // A single 429, aimed at whichever page happened to ask first. It used to
    // take that page out of the listing for good and leave the rest of the pool
    // to discover the same wall one at a time; now the round is called off, the
    // pool waits once, and everything still wanted is asked for again.
    const result = await scrape({ pageCount: 8, waitBudget: 60_000, refuseFirst: 1 })

    assert.equal(result.blocked, false)
    assert.equal(result.loadedPages, 8, 'every page landed in the end')
    assert.deepEqual(
      result.titles,
      Array.from({ length: 16 }, (_, i) => `Work ${i + 1}`),
      'and in the listing’s own order, however out of order they arrived',
    )
    assert.equal(pauses(result.asked).length, 1, 'stood still once, for the whole run')
  })

  test('a refusal the pool ran into together is still one refusal', async () => {
    // Three workers turned away in the same instant have met one wall between
    // them. What must not happen is three separate waits.
    const result = await scrape({ pageCount: 10, waitBudget: 60_000, refuseFirst: 3 })

    assert.equal(result.blocked, false)
    assert.equal(result.loadedPages, 10)
    assert.ok(pauses(result.asked).length <= 2, `stood still ${pauses(result.asked).length} times`)
  })

  test('an archive that will not relent ends the scrape, it does not grind', async () => {
    // Thirty pages, refused for ever. What must not happen is thirty separate
    // discoveries of the same wall, each paying for it in full.
    const result = await scrape({ pageCount: 30, waitBudget: 2500, refuseFirst: Number.MAX_SAFE_INTEGER })

    assert.equal(result.blocked, true, 'the reader is told AO3 is the reason, not the pages')
    assert.equal(result.loadedPages, 0)
    // Nothing came back, and `blocked` is the only thing standing between the
    // reader and being told their history is empty.
    assert.deepEqual(result.titles, [])
    assert.ok(
      result.asked.length < 30,
      `asked AO3 ${result.asked.length} times for a listing it was refusing outright`,
    )
  })

  test('a listing being searched stops once it has found what it came for', async () => {
    // Fifty pages of haystack, and the two works wanted are on page two. Three
    // workers are already in flight when it lands, so a page or two more is
    // read — but reading all fifty to find two works is the thing this prevents.
    const result = await scrape({ pageCount: 50, waitBudget: 60_000, want: ['3', '4'] })

    assert.equal(result.satisfied, true)
    assert.ok(result.asked.length <= 6, `read ${result.asked.length} pages looking for two works`)
    assert.ok(result.titles.includes('Work 3') && result.titles.includes('Work 4'))
    // Stopping early leaves `loadedPages` short of the total, and that is not a
    // shortfall — `satisfied` is what tells the caller so.
    assert.ok(result.loadedPages < result.totalPages)
  })

  test('a page that is broken on its own account is given up on, and only it', async () => {
    // A 404 says something about *this* page, so it earns its own strikes and
    // costs the rest of the listing nothing.
    const result = await scrape({
      pageCount: 4,
      waitBudget: 60_000,
      script: { 3: [{ status: 404 }] },
    })

    assert.equal(result.blocked, false)
    assert.equal(result.loadedPages, 3, 'the other three still made it')
    assert.deepEqual(result.titles, ['Work 1', 'Work 2', 'Work 3', 'Work 4', 'Work 7', 'Work 8'])
    assert.equal(
      result.asked.filter(call => call.page === 3).length,
      3,
      'tried three times, then left alone',
    )
  })
})
