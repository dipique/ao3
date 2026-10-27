import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { formatDay, isoDay, utcToday } from '../../src/common/trackedLists.ts'
import { READING_ELSEWHERE } from '../../src/common/trackedReads.ts'
import { recordsLine, REVIEW_EMPTY, REVIEW_NAME, reviewedThroughLabel, START_OFF, WORKS_PER_REVIEW } from '../../src/options_ui/model/review.ts'
import { TRACK_OFF } from '../../src/options_ui/model/savedListRows.ts'
import { DIST, installMock, storedLists } from './helpers.mjs'
import { ARCHIVE, captureDownloads, mentions, skip, startOptions, stubArchive, until } from './optionsPage.mjs'
import { archiveAnswers, archiveRoutes, CLOCK_BASE, installClock, listing, resetWorkIds, reviewDrawn, trackedOption } from './trackedReview.mjs'

const TODAY = utcToday()
const ROW = 'review-tracked-lists'
/** The row under Saved lists of a stored list no saved list is at. */
const copyRow = key => `copy:${key}`
/** The review's stored window, under the key the review keeps it by. */
const WINDOW = 'tracked-review'
const READINGS = `${ARCHIVE}/users/reader/readings#ao3e-tracked`
/** The review's open URL, on the readings of the reader, `reader`. */
const REVIEW_OPEN = `${ARCHIVE}/users/reader/readings#ao3e-open=tracked-review`
/** Another stored list, whose job turns This review's own off, and what it is called. */
const OTHER = 'tag-works:Coffee%20Shop%20AU'
const OTHER_NAME = 'Coffee Shop AU'

const COFFEE = { id: 'c0ffee', kind: 'text-search', url: '/works/search?work_search%5Bquery%5D=coffee', alias: 'Coffee shop AUs', tracked: true, since: TODAY - 5 }

const blurb = id => `<li class="work blurb group" id="work_${id}" role="article">
  <div class="header module"><h4 class="heading"><a href="/works/${id}">Work ${id}</a>
    by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4></div>
  <dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd></dl>
</li>`

/** A work page as `view_full_work=true` returns it. */
const workPage = id => `<!doctype html>
<html><head><meta charset="utf-8"><title>Work ${id}</title></head>
<body class="logged-in">
  <div id="main" class="works-show region">
    <dl class="work meta group">
      <dt class="stats">Stats:</dt><dd class="stats"><dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd></dl></dd>
    </dl>
    <div id="workskin">
      <div class="preface group"><h2 class="title heading">Work ${id}</h2></div>
      <div id="chapters"><div class="userstuff"><p>The text of work ${id}.</p></div></div>
    </div>
  </div>
</body></html>`

/** One list tracked, and saved; `enabled` and `lists` as given. */
function listsSeed({ enabled = true, lists = [COFFEE] } = {}) {
  return {
    'option.trackedLists': { enabled, target: 40, reviewedThrough: TODAY - 9, lists },
    'option.savedLists': { v: 1, lists: { c0ffee: { id: 'c0ffee', kind: 'text-search', url: COFFEE.url, title: COFFEE.alias } } },
  }
}

/** The review's window, gathered 22 minutes ago: two works, none cached. */
const WINDOW_COPY = {
  scrapedAt: Date.now() - 22 * 60 * 1000,
  blurbsHtml: [blurb(61), blurb(62)],
  descriptor: { sourceId: 'tracked-review', label: 'Tracked review', listUrl: READINGS },
}

const OTHER_COPY = {
  scrapedAt: Date.now() - 3 * 60 * 60 * 1000,
  blurbsHtml: [blurb(71)],
  descriptor: { sourceId: 'tag-works', label: 'Coffee Shop AU', listUrl: `${ARCHIVE}/tags/Coffee%20Shop%20AU/works` },
}

/**
 * The Review block under Lists: the Tracked lists switch, then three cells —
 * Reviewed through*, *Works per review*, and *This review*, the review's own
 * window, which is no list but is stored like one, so it can be cached and
 * downloaded, and which Start Review opens.
 *
 * The stand-in for AO3 holds every work page until the last job test lets them
 * go, so a job is caught running for as long as a test needs it to be.
 */
describe('options UI — the Review block', { skip }, () => {
  let session
  let options
  let page
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })

  before(async () => {
    session = await startOptions()
    options = await session.open({
      seed: { 'option.user': { userId: 'reader' }, ...listsSeed(), ...storedLists({ [WINDOW]: WINDOW_COPY, [OTHER]: OTHER_COPY }) },
      hash: '#review',
      viewport: { width: 1440, height: 900 },
      prepare: async (p) => {
        await stubArchive(p, async (url) => {
          // The tracked list, read by the review's refresh: nothing new on it.
          if (new URL(url).pathname === '/works/search')
            return { body: '<!DOCTYPE html><html><body class="logged-in"><div id="main" class="works-search region"><h3 class="heading">0 Found</h3><ol class="work index group"></ol></div></body></html>' }
          const workId = /^\/works\/(\d+)$/.exec(new URL(url).pathname)?.[1]
          if (!workId)
            return { status: 404 }
          await held
          return { body: workPage(workId) }
        })
        await p.evaluateOnNewDocument(captureDownloads)
      },
    })
    page = options.page
  }, { timeout: 180000 })

  after(() => {
    release()
    return session?.close()
  })

  const cell = async (name) => {
    const handle = await page.$(`[data-review-cell="${name}"]`)
    assert.ok(handle, `no review cell ${name}`)
    return handle
  }
  const inCell = async (name, action) => options.action(await cell(name), action)
  const written = () => options.lastWrite('option.trackedLists')
  const trackedWrites = () => page.evaluate(() => window.__writes.filter(w => 'option.trackedLists' in w).length)
  const jobState = async scope => scope.evaluate(el => el.querySelector('[data-job-state]')?.dataset.jobState ?? null)
  const jobWrites = () => page.evaluate(() => window.__writes.filter(w => 'siteExportJob' in w).length)
  /** This review's figure: `count`, its works, or `detail`, when it was gathered and how many are cached. */
  const figure = async part => options.text(await (await cell('this-review')).$(`[data-review-figure="${part}"]`))
  const reviewedThrough = async () => options.text(await cell('reviewed-through'))

  /** A pointer press, as a person makes one: the stepper's buttons answer the pointer, not a click event. */
  async function point(handle) {
    await handle.evaluate(el => el.scrollIntoView({ block: 'center' }))
    await handle.click()
  }

  /**
   * The control is off, and says why in its tooltip and in what describes it:
   * `reason`, or a reason that names it.
   */
  async function saysOff(control, reason) {
    assert.equal(await control.evaluate(el => el.disabled), true, `${await options.name(control)} should be off`)
    assert.ok(mentions(await control.evaluate(el => el.title), reason), `the tooltip should give ${reason}`)
    assert.ok(mentions(await options.description(control), reason), `the description should give ${reason}`)
  }

  /** The control is on, with no reason to give. */
  async function saysOn(control) {
    assert.equal(await control.evaluate(el => el.disabled), false, `${await options.name(control)} should be on`)
    assert.equal(await control.evaluate(el => el.getAttribute('aria-describedby')), null)
  }

  test('the switch, then Reviewed through, Works per review and This review', async () => {
    const row = await options.row(ROW)
    assert.ok(await options.control(row, 'switch'))
    assert.deepEqual(await row.$$eval('[data-review-cell]', els => els.map(el => el.dataset.reviewCell)), ['reviewed-through', 'works-per-review', 'this-review'])

    assert.match(await figure('count'), /\b2\b/, 'the window\'s two works')
    assert.match(await figure('detail'), /\b0\b/, 'none of them cached')
    const start = await inCell('this-review', 'start')
    assert.equal(await start.evaluate(a => a.getAttribute('href')), REVIEW_OPEN)
    assert.match(await options.name(start), /\b2\b/, 'Start Review says how many works the review holds')
    await saysOn(await inCell('this-review', 'cache'))
    await saysOn(await inCell('this-review', 'download'))
    assert.deepEqual(await options.actions(await cell('this-review'), 'more'), [], 'with nothing failed and nothing cached, More has nothing to offer')
  })

  test('the review\'s window is This review, not a row of its own under Saved lists', async () => {
    assert.deepEqual((await options.savedListIds()).filter(id => id.startsWith('copy:')), [copyRow(OTHER)])
  })

  test('Reviewed through: Change… opens a date, and Save writes it, at most yesterday', async () => {
    assert.ok(mentions(await reviewedThrough(), formatDay(TODAY - 9)))

    const setDate = async (value) => {
      await options.press(await inCell('reviewed-through', 'change'))
      const field = await (await cell('reviewed-through')).$('input[type="date"]')
      await until('the date field to take focus', () => field.evaluate(el => document.activeElement === el))
      await field.evaluate((el, v) => {
        el.value = v
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }, value)
      await options.press(await inCell('reviewed-through', 'save'))
    }

    await setDate(isoDay(TODAY - 20))
    await until('the day to be written', async () => (await written())?.reviewedThrough === TODAY - 20)
    assert.ok(mentions(await reviewedThrough(), formatDay(TODAY - 20)))
    const change = await inCell('reviewed-through', 'change')
    await until('focus to go back to Change…', () => change.evaluate(el => document.activeElement === el))

    await setDate(isoDay(TODAY + 3))
    await until('the latest day to be written', async () => (await written())?.reviewedThrough === TODAY - 1)

    // Cancel writes nothing: the next write is the only one after it.
    const before = await trackedWrites()
    await options.press(await inCell('reviewed-through', 'change'))
    await options.press(await inCell('reviewed-through', 'cancel'))
    assert.ok(mentions(await reviewedThrough(), formatDay(TODAY - 1)))
    await setDate('')
    await until('the watermark to be cleared', async () => (await written())?.reviewedThrough === 0)
    assert.equal(await trackedWrites(), before + 1)
    assert.ok(mentions(await reviewedThrough(), reviewedThroughLabel(0)))
  })

  test('Works per review: the stepper steps by one, and a typed number is clamped as the field is left', async () => {
    const field = await options.control(await cell('works-per-review'), 'spinbutton')
    const value = () => field.evaluate(el => el.value)
    assert.equal(await value(), '40')

    await point(await inCell('works-per-review', 'increment'))
    await until('one more to be written', async () => (await written())?.target === 41)
    await field.focus()
    await field.press('ArrowDown')
    await until('one fewer to be written', async () => (await written())?.target === 40)

    await field.click({ clickCount: 3 })
    await field.type('900')
    await field.evaluate(el => el.blur())
    await until('the most to be written', async () => (await written())?.target === WORKS_PER_REVIEW.max)
    await until('the field to show it', async () => await value() === '500')
    const more = await inCell('works-per-review', 'increment')
    assert.equal(await more.evaluate(el => el.disabled), true)
    assert.ok(mentions(await more.evaluate(el => el.title), WORKS_PER_REVIEW.max), 'its tooltip gives the bound it is off at')

    // An emptied field keeps the number it had, and writes nothing: the next
    // write, a step down, is the only one after it.
    const before = await trackedWrites()
    await field.click({ clickCount: 3 })
    await field.press('Backspace')
    await field.evaluate(el => el.blur())
    await until('the field to show the number again', async () => await value() === '500')
    await field.focus()
    await field.press('ArrowDown')
    await until('one fewer to be written', async () => (await written())?.target === 499)
    assert.equal(await trackedWrites(), before + 1)

    await field.click({ clickCount: 3 })
    await field.type('3')
    await field.press('Enter')
    await until('the least to be written', async () => (await written())?.target === WORKS_PER_REVIEW.min)
    await until('the field to show it', async () => await value() === '10')
    const fewer = await inCell('works-per-review', 'decrement')
    assert.equal(await fewer.evaluate(el => el.disabled), true)
    assert.ok(mentions(await fewer.evaluate(el => el.title), WORKS_PER_REVIEW.min), 'its tooltip gives the bound it is off at')
  })

  test('with Tracked lists off, the review\'s settings and Start Review are off and say why; its offline copy isn\'t', async () => {
    await options.press(await options.control(await options.row(ROW), 'switch'))
    await until('the switch to be written', async () => (await written())?.enabled === false)

    await saysOff(await inCell('reviewed-through', 'change'), TRACK_OFF.review)
    await saysOff(await options.control(await cell('works-per-review'), 'spinbutton'), TRACK_OFF.review)
    await saysOff(await inCell('this-review', 'start'), TRACK_OFF.review)
    assert.deepEqual(await options.controls(await cell('this-review'), 'link'), [], 'Start Review links nowhere')
    await saysOn(await inCell('this-review', 'cache'))
    await saysOn(await inCell('this-review', 'download'))

    // The lists themselves are under Saved lists, and keep their titles and
    // links; only tracking waits for the switch.
    const coffee = await options.savedList('c0ffee')
    const toggle = await options.control(coffee, 'switch')
    assert.equal(await toggle.evaluate(el => el.disabled), true)
    assert.ok(mentions(await options.description(toggle), TRACK_OFF.review))
    assert.ok(await options.action(coffee, 'view-edit'))

    await options.press(await options.control(await options.row(ROW), 'switch'))
    await until('the switch to be written', async () => (await written())?.enabled === true)
    await until('Start Review to link again', async () => (await inCell('this-review', 'start')).evaluate(el => el.tagName === 'A'))
    await saysOn(await inCell('reviewed-through', 'change'))
    await saysOn(await options.control(await options.savedList('c0ffee'), 'switch'))
  })

  test('Cache works runs a job on the window, its line in the cell, with Pause or Cancel, then Continue or Discard', async () => {
    await options.press(await inCell('this-review', 'cache'))
    await until('the job to be running', async () => await jobState(await cell('this-review')) === 'running')
    assert.ok(await (await cell('this-review')).$('[role="progressbar"]'), 'the job\'s progress is in the cell')
    await saysOff(await options.action(await options.savedListDetails(copyRow(OTHER)), 'cache'), REVIEW_NAME)
    assert.deepEqual(await options.actions(await cell('this-review'), 'cache'), [], 'Pause and Cancel take the actions\' place')

    const before = await jobWrites()
    await options.press(await inCell('this-review', 'pause'))
    await until('the stopped job to be written', async () => await jobWrites() > before && await jobState(await cell('this-review')) === 'stopped')
    const job = await options.lastWrite('siteExportJob')
    assert.equal(job.cacheKey, WINDOW)
    assert.deepEqual(job.steps, ['caching'])

    await inCell('this-review', 'resume')
    await options.press(await inCell('this-review', 'discard'))
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
    await until('the cell to drop its line', async () => await jobState(await cell('this-review')) === null)
    await saysOn(await inCell('this-review', 'cache'))
  })

  test('Cancel stops the window\'s job and throws it away', async () => {
    await options.press(await inCell('this-review', 'cache'))
    await until('the job to be running', async () => await jobState(await cell('this-review')) === 'running')
    await options.press(await inCell('this-review', 'cancel'))
    await until('the job to be gone', async () => await options.stored('siteExportJob') === null)
    await until('the cell to drop its line', async () => await jobState(await cell('this-review')) === null)
    await saysOn(await inCell('this-review', 'cache'))
  })

  test('Download Offline Copy caches the window\'s works, then exports them', async () => {
    await options.press(await inCell('this-review', 'download'))
    await until('the job to be running', async () => await jobState(await cell('this-review')) === 'running')
    const before = await jobWrites()
    await options.press(await inCell('this-review', 'pause'))
    await until('the stopped job to be written', async () => await jobWrites() > before && await jobState(await cell('this-review')) === 'stopped')
    const job = await options.lastWrite('siteExportJob')
    assert.equal(job.cacheKey, WINDOW)
    assert.deepEqual(job.steps, ['caching', 'exporting'], 'there is no listing behind the window to refresh')

    await options.press(await inCell('this-review', 'discard'))
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
  })

  test('another list\'s job turns This review\'s offline actions off, naming the list; Start Review stays', async () => {
    const other = await options.savedListDetails(copyRow(OTHER))
    await options.press(await options.action(other, 'cache'))
    await until('the job to be running', async () => await jobState(await options.savedList(copyRow(OTHER))) === 'running')

    await saysOff(await inCell('this-review', 'cache'), OTHER_NAME)
    await saysOff(await inCell('this-review', 'download'), OTHER_NAME)
    assert.ok(mentions(await options.text(await cell('this-review')), OTHER_NAME), 'the cell says which list has the job')
    assert.equal(await (await inCell('this-review', 'start')).evaluate(el => el.tagName), 'A')

    await options.press(await options.action(await options.savedList(copyRow(OTHER)), 'pause'))
    await until('the job to stop', async () => await jobState(await options.savedList(copyRow(OTHER))) === 'stopped')
    await options.press(await options.action(await options.savedList(copyRow(OTHER)), 'discard'))
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
    await saysOn(await inCell('this-review', 'cache'))
  })

  test('a job on the window runs to the end, and the cell counts what it cached', async () => {
    release()
    await options.press(await inCell('this-review', 'cache'))
    await until('the job to finish', async () => await jobState(await cell('this-review')) === 'finished')
    const index = await options.stored('workTextIndex')
    assert.ok(index['61']?.size > 0 && index['62']?.size > 0, 'both of the window\'s works were fetched')
    await until('the cell to count them', async () => /\b2\b/.test(await figure('detail')))
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})

/** When the work that failed last failed: just now, so only a retry that waits out no delay asks for it again. */
const FAILED_AT = Date.now()

/** The review's window with something for More to offer: work 61 failed, work 62 cached, and work 63 new. */
const MORE_SEED = {
  'option.user': { userId: 'reader' },
  ...listsSeed(),
  ...storedLists({ [WINDOW]: { ...WINDOW_COPY, blurbsHtml: [blurb(61), blurb(62), blurb(63)] }, [OTHER]: OTHER_COPY }),
  'workTextIndex': {
    61: { size: 0, updatedAt: 0, chapters: 0, words: 0, fetchedAt: 0, v: 1, failure: 'notfound', attempts: 1, attemptedAt: FAILED_AT },
    62: { size: 64, updatedAt: 0, chapters: 1, words: 1000, fetchedAt: FAILED_AT, v: 1 },
  },
  'workText.62': { html: '<div class="userstuff"><p>The text of work 62.</p></div>' },
}

/**
 * This review's More: what its window offers beyond its buttons, as a tile's
 * More does — a retry of the works that failed, and a download of what is
 * cached, asking AO3 for nothing. There is no refresh, since no one listing is
 * behind the window, and no remove.
 *
 * The stand-in for AO3 holds every request, so a job is caught running.
 */
describe('options UI — This review\'s More', { skip }, () => {
  let session
  let options
  let page
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  /** Every address the page asked AO3 for. */
  const asked = []

  before(async () => {
    session = await startOptions()
    options = await session.open({
      seed: MORE_SEED,
      hash: '#review',
      viewport: { width: 1440, height: 900 },
      prepare: async (p) => {
        await stubArchive(p, async (url) => {
          asked.push(new URL(url).pathname)
          await held
          return { status: 404 }
        })
        await p.evaluateOnNewDocument(captureDownloads)
      },
    })
    page = options.page
  }, { timeout: 180000 })

  after(() => {
    release()
    return session?.close()
  })

  const cell = async () => {
    const handle = await page.$('[data-review-cell="this-review"]')
    assert.ok(handle, 'no This review')
    return handle
  }
  const more = async () => options.action(await cell(), 'more')
  const jobState = async scope => scope.evaluate(el => el.querySelector('[data-job-state]')?.dataset.jobState ?? null)
  const writes = () => page.evaluate(() => window.__writes.length)
  /** The first job stored after the page's first `n` writes: the one an action then started. */
  const jobFrom = n => page.evaluate(k => window.__writes.slice(k).find(w => 'siteExportJob' in w)?.siteExportJob ?? null, n)
  const items = ['retry', 'download-cached']

  test('More offers a retry of the work that failed and a download of the one cached: no refresh, and no remove', async () => {
    await until('the cell to count the cached work', async () => /\b1\b/.test(await options.text(await (await cell()).$('[data-review-figure="detail"]'))))
    const trigger = await more()

    await options.openMenu(trigger)
    assert.deepEqual(await options.menuActions(), items)

    await options.closeMenu()
    await until('focus to go back to More', () => trigger.evaluate(el => document.activeElement === el))
  })

  test('Download without refreshing runs a job on the window that packages what is cached, asking AO3 for nothing', async () => {
    const from = await writes()
    const downloads = await page.evaluate(() => window.__downloads.length)
    const requests = asked.length
    await options.openMenu(await more())
    await options.press(await options.menuItem('download-cached'))
    await until('the file to be handed over', () => page.evaluate(n => window.__downloads.length > n, downloads))

    const job = await jobFrom(from)
    assert.equal(job.cacheKey, WINDOW)
    assert.deepEqual(job.steps, ['exporting'])
    assert.deepEqual(asked.slice(requests), [], 'nothing was asked of AO3')

    const { text } = await options.lastDownload()
    const open = text.indexOf('<script type="application/json" id="ao3e-data">')
    const start = text.indexOf('>', open) + 1
    const { manifest } = JSON.parse(text.slice(start, text.indexOf('</script>', start)))
    assert.deepEqual([manifest.counts.total, manifest.counts.cached], [3, 1])

    await until('the job to finish, and More to be back with the actions', async () => await jobState(await cell()) === 'finished'
      && (await options.actions(await cell(), 'more')).length === 1)
  })

  test('Retry failed works now caches the window, asking at once for the work that failed; while its job is on the window, More goes with the actions', async () => {
    const from = await writes()
    await options.openMenu(await more())
    await options.press(await options.menuItem('retry'))
    await until('the job to be running', async () => await jobState(await cell()) === 'running')

    const job = await jobFrom(from)
    assert.equal(job.cacheKey, WINDOW)
    assert.deepEqual(job.steps, ['caching'])
    assert.equal(job.retryNow, true)
    await until('the work that failed to be asked for again', () => asked.includes('/works/61'))
    assert.deepEqual(await options.actions(await cell(), 'more'), [], 'Pause and Cancel take the actions\' place, and More\'s')

    await options.press(await options.action(await cell(), 'pause'))
    await until('the job to stop', async () => await jobState(await cell()) === 'stopped')
    assert.deepEqual(await options.actions(await cell(), 'more'), [], 'so do Continue and Discard')
    await options.press(await options.action(await cell(), 'discard'))
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
    await until('More to be back', async () => (await options.actions(await cell(), 'more')).length === 1)
  })

  test('another list\'s job turns More\'s items off, each saying why', async () => {
    await options.press(await options.action(await options.savedListDetails(copyRow(OTHER)), 'cache'))
    await until('the job to be running', async () => await jobState(await options.savedList(copyRow(OTHER))) === 'running')

    await options.openMenu(await more())
    for (const action of items) {
      const item = await options.menuItem(action)
      assert.equal(await item.evaluate(el => el.hasAttribute('data-disabled')), true, `${action} should be off`)
      assert.ok(mentions(await item.evaluate(el => el.title), OTHER_NAME), `${action}'s tooltip should name the list with the job`)
      assert.ok(mentions(await options.description(item), OTHER_NAME), `${action}'s description should name the list with the job`)
    }
    await options.closeMenu()

    await options.press(await options.action(await options.savedList(copyRow(OTHER)), 'pause'))
    await until('the job to stop', async () => await jobState(await options.savedList(copyRow(OTHER))) === 'stopped')
    await options.press(await options.action(await options.savedList(copyRow(OTHER)), 'discard'))
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
  })

  test('with Tracked lists off, More stays, and its items are on', async () => {
    await options.press(await options.control(await options.row(ROW), 'switch'))
    await until('the switch to be written', async () => (await options.lastWrite('option.trackedLists'))?.enabled === false)

    await options.openMenu(await more())
    for (const action of items) {
      const item = await options.menuItem(action)
      assert.equal(await item.evaluate(el => el.hasAttribute('data-disabled')), false, `${action} should be on`)
      assert.equal(await item.evaluate(el => el.getAttribute('aria-describedby')), null)
    }
    await options.closeMenu()
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})

/**
 * Start Review opens the review from lists that are tracked, on the reader's
 * readings, which gathers the first one; with no account known, only a
 * review already gathered has a page to open it on. Before then the cell says
 * how one comes about, and the button why it is off.
 */
describe('options UI — This review with nothing to start', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  /** Start Review is off, and says why in its tooltip and in what describes it. */
  async function startIsOff(options, reason) {
    const review = await options.page.$('[data-review-cell="this-review"]')
    const start = await options.action(review, 'start')
    assert.equal(await start.evaluate(el => el.disabled), true)
    assert.ok(mentions(await start.evaluate(el => el.title), reason), `the tooltip should give ${reason}`)
    assert.ok(mentions(await options.description(start), reason), `the description should give ${reason}`)
    return review
  }

  test('before the first review is gathered, Start Review opens it on the reader\'s readings, which gathers it; there is nothing to cache', async () => {
    const options = await session.open({ seed: { 'option.user': { userId: 'reader' }, ...listsSeed() }, hash: '#review' })
    const review = await options.page.$('[data-review-cell="this-review"]')
    const start = await options.action(review, 'start')
    assert.equal(await start.evaluate(a => a.getAttribute('href')), REVIEW_OPEN)
    const text = await options.text(review)
    assert.ok(mentions(text, REVIEW_EMPTY.opens))
    assert.ok(!mentions(text, REVIEW_EMPTY.elsewhere), 'Start Review gathers it, so the cell doesn\'t send the reader to AO3 for it')
    assert.deepEqual(await options.actions(review, 'cache'), [])
    assert.deepEqual(await options.actions(review, 'download'), [])
    assert.deepEqual(await options.actions(review, 'more'), [])
    assert.deepEqual(options.problems(), [])
    await options.close()
  })

  test('before the first review, with the reader\'s account not known, there is no page to open: the cell says how one is gathered', async () => {
    const options = await session.open({ seed: listsSeed(), hash: '#review' })
    const review = await startIsOff(options, START_OFF.noWindow)
    assert.ok(mentions(await options.text(review), REVIEW_EMPTY.elsewhere))
    assert.deepEqual(await options.actions(review, 'cache'), [])
    assert.deepEqual(await options.actions(review, 'download'), [])
    assert.deepEqual(options.problems(), [])
    await options.close()
  })

  test('with no list tracked, there is nothing to review, though the window is still there to cache', async () => {
    const options = await session.open({ seed: { ...listsSeed({ lists: [] }), ...storedLists({ [WINDOW]: WINDOW_COPY }) }, hash: '#review' })
    const review = await startIsOff(options, START_OFF.noneTracked)
    assert.equal(await (await options.action(review, 'cache')).evaluate(el => el.disabled), false)
    assert.deepEqual(options.problems(), [])
    await options.close()
  })
})

describe('options UI — Pre-load', { skip }, () => {
  let session
  let options
  let page

  resetWorkIds(14000)
  const since = TODAY - 6
  const alpha = listing('alpha', Array.from({ length: 6 }, (_, i) => [since + i, 3]), { entry: { alias: 'Alpha', since } })
  const fixtures = [alpha]
  const SEED = {
    'option.user': { userId: 'me' },
    'option.trackedLists': trackedOption(fixtures, { target: 6, reviewedThrough: since - 1 }),
    'cache.markedForLater': { userId: 'me', updatedAt: Date.now(), ids: '' },
  }
  const fetched = []

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  const openWith = seed => session.open({
    seed,
    hash: '#review',
    viewport: { width: 1440, height: 900 },
    prepare: p => stubArchive(p, async url => archiveAnswers({ fixtures, fetched })(new URL(url))),
  })

  const cell = () => page.$('[data-review-cell="this-review"]')
  const records = () => page.evaluate(async () => (await window.browser.storage.local.get('trackedRead.alpha'))['trackedRead.alpha'] ?? null)

  test('Pre-load reads the tracked lists into their records, and the records line says how far', async () => {
    options = await openWith(SEED)
    page = options.page
    assert.equal(await options.text(await page.$('[data-review-records]')), recordsLine({ through: null, behind: 1 }))
    await (await options.action(await cell(), 'preload')).click()
    await until('the records to be read', async () => (await records())?.through === TODAY - 1)
    await until('the records line to say so', async () => (await options.text(await page.$('[data-review-records]'))) === recordsLine({ through: TODAY - 1, behind: 0 }))
    assert.ok(fetched.some(path => path.startsWith('/tags/alpha/works')), 'the list was read')
  })

  test('and the review opened afterwards draws from them, asking AO3 for nothing', async () => {
    const store = await page.evaluate(async () => window.browser.storage.local.get(null))
    const asked = []
    const tab = await session.browser.newPage()
    try {
      await tab.setViewport({ width: 1280, height: 900 })
      await tab.setRequestInterception(true)
      tab.on('request', archiveRoutes({ fixtures, fetched: asked }))
      await tab.evaluateOnNewDocument(installClock, CLOCK_BASE)
      await tab.evaluateOnNewDocument(installMock, store)
      await tab.goto('https://archiveofourown.org/users/me/readings#ao3e-tracked', { waitUntil: 'domcontentloaded' })
      await tab.addStyleTag({ content: await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8') })
      await tab.addScriptTag({ content: await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8') })
      await reviewDrawn(tab)
      const shown = await tab.evaluate(() => document.querySelectorAll('.AO3E--search-view--results > li.blurb').length)
      assert.equal(shown, 6, 'the two days the target fits')
      assert.deepEqual(asked.filter(path => path.startsWith('/tags/')), [], 'nothing asked of AO3')
    }
    finally {
      await tab.close()
    }
  })

  test('Pre-load refuses while a review tab is reading, and says why', async () => {
    options = await openWith({ ...SEED, 'cache.trackedReadClaim': { by: 'a review tab', at: Date.now() } })
    page = options.page
    const before = fetched.length
    await (await options.action(await cell(), 'preload')).click()
    await until('the refusal to be said', async () => mentions(await options.text(await cell()), READING_ELSEWHERE))
    assert.equal(fetched.length, before, 'nothing asked of AO3')
    assert.equal(await records(), null)
  })
})
