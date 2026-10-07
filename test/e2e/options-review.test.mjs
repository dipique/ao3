import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { formatDay, isoDay, utcToday } from '../../src/common/trackedLists.ts'
import { START_OFF, WORKS_PER_REVIEW } from '../../src/options_ui/model/review.ts'
import { TRACK_OFF } from '../../src/options_ui/model/savedListRows.ts'
import { storedLists } from './helpers.mjs'
import { ARCHIVE, captureDownloads, skip, startOptions, stubArchive, until } from './optionsPage.mjs'

const TODAY = utcToday()
const ROW = 'review-tracked-lists'
/** The row under Saved lists of a stored list no saved list is at. */
const copyRow = key => `copy:${key}`
/** The review's stored window, under the key the review keeps it by. */
const WINDOW = 'tracked-review'
const READINGS = `${ARCHIVE}/users/reader/readings#ao3e-tracked`
/** The review's open URL, on the readings of the reader, `reader`. */
const REVIEW_OPEN = `${ARCHIVE}/users/reader/readings#ao3e-open=tracked-review`
/** Another stored list, whose job turns This review's own off. */
const OTHER = 'tag-works:Coffee%20Shop%20AU'
const OTHER_JOB = 'off for now: one job at a time, and Tag: Coffee Shop AU is caching'
const REVIEW_JOB = 'off for now: one job at a time, and this review is caching'

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
  const inCell = async (name, role, label) => options.control(await cell(name), role, label)
  const written = () => options.lastWrite('option.trackedLists')
  const trackedWrites = () => page.evaluate(() => window.__writes.filter(w => 'option.trackedLists' in w).length)
  const jobState = async scope => scope.evaluate(el => el.querySelector('[data-job-state]')?.dataset.jobState ?? null)
  const jobWrites = () => page.evaluate(() => window.__writes.filter(w => 'siteExportJob' in w).length)

  /** A pointer press, as a person makes one: the stepper's buttons answer the pointer, not a click event. */
  async function point(handle) {
    await handle.evaluate(el => el.scrollIntoView({ block: 'center' }))
    await handle.click()
  }

  /** The control is off, and says why in its tooltip, after its own label, and in what describes it. */
  async function saysOff(control, label, reason) {
    assert.equal(await control.evaluate(el => el.disabled), true, `${label} should be off`)
    assert.equal(await control.evaluate(el => el.title), `${label} — ${reason}`)
    assert.equal(await options.description(control), `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`)
  }

  /** The control is on, with no reason to give. */
  async function saysOn(control, label) {
    assert.equal(await control.evaluate(el => el.disabled), false, `${label} should be on`)
    assert.equal(await control.evaluate(el => el.getAttribute('aria-describedby')), null)
  }

  test('the switch, then Reviewed through, Works per review and This review', async () => {
    const row = await options.row(ROW)
    assert.ok(await options.control(row, 'switch'))
    assert.deepEqual(await row.$$eval('[data-review-cell]', els => els.map(el => el.dataset.reviewCell)), ['reviewed-through', 'works-per-review', 'this-review'])

    const review = await options.text(await cell('this-review'))
    // Gathered when the seed was made, before the build this run may have waited for.
    assert.match(review, /This review\s*2 works\s*gathered \d+ minutes ago · 0 cached/)
    const start = await inCell('this-review', 'link', 'Start the review: 2 works')
    assert.equal(await start.evaluate(a => a.getAttribute('href')), REVIEW_OPEN)
    assert.equal(await options.text(start), 'Start Review')
    await saysOn(await inCell('this-review', 'button', 'Cache works'), 'Cache works')
    await saysOn(await inCell('this-review', 'button', 'Download Offline Copy'), 'Download Offline Copy')
  })

  test('the review\'s window is This review, not a row of its own under Saved lists', async () => {
    assert.deepEqual((await options.savedListIds()).filter(id => id.startsWith('copy:')), [copyRow(OTHER)])
  })

  test('Reviewed through: Change… opens a date, and Save writes it, at most yesterday', async () => {
    assert.match(await options.text(await cell('reviewed-through')), new RegExp(`Reviewed through\\s*${formatDay(TODAY - 9)}\\s*Change…`))

    const setDate = async (value) => {
      await options.press(await inCell('reviewed-through', 'button', 'Change…'))
      const field = await (await cell('reviewed-through')).$('input[type="date"][aria-label="Last day marked reviewed"]')
      await until('the date field to take focus', () => field.evaluate(el => document.activeElement === el))
      await field.evaluate((el, v) => {
        el.value = v
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }, value)
      await options.press(await inCell('reviewed-through', 'button', 'Save'))
    }

    await setDate(isoDay(TODAY - 20))
    await until('the day to be written', async () => (await written())?.reviewedThrough === TODAY - 20)
    assert.match(await options.text(await cell('reviewed-through')), new RegExp(`Reviewed through\\s*${formatDay(TODAY - 20)}\\s*Change…`))
    const change = await inCell('reviewed-through', 'button', 'Change…')
    await until('focus to go back to Change…', () => change.evaluate(el => document.activeElement === el))

    await setDate(isoDay(TODAY + 3))
    await until('the latest day to be written', async () => (await written())?.reviewedThrough === TODAY - 1)

    // Cancel writes nothing: the next write is the only one after it.
    const before = await trackedWrites()
    await options.press(await inCell('reviewed-through', 'button', 'Change…'))
    await options.press(await inCell('reviewed-through', 'button', 'Cancel'))
    assert.match(await options.text(await cell('reviewed-through')), new RegExp(`Reviewed through\\s*${formatDay(TODAY - 1)}\\s*Change…`))
    await setDate('')
    await until('the watermark to be cleared', async () => (await written())?.reviewedThrough === 0)
    assert.equal(await trackedWrites(), before + 1)
    assert.match(await options.text(await cell('reviewed-through')), /Reviewed through\s*Nothing reviewed yet\s*Change…/)
  })

  test('Works per review: the stepper steps by one, and a typed number is clamped as the field is left', async () => {
    const field = await inCell('works-per-review', 'spinbutton', 'Works per review')
    const value = () => field.evaluate(el => el.value)
    assert.equal(await value(), '40')

    await point(await inCell('works-per-review', 'button', 'More works per review'))
    await until('one more to be written', async () => (await written())?.target === 41)
    await field.focus()
    await field.press('ArrowDown')
    await until('one fewer to be written', async () => (await written())?.target === 40)

    await field.click({ clickCount: 3 })
    await field.type('900')
    await field.evaluate(el => el.blur())
    await until('the most to be written', async () => (await written())?.target === WORKS_PER_REVIEW.max)
    await until('the field to show it', async () => await value() === '500')
    const more = await inCell('works-per-review', 'button', 'More works per review')
    assert.equal(await more.evaluate(el => el.disabled), true)
    assert.equal(await more.evaluate(el => el.title), 'More works per review — off at 500, the most it can be')

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
    const fewer = await inCell('works-per-review', 'button', 'Fewer works per review')
    assert.equal(await fewer.evaluate(el => el.disabled), true)
    assert.equal(await fewer.evaluate(el => el.title), 'Fewer works per review — off at 10, the least it can be')
  })

  test('with Tracked lists off, the review\'s settings and Start Review are off and say why; its offline copy isn\'t', async () => {
    await options.press(await options.control(await options.row(ROW), 'switch'))
    await until('the switch to be written', async () => (await written())?.enabled === false)

    await saysOff(await inCell('reviewed-through', 'button', 'Change…'), 'Change the last day reviewed', TRACK_OFF.review)
    await saysOff(await inCell('works-per-review', 'spinbutton', 'Works per review'), 'Works per review', TRACK_OFF.review)
    await saysOff(await inCell('this-review', 'button', 'Start Review'), 'Start the review: 2 works', TRACK_OFF.review)
    assert.deepEqual(await options.controls(await cell('this-review'), 'link'), [], 'Start Review links nowhere')
    await saysOn(await inCell('this-review', 'button', 'Cache works'), 'Cache works')
    await saysOn(await inCell('this-review', 'button', 'Download Offline Copy'), 'Download Offline Copy')

    // The lists themselves are under Saved lists, and keep their titles and
    // links; only tracking waits for the switch.
    const coffee = await options.savedList('c0ffee')
    const toggle = await options.control(coffee, 'switch', 'Track Coffee shop AUs')
    assert.equal(await toggle.evaluate(el => el.disabled), true)
    assert.equal(await options.description(toggle), `${TRACK_OFF.review.charAt(0).toUpperCase()}${TRACK_OFF.review.slice(1)}.`)
    assert.ok(await options.control(coffee, 'link', 'View or edit Coffee shop AUs on AO3'))

    await options.press(await options.control(await options.row(ROW), 'switch'))
    await until('the switch to be written', async () => (await written())?.enabled === true)
    await until('Start Review to link again', async () => (await options.controls(await cell('this-review'), 'link', 'Start the review: 2 works')).length === 1)
    await saysOn(await inCell('reviewed-through', 'button', 'Change…'), 'Change…')
    await saysOn(await options.control(await options.savedList('c0ffee'), 'switch', 'Track Coffee shop AUs'), 'Track Coffee shop AUs')
  })

  test('Cache works runs a job on the window, its line in the cell, with Stop, then Continue or Discard', async () => {
    await options.press(await inCell('this-review', 'button', 'Cache works'))
    await until('the job to be running', async () => await jobState(await cell('this-review')) === 'running')
    assert.equal(await (await cell('this-review')).evaluate(el => el.querySelector('[role="progressbar"]')?.getAttribute('aria-label')), 'Caching this review')
    await saysOff(await options.control(await options.savedListDetails(copyRow(OTHER)), 'button', 'Cache works'), 'Cache this list\'s works', REVIEW_JOB)
    assert.deepEqual(await options.controls(await cell('this-review'), 'button', 'Cache works'), [], 'Stop takes the actions\' place')

    const before = await jobWrites()
    await options.press(await inCell('this-review', 'button', 'Stop'))
    await until('the stopped job to be written', async () => await jobWrites() > before && await jobState(await cell('this-review')) === 'stopped')
    const job = await options.lastWrite('siteExportJob')
    assert.equal(job.cacheKey, WINDOW)
    assert.deepEqual(job.steps, ['caching'])

    await inCell('this-review', 'button', 'Continue')
    await options.press(await inCell('this-review', 'button', 'Discard'))
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
    await until('the cell to drop its line', async () => await jobState(await cell('this-review')) === null)
    await saysOn(await inCell('this-review', 'button', 'Cache works'), 'Cache works')
  })

  test('Download Offline Copy caches the window\'s works, then exports them', async () => {
    await options.press(await inCell('this-review', 'button', 'Download Offline Copy'))
    await until('the job to be running', async () => await jobState(await cell('this-review')) === 'running')
    const before = await jobWrites()
    await options.press(await inCell('this-review', 'button', 'Stop'))
    await until('the stopped job to be written', async () => await jobWrites() > before && await jobState(await cell('this-review')) === 'stopped')
    const job = await options.lastWrite('siteExportJob')
    assert.equal(job.cacheKey, WINDOW)
    assert.deepEqual(job.steps, ['caching', 'exporting'], 'there is no listing behind the window to refresh')

    await options.press(await inCell('this-review', 'button', 'Discard'))
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
  })

  test('another list\'s job turns This review\'s offline actions off, naming the list; Start Review stays', async () => {
    const other = await options.savedListDetails(copyRow(OTHER))
    await options.press(await options.control(other, 'button', 'Cache works'))
    await until('the job to be running', async () => await jobState(await options.savedList(copyRow(OTHER))) === 'running')

    await saysOff(await inCell('this-review', 'button', 'Cache works'), 'Cache this list\'s works', OTHER_JOB)
    await saysOff(await inCell('this-review', 'button', 'Download Offline Copy'), 'Cache this list\'s works, then save it as one HTML file', OTHER_JOB)
    assert.match(await options.text(await cell('this-review')), /Off for now: one job at a time, and Tag: Coffee Shop AU is caching\./)
    assert.ok(await inCell('this-review', 'link', 'Start the review: 2 works'))

    await options.press(await options.control(await options.savedList(copyRow(OTHER)), 'button', 'Stop caching Tag: Coffee Shop AU'))
    await until('the job to stop', async () => await jobState(await options.savedList(copyRow(OTHER))) === 'stopped')
    await options.press(await options.control(await options.savedList(copyRow(OTHER)), 'button', 'Discard'))
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
    await saysOn(await inCell('this-review', 'button', 'Cache works'), 'Cache works')
  })

  test('a job on the window runs to the end, and the cell counts what it cached', async () => {
    release()
    await options.press(await inCell('this-review', 'button', 'Cache works'))
    await until('the job to finish', async () => await jobState(await cell('this-review')) === 'finished')
    const index = await options.stored('workTextIndex')
    assert.ok(index['61']?.size > 0 && index['62']?.size > 0, 'both of the window\'s works were fetched')
    await until('the cell to count them', async () => / · 2 cached/.test(await options.text(await cell('this-review'))))
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})

/**
 * Start Review opens a review that is there to open: one that has been
 * gathered, from lists that are tracked. Before then the cell says how one
 * comes about, and the button why it is off.
 */
describe('options UI — This review with nothing to start', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  /** Start Review is off, and says why in its tooltip and in what describes it. */
  async function startIsOff(options, label, reason) {
    const review = await options.page.$('[data-review-cell="this-review"]')
    const start = await options.control(review, 'button', 'Start Review')
    assert.equal(await start.evaluate(el => el.disabled), true)
    assert.equal(await start.evaluate(el => el.title), `${label} — ${reason}`)
    assert.equal(await options.description(start), `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`)
    return review
  }

  test('before the first review is gathered, the cell says how one is, and has nothing to cache', async () => {
    const options = await session.open({ seed: listsSeed(), hash: '#review' })
    const review = await startIsOff(options, 'Start the review', START_OFF.noWindow)
    assert.match(await options.text(review), /Nothing gathered yet: your first review is gathered when you open Tracked on your readings page on AO3\./)
    assert.deepEqual(await options.controls(review, 'button', 'Cache works'), [])
    assert.deepEqual(await options.controls(review, 'button', 'Download Offline Copy'), [])
    assert.deepEqual(options.problems(), [])
    await options.close()
  })

  test('with no list tracked, there is nothing to review, though the window is still there to cache', async () => {
    const options = await session.open({ seed: { ...listsSeed({ lists: [] }), ...storedLists({ [WINDOW]: WINDOW_COPY }) }, hash: '#review' })
    const review = await startIsOff(options, 'Start the review: 2 works', START_OFF.noneTracked)
    assert.equal(await (await options.control(review, 'button', 'Cache works')).evaluate(el => el.disabled), false)
    assert.deepEqual(options.problems(), [])
    await options.close()
  })
})
