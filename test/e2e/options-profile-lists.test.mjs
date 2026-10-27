import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { WAIT_WORDS } from '../../src/content_script/archiveFetch.ts'
import { loadingLine } from '../../src/content_script/searchView/listRefresh.ts'
import { REFRESH_REFUSED } from '../../src/content_script/siteExport/refreshRefusals.ts'
import { bucketBar, formatBytes } from '../../src/options_ui/model/buckets.ts'
import { timeAgo } from '../../src/options_ui/model/moments.ts'
import { KEEP_BY_VIEW, PROFILE_LISTS, REFRESH_OFF } from '../../src/options_ui/model/profileLists.ts'
import { blurbsOnRemove } from '../../src/options_ui/model/savedListRows.ts'
import { storedListIds, storedLists } from './helpers.mjs'
import { ARCHIVE, captureDownloads, mentions, skip, startOptions, stubArchive, until } from './optionsPage.mjs'

const MARKED = 'marked-for-later:tester'
const READ = 'read-works:tester'
/** Profile lists that aren't the reader's own tiles: one no visit has described, and another account's. */
const OLD_MARKED = 'marked-for-later:olduser'
const THEIR_READ = 'read-works:someone'
/** A list of another kind, whose controls a profile list's job turns off, and what it is called. */
const OTHER = 'tag-works:Coffee%20Shop%20AU'
const OTHER_NAME = 'Coffee Shop AU'
/** The rows under Saved lists of the stored lists no saved list is at. */
const copyRow = key => `copy:${key}`
const HOURS_AGO = Date.now() - 3 * 60 * 60 * 1000
const MARKED_PAGE = `${ARCHIVE}/users/tester/readings?show=to-read`
const READ_PAGE = `${ARCHIVE}/users/tester/readings`

/** A profile list's own wording, by id: the page is checked for which of it the tile shows, not for how it reads. */
const list = id => PROFILE_LISTS.find(entry => entry.id === id)
/** How long ago the seed's copies were read, as the tiles say it. */
const AGO = () => timeAgo(HOURS_AGO, Date.now())

const blurb = id => `<li class="work blurb group" id="work_${id}" role="article">
  <div class="header module"><h4 class="heading"><a href="/works/${id}">Work ${id}</a>
    by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4></div>
  <dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd></dl>
</li>`

/** The reader's Marked for Later listing, one page long: signed in, unless told otherwise. */
const listingPage = (ids, { signedIn = true } = {}) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Marked for Later</title></head>
<body${signedIn ? ' class="logged-in"' : ''}>
  <div id="main" class="reading-index region">
    <ul class="navigation actions"></ul>
    <ol class="reading work index group">${ids.map(blurb).join('')}</ol>
  </div>
</body></html>`

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

const described = (sourceId, label, listUrl) => ({ sourceId, label, listUrl })

/**
 * The reader is `tester`, with Work marks on, which their read works are made
 * from. Their Marked for Later holds three works, one of which failed to
 * fetch; their read works two, one of them cached. An older Marked for Later
 * that no visit described, another account's read works, and a tag's works are
 * stored too.
 */
const SEED = {
  'option.user': { userId: 'tester' },
  'option.workMarks': { enabled: true },
  ...storedLists({
    [MARKED]: { scrapedAt: HOURS_AGO, blurbsHtml: [blurb(11), blurb(12), blurb(13)], descriptor: described('marked-for-later', 'Marked for Later — tester', MARKED_PAGE) },
    [READ]: { scrapedAt: HOURS_AGO, blurbsHtml: [blurb(21), blurb(22)], descriptor: described('read-works', 'Read works — tester', READ_PAGE) },
    [OLD_MARKED]: { scrapedAt: HOURS_AGO, blurbsHtml: [blurb(31)] },
    [THEIR_READ]: { scrapedAt: HOURS_AGO, blurbsHtml: [blurb(41)], descriptor: described('read-works', 'Read works — someone', `${ARCHIVE}/users/someone/readings`) },
    [OTHER]: { scrapedAt: HOURS_AGO, blurbsHtml: [blurb(51)], descriptor: described('tag-works', 'Coffee Shop AU', `${ARCHIVE}/tags/Coffee%20Shop%20AU/works`) },
  }),
  'workTextIndex': {
    12: { size: 0, updatedAt: 0, chapters: 0, words: 0, fetchedAt: 0, v: 1, failure: 'notfound', attempts: 1, attemptedAt: HOURS_AGO },
    21: { size: 2048, updatedAt: 0, chapters: 1, words: 1000, fetchedAt: HOURS_AGO, v: 1 },
  },
}

/**
 * The control is off, and says why in its tooltip and in what describes it:
 * `reason`, or a reason that names it.
 */
async function saysOff(options, control, reason) {
  assert.equal(await control.evaluate(el => el.disabled), true, `${await control.evaluate(el => el.dataset.action)} should be off`)
  assert.ok(mentions(await control.evaluate(el => el.title), reason), `the tooltip should give ${reason}`)
  assert.ok(mentions(await options.description(control), reason), `the description should give ${reason}`)
}

/** The control is on, with no reason to give. */
async function saysOn(control) {
  assert.equal(await control.evaluate(el => el.disabled), false, `${await control.evaluate(el => el.dataset.action)} should be on`)
  assert.equal(await control.evaluate(el => el.getAttribute('aria-describedby')), null)
}

/** The figures under the tile's bar: what is cached and its size, and what isn't, the failures among it. */
async function figures(options, id) {
  const [cached, size, uncached, failed] = await Promise.all(['cached', 'size', 'uncached', 'failed'].map(part => options.tileFigure(id, part)))
  return { cached, size, uncached, failed }
}

/** The state of the job line in `scope`, or null with none there. */
const jobState = scope => scope.evaluate(el => el.querySelector('[data-job-state]')?.dataset.jobState ?? null)

/** Switch Work marks, under Reading, and come back to the tiles. */
async function switchWorkMarks(options, enabled) {
  await options.goTo('#marks-status')
  await options.press(await options.control(await options.row('marks-status-work-marks'), 'switch'))
  await until(`Work marks to be written ${enabled ? 'on' : 'off'}`, async () => (await options.lastWrite('option.workMarks'))?.enabled === enabled)
  await options.goTo('#user-profile-lists')
}

/**
 * Lists → User profile lists: the reader's own Marked for Later and read works,
 * as two tiles, each with its offline copy's figures and the copy's jobs.
 *
 * The stand-in for AO3 holds every request until the last job test lets them
 * go, so a job is caught running for as long as a test needs it to be.
 */
describe('options UI — User profile lists', { skip }, () => {
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
      seed: SEED,
      hash: '#user-profile-lists',
      viewport: { width: 1440, height: 900 },
      prepare: async (p) => {
        await stubArchive(p, async (url) => {
          await held
          const path = new URL(url).pathname
          const workId = /^\/works\/(\d+)$/.exec(path)?.[1]
          if (workId)
            return workId === '14' ? { status: 404 } : { body: workPage(workId) }
          // The list as a refresh finds it: work 12 gone, and work 14, which
          // won't fetch, added.
          if (path === '/users/tester/readings')
            return { body: listingPage([11, 13, 14]) }
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

  const tile = id => options.tile(id)
  const inTile = async (id, action) => options.action(await tile(id), action)
  /** The tile's one link: View on AO3. */
  const viewLink = async id => options.control(await tile(id), 'link')
  const jobWrites = () => page.evaluate(() => window.__writes.filter(w => 'siteExportJob' in w).length)

  /** Open a tile's More menu. */
  const openMore = async id => options.openMenu(await inTile(id, 'more'))

  test('the reader\'s own Marked for Later and read works are tiles, named without an account', async () => {
    assert.deepEqual(await page.$$eval('[data-tile]', els => els.map(el => el.dataset.tile)), ['marked-for-later', 'read-works'])

    const marked = await tile('marked-for-later')
    assert.equal(await marked.evaluate(el => el.id), 'user-profile-lists-marked-for-later')
    assert.equal(await marked.evaluate(el => el.getAttribute('aria-label')), list('marked-for-later').name)
    const text = await options.text(marked)
    assert.ok(mentions(text, list('marked-for-later').name) && mentions(text, list('marked-for-later').note), text)
    assert.doesNotMatch(text, /tester/)
    assert.ok(await marked.$('[data-badge="needs-login"]'), 'it is fetched only while the reader is signed in')

    const read = await tile('read-works')
    assert.equal(await read.evaluate(el => el.id), 'user-profile-lists-read-works')
    const readText = await options.text(read)
    assert.ok(mentions(readText, list('read-works').name) && mentions(readText, list('read-works').note), readText)
    assert.ok(await read.$('[data-badge="needs-login"]'))
  })

  test('each tile counts its works, says how old its copy is, and draws what is cached of it', async () => {
    await until('the tiles to read their copies', async () => await options.tileFigure('marked-for-later', 'count') === '3')
    const marked = await tile('marked-for-later')
    assert.ok(mentions(await options.tileFigure('marked-for-later', 'detail'), AGO()))
    assert.deepEqual(await figures(options, 'marked-for-later'), { cached: '0', size: formatBytes(0), uncached: '3', failed: '1' })
    const bar = await marked.$('[role="img"]')
    const markedBar = bucketBar({ total: 3, cached: 0, failed: 1, unfetched: 2 })
    assert.equal(await bar.evaluate(el => el.getAttribute('aria-label')), markedBar.label)
    assert.equal(await bar.evaluate(el => el.title), markedBar.tip)

    const read = await tile('read-works')
    assert.equal(await options.tileFigure('read-works', 'count'), '2')
    assert.ok(mentions(await options.tileFigure('read-works', 'detail'), AGO()))
    assert.deepEqual(await figures(options, 'read-works'), { cached: '1', size: formatBytes(2048), uncached: '1', failed: null })
    assert.equal(await (await read.$('[role="img"]')).evaluate(el => el.getAttribute('aria-label')), bucketBar({ total: 2, cached: 1, failed: 0, unfetched: 1 }).label)
  })

  test('View on AO3 opens the list by its open URL, on the reader\'s own page, in a new tab', async () => {
    const link = await viewLink('marked-for-later')
    assert.equal(await link.evaluate(a => a.getAttribute('href')), `${MARKED_PAGE}#ao3e-open=marked-for-later`)
    assert.equal(await link.evaluate(a => a.target), '_blank')
    assert.equal(await (await viewLink('read-works')).evaluate(a => a.getAttribute('href')), `${READ_PAGE}#ao3e-open=read-works`)
  })

  test('another account\'s copy, and one no visit has described, stay rows under Saved lists', async () => {
    assert.deepEqual((await options.savedListIds()).sort(), [OLD_MARKED, OTHER, THEIR_READ].map(copyRow).sort())
  })

  test('Refresh list starts a job on the tile: its line there, Pause and Cancel in its actions\' place, and every other list saying why its own are off', async () => {
    await options.press(await inTile('marked-for-later', 'refresh'))
    await until('the job to be fetching the list', async () => await jobState(await tile('marked-for-later')) === 'running'
      && mentions(await options.text(await tile('marked-for-later')), loadingLine(0, 0)))

    const job = await options.lastWrite('siteExportJob')
    assert.equal(job.cacheKey, MARKED)
    assert.deepEqual(job.steps, ['refreshing'])

    const marked = await tile('marked-for-later')
    assert.equal(await marked.evaluate(el => el.querySelector('[role="progressbar"]')?.getAttribute('aria-label') ?? null), null, 'no count yet, so no bar')
    assert.deepEqual(await options.actions(marked, 'refresh'), [], 'Pause and Cancel take the actions\' place')
    assert.equal(await marked.$('[role="img"]'), null, 'the job\'s line stands in for the copy\'s bar')
    await inTile('marked-for-later', 'pause')

    const holder = list('marked-for-later').name
    await saysOff(options, await inTile('read-works', 'refresh'), holder)
    await saysOff(options, await inTile('read-works', 'cache'), holder)
    await saysOff(options, await inTile('read-works', 'download'), holder)
    assert.ok(mentions(await options.text(await tile('read-works')), holder), 'the tile says which list has the job')
    await saysOff(options, await options.action(await options.savedListDetails(copyRow(OTHER)), 'cache'), holder)

    const before = await jobWrites()
    await options.press(await inTile('marked-for-later', 'pause'))
    await until('the stopped job to be written', async () => await jobWrites() > before && await jobState(await tile('marked-for-later')) === 'stopped')
    assert.deepEqual((await options.lastWrite('siteExportJob')).steps, ['refreshing'])
    await inTile('marked-for-later', 'resume')
    await saysOn(await inTile('read-works', 'cache'))

    await options.press(await inTile('marked-for-later', 'discard'))
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
    await until('the tile to drop its line', async () => await jobState(await tile('marked-for-later')) === null)
    await saysOn(await inTile('marked-for-later', 'refresh'))
  })

  test('Cancel stops the job and throws it away, with nothing left to continue', async () => {
    await options.press(await inTile('marked-for-later', 'refresh'))
    await until('the job to be running', async () => await jobState(await tile('marked-for-later')) === 'running')
    await options.press(await inTile('marked-for-later', 'cancel'))
    await until('the job to be gone', async () => await options.stored('siteExportJob') === null)
    await until('the tile to drop its line', async () => await jobState(await tile('marked-for-later')) === null)
    assert.deepEqual(await options.actions(await tile('marked-for-later'), 'resume'), [])
    await saysOn(await inTile('marked-for-later', 'refresh'))
  })

  test('More: the list refreshed first, a retry while any work has failed, and a download without refreshing once any is cached', async () => {
    await openMore('marked-for-later')
    assert.deepEqual(await options.menuActions(), ['refresh-first', 'retry', 'remove'])
    assert.match(await options.name(await options.menuItem('retry')), /\b1\b/, 'the retry counts the work that failed')
    await options.closeMenu()

    await openMore('read-works')
    assert.deepEqual(await options.menuActions(), ['refresh-first', 'download-cached', 'remove'])
    await options.closeMenu()

    await openMore('marked-for-later')
    await options.press(await options.menuItem('retry'))
    await until('the job to be running', async () => await jobState(await tile('marked-for-later')) === 'running')
    const job = await options.lastWrite('siteExportJob')
    assert.equal(job.cacheKey, MARKED)
    assert.deepEqual(job.steps, ['caching'])
    assert.equal(job.retryNow, true)

    const before = await jobWrites()
    await options.press(await inTile('marked-for-later', 'pause'))
    await until('the stopped job to be written', async () => await jobWrites() > before && await jobState(await tile('marked-for-later')) === 'stopped')
    await options.press(await inTile('marked-for-later', 'discard'))
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
  })

  test('another list\'s job turns More\'s fetching off, saying why, and leaves Remove on', async () => {
    await options.press(await options.action(await options.savedListDetails(copyRow(OTHER)), 'cache'))
    await until('the job to be running', async () => await jobState(await options.savedList(copyRow(OTHER))) === 'running')

    await openMore('read-works')
    for (const action of ['refresh-first', 'download-cached']) {
      const item = await options.menuItem(action)
      assert.equal(await item.evaluate(el => el.hasAttribute('data-disabled')), true, `${action} should be off`)
      assert.ok(mentions(await item.evaluate(el => el.title), OTHER_NAME), `${action}'s tooltip should name the list with the job`)
      assert.ok(mentions(await options.description(item), OTHER_NAME), `${action}'s description should name the list with the job`)
    }
    assert.equal(await (await options.menuItem('remove')).evaluate(el => el.hasAttribute('data-disabled')), false)
    await options.closeMenu()

    await options.press(await options.action(await options.savedList(copyRow(OTHER)), 'pause'))
    await until('the job to stop', async () => await jobState(await options.savedList(copyRow(OTHER))) === 'stopped')
    await options.press(await options.action(await options.savedList(copyRow(OTHER)), 'discard'))
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
  })

  test('Remove offline copy asks a second time in its place, and the tile then says how a copy is kept', async () => {
    await openMore('read-works')
    const item = await options.menuItem('remove')
    assert.ok(mentions(await options.name(item), blurbsOnRemove(false)), 'it says what becomes of the blurbs')
    await options.press(item)
    await until('the first press to arm it', () => item.evaluate(el => el.hasAttribute('data-armed')))
    const armed = await options.menuItem('remove')
    assert.ok(await armed.evaluate(el => el.hasAttribute('data-armed')), 'and the menu stays open')
    assert.ok(READ in await options.stored('cache.searchLists'), 'arming removes nothing')

    await options.press(armed)
    await until('the copy to go', async () => !(READ in await options.stored('cache.searchLists')))
    await until('the menu to close', async () => (await options.controls(page, 'menuitem')).length === 0)

    const read = await tile('read-works')
    await until('the tile to say how a copy is kept', async () => mentions(await options.text(await tile('read-works')), KEEP_BY_VIEW))
    assert.equal(await read.$('[role="img"]'), null)
    assert.deepEqual(await options.actions(await tile('read-works'), 'refresh'), [])
    assert.equal(await (await viewLink('read-works')).evaluate(a => a.getAttribute('href')), `${READ_PAGE}#ao3e-open=read-works`, 'its open URL on the reader\'s own page, from their account')
    assert.ok(THEIR_READ in await options.stored('cache.searchLists'), 'another account\'s copy is no tile, and stays')
  })

  test('Download Offline Copy runs to the end: finished, with its warning and its failure, and the actions back', async () => {
    release()
    await options.press(await inTile('marked-for-later', 'download'))
    await until('the job to finish', async () => await jobState(await tile('marked-for-later')) === 'finished', 40000)
    await until('the file to be handed over', () => page.evaluate(() => window.__downloads.length === 1))

    const marked = await tile('marked-for-later')
    const warning = await marked.$('[data-callout="warning"]')
    assert.ok(warning, 'the warning is a callout')
    assert.deepEqual((await options.text(warning)).match(/\d+/g)?.slice(0, 2), ['1', '3'], 'it says how many of the works have no saved text')
    assert.match(await options.name(await options.action(marked, 'failures')), /\b1\b/, 'one work could not be fetched')
    await saysOn(await inTile('marked-for-later', 'refresh'))
    await until('the tile to count what was cached', async () => await options.tileFigure('marked-for-later', 'cached') === '2')
  })

  test('nothing threw along the way, and no Pause was logged as an error', () => {
    // Chrome logs every non-2xx response as a console error of its own, and
    // a work AO3 no longer has is the subject of a test.
    assert.deepEqual(options.problems(/status of 404/), [])
  })
})

/**
 * What AO3 can say to a tile's job that stops or holds it: a signed-out page
 * for a list only the reader's own account sees, and a refusal to be sat out.
 * A page of its own, since a refusal holds every request the page makes until
 * it is over.
 */
describe('options UI — User profile lists, when AO3 says no', { skip }, () => {
  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({
      seed: SEED,
      hash: '#user-profile-lists',
      viewport: { width: 1440, height: 900 },
      prepare: p => stubArchive(p, (url) => {
        const path = new URL(url).pathname
        if (/^\/works\/\d+$/.test(path))
          return { status: 429, headers: { 'retry-after': '120' } }
        return { body: listingPage([11, 13], { signedIn: false }) }
      }),
    })
  }, { timeout: 180000 })

  after(() => session?.close())

  const tile = () => options.tile('marked-for-later')
  const inTile = async action => options.action(await tile(), action)

  test('a refresh AO3 serves signed out stops, saying so in a callout, and offers Continue or Discard', async () => {
    await until('the tile to read its copy', async () => (await options.actions(await tile(), 'refresh')).length === 1)
    await options.press(await inTile('refresh'))
    await until('the job to stop', async () => await jobState(await tile()) === 'stopped')

    const callout = await (await tile()).$('[data-callout="destructive"]')
    assert.ok(callout, 'the reason is an error callout')
    assert.ok(mentions(await options.text(callout), REFRESH_REFUSED.loggedOut), 'it says AO3 served the signed-out view')
    await inTile('resume')
    await options.press(await inTile('discard'))
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
  })

  test('a refusal is sat out in the warning colour, counting down, until the job is stopped', async () => {
    await until('the actions to be back', async () => (await options.actions(await tile(), 'cache')).length === 1)
    await options.press(await inTile('cache'))
    await until('the tile to sit out the refusal', async () => (await tile()).evaluate(el => !!el.querySelector('[data-job-state="waiting"][data-job-wait="refused"]')))

    const marked = await tile()
    const line = await options.text(marked)
    assert.ok(mentions(line, WAIT_WORDS.refused), line)
    assert.match(line, /\d+:\d\d/, 'counting down')
    assert.match(await marked.evaluate(el => getComputedStyle(el.querySelector('[role="progressbar"] > div')).backgroundImage), /repeating-linear-gradient/, 'a striped bar')

    await options.press(await inTile('pause'))
    await until('the job to stop', async () => await jobState(await tile()) === 'stopped')
    const job = await options.lastWrite('siteExportJob')
    assert.equal(job.cacheKey, MARKED)
    assert.deepEqual(job.steps, ['caching'])
  })

  test('the signed-out refresh is logged as the error it is, and the Pause isn\'t', () => {
    // The refusals the stub serves are the subject of a test.
    const problems = options.problems(/status of 429/)
    assert.equal(problems.length, 1, JSON.stringify(problems))
    assert.match(problems[0], /Site export job stopped/)
  })
})

/**
 * Read works is made from the reader's marks, so with Work marks off its open
 * URL opens nothing: the tile offers no View on AO3, and its note says what the
 * list needs. Work marks is switched on the same page, under Reading, and the
 * tile follows it there and then.
 */
describe('options UI — User profile lists, with Work marks off', { skip }, () => {
  const MARKS_OFF = {
    'option.user': { userId: 'tester' },
    ...storedLists({
      [MARKED]: { scrapedAt: HOURS_AGO, blurbsHtml: [blurb(11), blurb(12), blurb(13)], descriptor: described('marked-for-later', 'Marked for Later — tester', MARKED_PAGE) },
    }),
  }
  const NEEDS_MARKS = list('read-works').needs

  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({ seed: MARKS_OFF, hash: '#user-profile-lists', viewport: { width: 1440, height: 900 } })
  }, { timeout: 180000 })

  after(() => session?.close())

  const tile = id => options.tile(id)
  const readText = async () => options.text(await tile('read-works'))
  const readLinks = async () => options.controls(await tile('read-works'), 'link')

  test('Read works offers no View on AO3, and gives its note on needing marks; Marked for Later keeps its own', async () => {
    await until('the tiles to read their copies', async () => await options.tileFigure('marked-for-later', 'count') === '3')
    assert.ok(mentions(await readText(), NEEDS_MARKS))
    assert.deepEqual(await readLinks(), [])
    assert.equal(await (await options.control(await tile('marked-for-later'), 'link')).evaluate(a => a.getAttribute('href')), `${MARKED_PAGE}#ao3e-open=marked-for-later`)
  })

  test('Work marks switched on brings View on AO3 back, with the note on keeping a copy, and switched off takes them away, with no reload', async () => {
    await options.page.evaluate(() => {
      window.__notReloaded = true
    })

    await switchWorkMarks(options, true)
    await until('Read works to offer View on AO3', async () => (await readLinks()).length === 1)
    assert.equal(await (await options.control(await tile('read-works'), 'link')).evaluate(a => a.getAttribute('href')), `${READ_PAGE}#ao3e-open=read-works`)
    assert.ok(mentions(await readText(), KEEP_BY_VIEW))
    assert.ok(!mentions(await readText(), NEEDS_MARKS))

    await switchWorkMarks(options, false)
    await until('Read works to offer View on AO3 no more', async () => (await readLinks()).length === 0)
    assert.ok(mentions(await readText(), NEEDS_MARKS))

    assert.equal(await options.page.evaluate(() => window.__notReloaded), true, 'the same page throughout')
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})

/**
 * Read works is the works the reader's marks name, so with Work marks off a
 * refresh finds none of them and would store the list empty. While it is off,
 * each control that refreshes a kept copy is off and says why, on the tile and
 * on another account's row; what works from the copy as it is stays on. The
 * stand-in for AO3 serves the reader's History as a refresh would find it, so
 * a refresh that got through would show.
 */
describe('options UI — User profile lists, a Read works copy kept with Work marks off', { skip }, () => {
  const KEPT = {
    'option.user': { userId: 'tester' },
    ...storedLists({
      [READ]: { scrapedAt: HOURS_AGO, blurbsHtml: [blurb(21), blurb(22)], descriptor: described('read-works', 'Read works — tester', READ_PAGE) },
      [THEIR_READ]: { scrapedAt: HOURS_AGO, blurbsHtml: [blurb(41)], descriptor: described('read-works', 'Read works — someone', `${ARCHIVE}/users/someone/readings`) },
    }),
    'workTextIndex': { 21: { size: 2048, updatedAt: 0, chapters: 1, words: 1000, fetchedAt: HOURS_AGO, v: 1 } },
  }
  const REASON = REFRESH_OFF.workMarks

  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({
      seed: KEPT,
      hash: '#user-profile-lists',
      viewport: { width: 1440, height: 900 },
      prepare: p => stubArchive(p, (url) => {
        const path = new URL(url).pathname
        const workId = /^\/works\/(\d+)$/.exec(path)?.[1]
        if (workId)
          return { body: workPage(workId) }
        if (/^\/users\/[^/]+\/readings$/.test(path))
          return { body: listingPage([21, 22, 41]) }
        return { status: 404 }
      }),
    })
  }, { timeout: 180000 })

  after(() => session?.close())

  const tile = () => options.tile('read-works')
  const inTile = async action => options.action(await tile(), action)
  const theirRow = () => options.savedListDetails(copyRow(THEIR_READ))
  /** A control on their row: in its `actions`, beside it, or in its `details`. */
  const inRow = async (part, action) => options.action(await (await theirRow()).$(`[data-saved-list-part="${part}"]`), action)
  const openMore = async () => options.openMenu(await inTile('more'))

  /** More's item is off, and says why in its tooltip and in what describes it; or on, with nothing to say. */
  async function itemSays(action, reason) {
    const item = await options.menuItem(action)
    assert.equal(await item.evaluate(el => el.hasAttribute('data-disabled')), !!reason, `${action} should be ${reason ? 'off' : 'on'}`)
    if (reason) {
      assert.ok(mentions(await item.evaluate(el => el.title), reason), `${action}'s tooltip should give the reason`)
      assert.ok(mentions(await options.description(item), reason), `${action}'s description should give the reason`)
    }
  }

  /** The row's Refresh the list first, then cache: off, its tooltip and what describes it the reason; or on. */
  async function refreshFirstSays(reason) {
    const link = await inRow('details', 'refresh-first')
    assert.equal(await link.evaluate(el => el.disabled), !!reason)
    if (reason) {
      assert.ok(mentions(await link.evaluate(el => el.title), reason), 'its tooltip should give the reason')
      assert.ok(mentions(await options.description(link), reason), 'its description should give the reason')
    }
  }

  test('the tile: no View on AO3; Refresh list, Download Offline Copy and More\'s Refresh the list first off, saying why in the tile; Cache works and the rest on', async () => {
    await until('the tile to read its copy', async () => await options.tileFigure('read-works', 'count') === '2')
    assert.deepEqual(await options.controls(await tile(), 'link'), [])
    assert.ok(mentions(await options.text(await tile()), REASON), 'the reason is said in the tile')

    await saysOff(options, await inTile('refresh'), REASON)
    await saysOff(options, await inTile('download'), REASON)
    await saysOn(await inTile('cache'))

    await openMore()
    await itemSays('refresh-first', REASON)
    await itemSays('download-cached', null)
    await itemSays('remove', null)
    await options.closeMenu()
  })

  test('another account\'s row: Download, Refresh list and Refresh the list first, then cache off, saying why in its details; Cache works on', async () => {
    await saysOff(options, await inRow('actions', 'download'), REASON)
    await saysOff(options, await inRow('details', 'refresh'), REASON)
    await saysOff(options, await inRow('details', 'download'), REASON)
    await refreshFirstSays(REASON)
    await saysOn(await inRow('details', 'cache'))
    assert.ok(mentions(await options.text(await theirRow()), REASON), 'the reason is said in the details')
  })

  test('pressed anyway, they start nothing: the copies keep their works, and Cache works runs from them as they are', async () => {
    for (const action of ['refresh', 'download'])
      await options.press(await inTile(action))
    for (const [part, action] of [['actions', 'download'], ['details', 'refresh'], ['details', 'download'], ['details', 'refresh-first']])
      await options.press(await inRow(part, action))

    // One job at a time: once this one has run, any job a press had started has been written.
    await options.press(await inTile('cache'))
    await until('Cache works to finish', async () => await jobState(await tile()) === 'finished', 40000)

    const jobs = await options.page.evaluate(() => window.__writes.filter(w => 'siteExportJob' in w).map(w => w.siteExportJob))
    assert.deepEqual(jobs.filter(Boolean).map(job => job.cacheKey).filter((key, i, all) => all.indexOf(key) === i), [READ], 'only the one job ran')
    assert.ok(jobs.filter(Boolean).every(job => !job.steps.includes('refreshing')), 'no job refreshed anything')
    const lists = await options.stored('cache.searchLists')
    assert.deepEqual(storedListIds(lists[READ]), ['21', '22'])
    assert.deepEqual(storedListIds(lists[THEIR_READ]), ['41'])
    assert.ok((await options.stored('workTextIndex'))['22']?.size > 0, 'the uncached work was cached')
  })

  test('Work marks switched on turns them on, and brings View on AO3 back, with no reload; switched off turns them off again', async () => {
    await options.page.evaluate(() => {
      window.__notReloaded = true
    })

    await switchWorkMarks(options, true)
    await until('Read works to offer View on AO3', async () => (await options.controls(await tile(), 'link')).length === 1)
    await saysOn(await inTile('refresh'))
    await saysOn(await inTile('download'))
    assert.ok(!mentions(await options.text(await tile()), REASON), 'nothing left to say')
    await openMore()
    await itemSays('refresh-first', null)
    await options.closeMenu()
    await saysOn(await inRow('actions', 'download'))
    await saysOn(await inRow('details', 'refresh'))
    await saysOn(await inRow('details', 'download'))
    await refreshFirstSays(null)

    await switchWorkMarks(options, false)
    await until('Read works to offer View on AO3 no more', async () => (await options.controls(await tile(), 'link')).length === 0)
    await saysOff(options, await inTile('refresh'), REASON)
    await saysOff(options, await inRow('details', 'refresh'), REASON)

    assert.equal(await options.page.evaluate(() => window.__notReloaded), true, 'the same page throughout')
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})

/**
 * A refresh of Read works stopped before it finished, continued with Work
 * marks off: the job itself refuses to store the list empty, whatever started
 * it, and says why.
 */
describe('options UI — User profile lists, a stopped Read works refresh continued with Work marks off', { skip }, () => {
  const STOPPED = {
    'option.user': { userId: 'tester' },
    ...storedLists({
      [READ]: { scrapedAt: HOURS_AGO, blurbsHtml: [blurb(21), blurb(22)], descriptor: described('read-works', 'Read works — tester', READ_PAGE) },
    }),
    'siteExportJob': {
      cacheKey: READ,
      descriptor: described('read-works', 'Read works — tester', READ_PAGE),
      steps: ['refreshing', 'caching'],
      queue: [],
      done: 0,
      total: 0,
      startedAt: HOURS_AGO,
      updatedAt: HOURS_AGO,
      errors: [],
      errorCount: 0,
    },
  }

  let session
  let options
  let archive

  before(async () => {
    session = await startOptions()
    options = await session.open({
      seed: STOPPED,
      hash: '#user-profile-lists',
      viewport: { width: 1440, height: 900 },
      prepare: async (p) => {
        archive = await stubArchive(p, (url) => {
          const path = new URL(url).pathname
          if (path === '/users/tester/readings')
            return { body: listingPage([21, 22]) }
          const workId = /^\/works\/(\d+)$/.exec(path)?.[1]
          return workId ? { body: workPage(workId) } : { status: 404 }
        })
      },
    })
  }, { timeout: 180000 })

  after(() => session?.close())

  const tile = () => options.tile('read-works')
  const jobWrites = () => options.page.evaluate(() => window.__writes.filter(w => 'siteExportJob' in w).length)

  test('Continue refuses to refresh it, saying why, and the stored copy keeps its works', async () => {
    await until('the tile to offer to continue the job', async () => (await options.actions(await tile(), 'resume')).length === 1)
    const before = await jobWrites()
    await options.press(await options.action(await tile(), 'resume'))
    await until('the job to stop again', async () => await jobWrites() > before && ['stopped', 'finished'].includes(await jobState(await tile())))

    assert.deepEqual(storedListIds((await options.stored('cache.searchLists'))[READ]), ['21', '22'])
    await archive.heard()
    assert.deepEqual(archive.asked, [], 'nothing was asked of AO3')

    const callout = await (await tile()).$('[data-callout="destructive"]')
    assert.ok(callout, 'the reason is an error callout')
    assert.ok(mentions(await options.text(callout), REFRESH_REFUSED.marksOff), 'it says the list needs Work marks')
    assert.deepEqual((await options.stored('siteExportJob')).steps, ['refreshing', 'caching'], 'the job waits to be continued')
    await options.action(await tile(), 'resume')
    await options.action(await tile(), 'discard')
  })

  test('the refusal is logged as the error it is', () => {
    const problems = options.problems()
    assert.equal(problems.length, 1, JSON.stringify(problems))
    assert.match(problems[0], /Site export job stopped/)
  })
})

/**
 * The tiles side by side where the pane has room for both, one over the other
 * on a phone, and never wider than the window. Only the tiles' own copies are
 * stored, so nothing else under Lists is measured.
 */
describe('options UI — User profile lists, laid out', { skip }, () => {
  const TILES_ONLY = {
    'option.user': { userId: 'tester' },
    ...storedLists({
      [MARKED]: { scrapedAt: HOURS_AGO, blurbsHtml: [blurb(11), blurb(12), blurb(13)], descriptor: described('marked-for-later', 'Marked for Later — tester', MARKED_PAGE) },
      [READ]: { scrapedAt: HOURS_AGO, blurbsHtml: [blurb(21), blurb(22)], descriptor: described('read-works', 'Read works — tester', READ_PAGE) },
    }),
  }

  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  for (const [width, sideBySide] of [[1440, true], [390, false]]) {
    test(`${width} px`, async () => {
      const options = await session.open({ seed: TILES_ONLY, hash: '#user-profile-lists', viewport: { width, height: 900 } })
      try {
        await until('the tiles to read their copies', async () => await options.tileFigure('read-works', 'count') === '2')
        const boxes = await options.page.$$eval('[data-tile]', els => els.map((el) => {
          const { top, bottom, left, right } = el.getBoundingClientRect()
          return { top: Math.round(top), bottom: Math.round(bottom), left: Math.round(left), right: Math.round(right) }
        }))
        const [marked, read] = boxes
        if (sideBySide) {
          assert.equal(marked.top, read.top, `side by side: ${JSON.stringify(boxes)}`)
          assert.ok(marked.right < read.left, `side by side: ${JSON.stringify(boxes)}`)
        }
        else {
          assert.ok(read.top > marked.bottom, `one over the other: ${JSON.stringify(boxes)}`)
          assert.equal(marked.left, read.left, `one over the other: ${JSON.stringify(boxes)}`)
        }
        const { scrollWidth, innerWidth } = await options.page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }))
        assert.ok(scrollWidth <= innerWidth, `the page is ${scrollWidth} px wide in a ${innerWidth} px window`)
        assert.deepEqual(options.problems(), [])
      }
      finally {
        await options.close()
      }
    })
  }

  test('the settings search finds a tile by its name or its note, as it finds a settings row', async () => {
    const options = await session.open({ seed: TILES_ONLY, hash: '#lists', viewport: { width: 1440, height: 900 } })
    try {
      const box = await options.page.$('[data-settings-search]')
      // A word of Marked for Later's note that Read works' name and note don't have.
      const theirs = `${list('read-works').name} ${list('read-works').note}`.toLowerCase()
      const word = list('marked-for-later').note.toLowerCase().split(/\W+/).find(w => w.length > 3 && !theirs.includes(w))
      assert.ok(word, 'Marked for Later\'s note has a word of its own')
      await box.type(word)
      const shown = async id => (await options.tile(id)).evaluate(el => el.checkVisibility())
      await until('the search to hide the tile it doesn\'t find', async () => !(await shown('read-works')))
      assert.equal(await shown('marked-for-later'), true)
      const marks = await (await options.tile('marked-for-later')).$$eval('mark', els => els.map(el => el.textContent.toLowerCase()))
      assert.ok(marks.length > 0 && marks.every(text => text === word), JSON.stringify(marks))
      assert.deepEqual(options.problems(), [])
    }
    finally {
      await options.close()
    }
  })
})
