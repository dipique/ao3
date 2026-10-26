import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { PACE_EVERY, PACE_IDLE_RESET_MS } from '../../src/content_script/archiveFetch.ts'
import { loadModuleInPage, skipWithoutChrome } from '../siteExport/helpers.mjs'

/**
 * Runs in the page: a clock for the pacing to read and wait on, in place of
 * real time. It stands still until something sleeps on it; then, once the
 * answers already in flight have landed, it jumps to the earliest wake-up and
 * wakes everyone due. Three workers refused together sleep to the same instant
 * and wake together, as they would in real time — in a few milliseconds.
 */
function installClock() {
  let now = Date.UTC(2026, 0, 1)
  const sleepers = []
  let waking = false
  function wake() {
    waking = false
    if (!sleepers.length)
      return
    now = Math.max(now, Math.min(...sleepers.map(sleeper => sleeper.at)))
    for (const sleeper of sleepers.splice(0)) {
      if (sleeper.at <= now)
        sleeper.resolve()
      else
        sleepers.push(sleeper)
    }
    if (sleepers.length)
      schedule()
  }
  // A task, not a microtask, so that answers on their way land first.
  function schedule() {
    if (!waking) {
      waking = true
      setTimeout(wake, 0)
    }
  }
  globalThis.__clock = {
    now: () => now,
    advance: (ms) => {
      now += ms
    },
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      const sleeper = { at: now + ms, resolve }
      signal?.addEventListener('abort', () => {
        sleepers.splice(sleepers.indexOf(sleeper), 1)
        reject(signal.reason)
      }, { once: true })
      sleepers.push(sleeper)
      schedule()
    }),
  }
  globalThis.Scrape.useArchiveClock(globalThis.__clock)
}

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
 *
 * The pauses the pool then sits out run to seconds each, so the pacing is given
 * a clock of the test's own ({@link installClock}): one that stands still while
 * requests are answered and jumps to the end of a pause once everyone is
 * waiting on it. What the tests measure — how often the pool stood still, and
 * for how long — reads the same off either clock.
 */
describe('scrapeListing under a rate limit', { skip: skipWithoutChrome }, () => {
  let page
  let close

  before(async () => {
    ({ page, close } = await loadModuleInPage(
      'test/searchView/scrapeEntry.ts',
      'Scrape',
      { stubBrowser: true },
    ))
    await page.evaluate(installClock)
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
  const scrape = opts => page.evaluate(async ({ script = {}, pageCount, waitBudget, refuseFirst = 0, want, order, firstPage = false, abortAtPause = false, idleReset }) => {
    const asked = []
    const answers = new Map(Object.entries(script).map(([n, steps]) => [n, [...steps]]))
    let refusals = refuseFirst
    // Long enough idle that the pacing starts its count of requests afresh,
    // whatever an earlier scrape on this page left it at.
    globalThis.__clock.advance(idleReset)

    // `order` lands the pages in the order it lists them: each page's answer
    // waits until as many pages as come before it in `order` have landed.
    let landed = 0
    const landing = []
    const landedAtLeast = n => new Promise((resolve) => {
      if (landed >= n)
        resolve()
      else
        landing.push({ n, resolve })
    })
    const onProgress = (done) => {
      landed = done
      for (const waiter of landing.splice(0)) {
        if (waiter.n <= landed)
          waiter.resolve()
        else
          landing.push(waiter)
      }
    }

    const listingPage = (n) => {
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
      return `<ol class="work index group">${blurbs}</ol>`
    }

    const refused = (retryAfter) => {
      const headers = new Headers()
      headers.set('Retry-After', String(retryAfter))
      return new Response('', { status: 429, headers })
    }

    globalThis.fetch = async (url) => {
      const n = new URL(url).searchParams.get('page')
      asked.push({ page: Number(n), at: globalThis.__clock.now() })
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
      if (order)
        await landedAtLeast(order.indexOf(Number(n)) + (firstPage ? 1 : 0))
      return new Response(listingPage(n), { status: 200 })
    }

    const reports = []
    const controller = new AbortController()
    const result = await globalThis.Scrape.scrapeListing({
      pageCount,
      pageUrl: p => `https://archiveofourown.org/list?page=${p}`,
      firstPageDoc: firstPage ? new DOMParser().parseFromString(listingPage(1), 'text/html') : undefined,
      // A listing being searched rather than shown: stop once every wanted work
      // has turned up. Two works per page, so work n is on page ceil(n / 2).
      satisfied: want ? ids => want.every(id => ids.has(id)) : undefined,
      // See the suite's own note: no waiting inside a single request, so a
      // refusal reaches the scraper rather than being absorbed below it.
      patience: 0,
      waitBudget,
      concurrency: 3,
      signal: controller.signal,
      onProgress,
      onPartial: (works, loadedPages) => {
        const paused = globalThis.Scrape.archiveWaitRemaining() > 0
        reports.push({ titles: works.map(w => w.title), loadedPages, paused, asked: asked.length })
        if (paused && abortAtPause)
          controller.abort()
      },
    }).catch(err => ({ error: err.name }))
    return {
      error: result.error,
      titles: result.works?.map(w => w.title),
      loadedPages: result.loadedPages,
      totalPages: result.totalPages,
      blocked: !!result.blocked,
      satisfied: !!result.satisfied,
      asked,
      reports,
    }
  }, { idleReset: PACE_IDLE_RESET_MS + 1, ...opts })

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

  test('a listing being searched stops on page 1 when that is where the works are, reported or not', async () => {
    // Page 1 is reported as it lands; the report must not cost `satisfied`
    // the ids it reads off the same page.
    const result = await scrape({ pageCount: 50, waitBudget: 60_000, want: ['1', '2'] })

    assert.equal(result.satisfied, true)
    assert.ok(result.asked.length <= 6, `read ${result.asked.length} pages looking for two works on page 1`)
    assert.deepEqual(result.reports[0].titles, ['Work 1', 'Work 2'])
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

  /** Work 1 … Work n, the titles of a listing's first `pages` pages. */
  const titlesOf = pages => Array.from({ length: pages * 2 }, (_, i) => `Work ${i + 1}`)

  describe('partial results', () => {
    test('each report is the pages landed from page 1 on, whatever landed beyond a gap', async () => {
      // Page 3 lands first, then page 1, then page 2: when page 1 lands the run
      // from page 1 is one page long, page 3 notwithstanding.
      const result = await scrape({ pageCount: 3, waitBudget: 60_000, order: [3, 1, 2] })

      assert.deepEqual(result.reports.map(r => r.loadedPages), [1, 3])
      assert.deepEqual(result.reports[0].titles, titlesOf(1))
      assert.deepEqual(result.reports[1].titles, titlesOf(3))
      assert.deepEqual(result.titles, titlesOf(3))
    })

    test('reports after page 1, as the pool pauses, and at the end', async () => {
      // Enough pages that the pool takes a breather part-way through.
      const pageCount = PACE_EVERY + 5
      const result = await scrape({ pageCount, waitBudget: 60_000 })

      assert.equal(result.reports[0].loadedPages, 1)
      assert.ok(result.reports.some(r => r.paused && r.loadedPages > 1 && r.loadedPages < pageCount), 'one as the pool sits out its breather')
      assert.equal(result.reports.at(-1).loadedPages, pageCount)
      assert.deepEqual(result.reports.at(-1).titles, titlesOf(pageCount))
      const sizes = result.reports.map(r => r.loadedPages)
      assert.deepEqual(sizes, [...new Set(sizes)].sort((a, b) => a - b), 'only when the run grows')
      assert.ok(result.reports.length < pageCount, 'not on every page')
    })

    test('reports before sitting out a refused round', async () => {
      const result = await scrape({ pageCount: 4, waitBudget: 60_000, script: { 3: [{ status: 429 }, { status: 200 }] } })

      assert.equal(result.blocked, false)
      assert.ok(result.reports.some(r => r.paused && r.loadedPages === 2), 'pages 1–2 reported as the pool stops for the refusal')
      assert.equal(result.reports.at(-1).loadedPages, 4)
    })

    test('nothing is reported once the scrape is aborted, the pause it was in included', async () => {
      const result = await scrape({ pageCount: PACE_EVERY + 5, waitBudget: 60_000, abortAtPause: true })

      assert.equal(result.error, 'AbortError')
      const paused = result.reports.findIndex(r => r.paused)
      assert.ok(paused >= 0)
      assert.equal(result.reports.length, paused + 1, 'the report the abort came from is the last')
    })

    test('a page 1 already in hand is reported before anything is asked', async () => {
      const result = await scrape({ pageCount: 3, waitBudget: 60_000, firstPage: true, order: [3, 2] })

      assert.deepEqual(result.reports[0], { titles: titlesOf(1), loadedPages: 1, paused: false, asked: 0 })
      assert.ok(!result.asked.some(call => call.page === 1), 'and page 1 is not asked for again')
      assert.deepEqual(result.reports.at(-1).titles, titlesOf(3))
    })
  })
})
