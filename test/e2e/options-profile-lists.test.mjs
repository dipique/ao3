import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { blurbsOnRemove } from '../../src/options_ui/model/savedListRows.ts'
import { storedLists } from './helpers.mjs'
import { ARCHIVE, captureDownloads, skip, startOptions, stubArchive, until } from './optionsPage.mjs'

const MARKED = 'marked-for-later:tester'
const READ = 'read-works:tester'
/** Profile lists that aren't the reader's own tiles: one no visit has described, and another account's. */
const OLD_MARKED = 'marked-for-later:olduser'
const THEIR_READ = 'read-works:someone'
/** A list of another kind, whose controls a profile list's job turns off. */
const OTHER = 'tag-works:Coffee%20Shop%20AU'
/** The rows under Saved lists of the stored lists no saved list is at. */
const copyRow = key => `copy:${key}`
const HOURS_AGO = Date.now() - 3 * 60 * 60 * 1000
const MARKED_PAGE = `${ARCHIVE}/users/tester/readings?show=to-read`
const READ_PAGE = `${ARCHIVE}/users/tester/readings`

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
 * The reader is `tester`. Their Marked for Later holds three works, one of
 * which failed to fetch; their read works two, one of them cached. An older
 * Marked for Later that no visit described, another account's read works, and
 * a tag's works are stored too.
 */
const SEED = {
  'option.user': { userId: 'tester' },
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

/** The control is off, and says why in its tooltip, after its own label, and in what describes it. */
async function saysOff(options, control, label, reason) {
  assert.equal(await control.evaluate(el => el.disabled), true, `${label} should be off`)
  assert.equal(await control.evaluate(el => el.title), `${label} — ${reason}`)
  assert.equal(await options.description(control), `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`)
}

/** The control is on, with no reason to give. */
async function saysOn(control, label) {
  assert.equal(await control.evaluate(el => el.disabled), false, `${label} should be on`)
  assert.equal(await control.evaluate(el => el.getAttribute('aria-describedby')), null)
}

/** The state of the job line in `scope`, or null with none there. */
const jobState = scope => scope.evaluate(el => el.querySelector('[data-job-state]')?.dataset.jobState ?? null)

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
  const inTile = async (id, role, name) => options.control(await tile(id), role, name)
  const jobWrites = () => page.evaluate(() => window.__writes.filter(w => 'siteExportJob' in w).length)

  /** Open a tile's More menu from the keyboard, as a person would, and wait for its items. */
  async function openMore(id, name) {
    const more = await inTile(id, 'button', `More for ${name}`)
    await more.focus()
    await page.keyboard.press('Enter')
    await until('the menu to open', async () => (await options.controls(page, 'menuitem')).length > 0)
  }

  /** The open menu's items' names: what each is called, then what it does. */
  const menuItems = async () => Promise.all((await options.controls(page, 'menuitem')).map(item => options.name(item)))
  /** The open menu's item whose name begins with `start`. */
  const menuItem = start => options.control(page, 'menuitem', new RegExp(`^${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))

  /** The names begin, in order, with these. */
  function beginWith(names, expected) {
    assert.deepEqual(names.map((name, i) => (expected[i] && name.startsWith(expected[i]) ? expected[i] : name)), expected)
  }

  async function closeMenu() {
    await page.keyboard.press('Escape')
    await until('the menu to close', async () => (await options.controls(page, 'menuitem')).length === 0)
  }

  test('the reader\'s own Marked for Later and read works are tiles, named without an account', async () => {
    assert.deepEqual(await page.$$eval('[data-tile]', els => els.map(el => el.dataset.tile)), ['marked-for-later', 'read-works'])

    const marked = await tile('marked-for-later')
    assert.equal(await marked.evaluate(el => el.id), 'user-profile-lists-marked-for-later')
    assert.equal(await marked.evaluate(el => el.getAttribute('aria-label')), 'Marked for Later')
    const text = await options.text(marked)
    assert.match(text, /^Marked for Later Needs login Your own to-read page\. Not part of Review — it only changes when you add to it\./)
    assert.doesNotMatch(text, /tester/)
    assert.equal(await (await marked.$('[data-badge="needs-login"]')).evaluate(el => el.title), 'Only visible to your own account, so it is fetched only while you are signed in to AO3')

    const read = await tile('read-works')
    assert.equal(await read.evaluate(el => el.id), 'user-profile-lists-read-works')
    assert.match(await options.text(read), /^Read works Needs login Everything you’ve marked read or given a verdict, Favorites included: a shelf to come back to\. Not part of Review — it only changes when you mark something\./)
  })

  test('each tile counts its works, says how old its copy is, and draws what is cached of it', async () => {
    await until('the tiles to read their copies', async () => (await options.lines(await tile('marked-for-later'))).includes('3 works · as of 3 hours ago'))
    const marked = await tile('marked-for-later')
    const markedLines = await options.lines(marked)
    assert.ok(markedLines.includes('0 cached (0 B)'), JSON.stringify(markedLines))
    assert.ok(markedLines.includes('3 uncached · 1 failed'), JSON.stringify(markedLines))
    const bar = await marked.$('[role="img"]')
    assert.equal(await bar.evaluate(el => el.getAttribute('aria-label')), '0 of 3 works cached, 1 failed, 2 new')
    assert.equal(await bar.evaluate(el => el.title), 'cached: 0\nfailed: 1\nnew: 2\ntotal: 3')

    const read = await tile('read-works')
    const readLines = await options.lines(read)
    assert.ok(readLines.includes('2 works · as of 3 hours ago'), JSON.stringify(readLines))
    assert.ok(readLines.includes('1 cached (2.0 kB)'), JSON.stringify(readLines))
    assert.ok(readLines.includes('1 uncached'), JSON.stringify(readLines))
    assert.equal(await (await read.$('[role="img"]')).evaluate(el => el.getAttribute('aria-label')), '1 of 2 works cached, 0 failed, 1 new')
  })

  test('View on AO3 opens the list by its open URL, on the reader\'s own page, in a new tab', async () => {
    const link = await inTile('marked-for-later', 'link', 'View Marked for Later on AO3')
    assert.equal(await link.evaluate(a => a.getAttribute('href')), `${MARKED_PAGE}#ao3e-open=marked-for-later`)
    assert.equal(await link.evaluate(a => a.target), '_blank')
    assert.equal(await (await inTile('read-works', 'link', 'View Read works on AO3')).evaluate(a => a.getAttribute('href')), `${READ_PAGE}#ao3e-open=read-works`)
  })

  test('another account\'s copy, and one no visit has described, stay rows under Saved lists', async () => {
    assert.deepEqual((await options.savedListIds()).sort(), [OLD_MARKED, OTHER, THEIR_READ].map(copyRow).sort())
  })

  test('Refresh list starts a job on the tile: its line there, Stop in its actions\' place, and every other list saying why its own are off', async () => {
    await options.press(await inTile('marked-for-later', 'button', 'Refresh list'))
    await until('the job to be fetching the list', async () => await jobState(await tile('marked-for-later')) === 'running'
      && /Fetching the list…/.test(await options.text(await tile('marked-for-later'))))

    const job = await options.lastWrite('siteExportJob')
    assert.equal(job.cacheKey, MARKED)
    assert.deepEqual(job.steps, ['refreshing'])

    const marked = await tile('marked-for-later')
    assert.equal(await marked.evaluate(el => el.querySelector('[role="progressbar"]')?.getAttribute('aria-label') ?? null), null, 'no count yet, so no bar')
    assert.deepEqual(await options.controls(marked, 'button', 'Refresh list'), [], 'Stop takes the actions\' place')
    assert.equal(await marked.$('[role="img"]'), null, 'the job\'s line stands in for the copy\'s bar')
    await inTile('marked-for-later', 'button', 'Stop')

    const reason = 'off for now: one job at a time, and Marked for Later is refreshing'
    await saysOff(options, await inTile('read-works', 'button', 'Refresh list'), 'Refresh the list of works in Read works', reason)
    await saysOff(options, await inTile('read-works', 'button', 'Cache works'), 'Update the cached works', reason)
    await saysOff(options, await inTile('read-works', 'button', 'Download Offline Copy'), 'Refresh, cache, then save this list as one HTML file', reason)
    assert.match(await options.text(await tile('read-works')), /Off for now: one job at a time, and Marked for Later is refreshing\./)
    await saysOff(options, await options.control(await options.savedListDetails(copyRow(OTHER)), 'button', 'Cache works'), 'Cache this list\'s works', reason)

    const before = await jobWrites()
    await options.press(await inTile('marked-for-later', 'button', 'Stop'))
    await until('the stopped job to be written', async () => await jobWrites() > before && await jobState(await tile('marked-for-later')) === 'stopped')
    assert.deepEqual((await options.lastWrite('siteExportJob')).steps, ['refreshing'])
    await inTile('marked-for-later', 'button', 'Continue')
    await saysOn(await inTile('read-works', 'button', 'Cache works'), 'Cache works')

    await options.press(await inTile('marked-for-later', 'button', 'Discard'))
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
    await until('the tile to drop its line', async () => await jobState(await tile('marked-for-later')) === null)
    await saysOn(await inTile('marked-for-later', 'button', 'Refresh list'), 'Refresh list')
  })

  test('More: the list refreshed first, a retry while any work has failed, and a download without refreshing once any is cached', async () => {
    await openMore('marked-for-later', 'Marked for Later')
    const markedItems = await menuItems()
    beginWith(markedItems, ['Refresh the list first', 'Retry failed works now', 'Remove offline copy'])
    assert.match(markedItems[1], /on the 1 work that failed/)
    await closeMenu()

    await openMore('read-works', 'Read works')
    const readItems = await menuItems()
    beginWith(readItems, ['Refresh the list first', 'Download without refreshing', 'Remove offline copy'])
    assert.match(readItems[1], /as up to date as the 1 saved work are/)
    await closeMenu()

    await openMore('marked-for-later', 'Marked for Later')
    await options.press(await menuItem('Retry failed works now'))
    await until('the job to be running', async () => await jobState(await tile('marked-for-later')) === 'running')
    const job = await options.lastWrite('siteExportJob')
    assert.equal(job.cacheKey, MARKED)
    assert.deepEqual(job.steps, ['caching'])
    assert.equal(job.retryNow, true)

    const before = await jobWrites()
    await options.press(await inTile('marked-for-later', 'button', 'Stop'))
    await until('the stopped job to be written', async () => await jobWrites() > before && await jobState(await tile('marked-for-later')) === 'stopped')
    await options.press(await inTile('marked-for-later', 'button', 'Discard'))
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
  })

  test('another list\'s job turns More\'s fetching off, saying why, and leaves Remove on', async () => {
    await options.press(await options.control(await options.savedListDetails(copyRow(OTHER)), 'button', 'Cache works'))
    await until('the job to be running', async () => await jobState(await options.savedList(copyRow(OTHER))) === 'running')

    const reason = 'off for now: one job at a time, and Tag: Coffee Shop AU is caching'
    await openMore('read-works', 'Read works')
    for (const [name, label] of [['Refresh the list first', 'Refresh the list first'], ['Download without refreshing', 'Download without refreshing']]) {
      const item = await menuItem(name)
      assert.equal(await item.evaluate(el => el.hasAttribute('data-disabled')), true, `${name} should be off`)
      assert.equal(await item.evaluate(el => el.title), `${label} — ${reason}`)
      assert.equal(await options.description(item), `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`)
    }
    assert.equal(await (await menuItem('Remove offline copy')).evaluate(el => el.hasAttribute('data-disabled')), false)
    await closeMenu()

    await options.press(await options.control(await options.savedList(copyRow(OTHER)), 'button', 'Stop caching Tag: Coffee Shop AU'))
    await until('the job to stop', async () => await jobState(await options.savedList(copyRow(OTHER))) === 'stopped')
    await options.press(await options.control(await options.savedList(copyRow(OTHER)), 'button', 'Discard'))
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
  })

  test('Remove offline copy asks a second time in its place, and the tile then says how a copy is kept', async () => {
    await openMore('read-works', 'Read works')
    const item = await menuItem('Remove offline copy')
    assert.ok((await options.name(item)).endsWith(blurbsOnRemove(false)), 'it says what becomes of the blurbs')
    await options.press(item)
    const armed = await menuItem('Remove offline copy?')
    assert.ok(armed, 'the first press arms it, and the menu stays open')
    assert.ok(READ in await options.stored('cache.searchLists'), 'arming removes nothing')

    await options.press(armed)
    await until('the copy to go', async () => !(READ in await options.stored('cache.searchLists')))
    await until('the menu to close', async () => (await options.controls(page, 'menuitem')).length === 0)

    const read = await tile('read-works')
    await until('the tile to say how a copy is kept', async () => /None yet\. Press Search read items on your History page on AO3/.test(await options.text(await tile('read-works'))))
    assert.equal(await read.$('[role="img"]'), null)
    assert.deepEqual(await options.controls(await tile('read-works'), 'button', 'Refresh list'), [])
    assert.equal(await (await inTile('read-works', 'link', 'View Read works on AO3')).evaluate(a => a.getAttribute('href')), `${READ_PAGE}#ao3e-open=read-works`, 'its open URL on the reader\'s own page, from their account')
    assert.ok(THEIR_READ in await options.stored('cache.searchLists'), 'another account\'s copy is no tile, and stays')
  })

  test('Download Offline Copy runs to the end: finished, with its warning and its failure, and the actions back', async () => {
    release()
    await options.press(await inTile('marked-for-later', 'button', 'Download Offline Copy'))
    await until('the job to finish', async () => await jobState(await tile('marked-for-later')) === 'finished', 40000)
    await until('the file to be handed over', () => page.evaluate(() => window.__downloads.length === 1))

    const marked = await tile('marked-for-later')
    assert.ok(await marked.$('[data-callout="warning"]'), 'the warning is a callout')
    assert.match(await options.text(marked), /1 of 3 works have no saved text, so the site links those to AO3 instead of opening them\. Run “Cache works” to fetch them\./)
    assert.match(await options.text(marked), /\b1 work could not be fetched\b/)
    await saysOn(await inTile('marked-for-later', 'button', 'Refresh list'), 'Refresh list')
    await until('the tile to count what was cached', async () => (await options.lines(await tile('marked-for-later'))).some(line => /^2 cached \(/.test(line)))
  })

  test('nothing threw along the way', () => {
    // Chrome logs every non-2xx response as a console error of its own, and
    // the runner logs a refresh stopped part-way; both are the subject of a test.
    assert.deepEqual(options.problems(/status of 404|Site export job stopped/), [])
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
  const inTile = async (role, name) => options.control(await tile(), role, name)

  test('a refresh AO3 serves signed out stops, saying so in a callout, and offers Continue or Discard', async () => {
    await until('the tile to read its copy', async () => (await options.controls(await tile(), 'button', 'Refresh list')).length === 1)
    await options.press(await inTile('button', 'Refresh list'))
    await until('the job to stop', async () => await jobState(await tile()) === 'stopped')

    const callout = await (await tile()).$('[data-callout="destructive"]')
    assert.ok(callout, 'the reason is an error callout')
    assert.match(await options.text(callout), /AO3 served the signed-out view, and this list is only visible to your own account\./)
    await inTile('button', 'Continue')
    await options.press(await inTile('button', 'Discard'))
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
  })

  test('a refusal is sat out in the warning colour, counting down, until the job is stopped', async () => {
    await until('the actions to be back', async () => (await options.controls(await tile(), 'button', 'Cache works')).length === 1)
    await options.press(await inTile('button', 'Cache works'))
    await until('the tile to sit out the refusal', async () => (await tile()).evaluate(el => !!el.querySelector('[data-job-state="waiting"][data-job-wait="refused"]')))

    const marked = await tile()
    assert.match(await options.text(marked), /AO3 asked us to slow down — trying again in \d+:\d\d/)
    assert.match(await marked.evaluate(el => getComputedStyle(el.querySelector('[role="progressbar"] > div')).backgroundImage), /repeating-linear-gradient/, 'a striped bar')

    await options.press(await inTile('button', 'Stop'))
    await until('the job to stop', async () => await jobState(await tile()) === 'stopped')
    const job = await options.lastWrite('siteExportJob')
    assert.equal(job.cacheKey, MARKED)
    assert.deepEqual(job.steps, ['caching'])
  })

  test('nothing threw along the way', () => {
    // The refusals the stub serves, and the signed-out refresh the runner logs
    // as it stops, are the subject of a test.
    assert.deepEqual(options.problems(/status of 429|Site export job stopped/), [])
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
        await until('the tiles to read their copies', async () => (await options.lines(await options.tile('read-works'))).includes('2 works · as of 3 hours ago'))
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
      const box = await options.control(options.page, 'textbox', 'Search settings by name or description')
      await box.type('to-read page')
      const shown = async id => (await options.tile(id)).evaluate(el => el.checkVisibility())
      await until('the search to hide the tile it doesn\'t find', async () => !(await shown('read-works')))
      assert.equal(await shown('marked-for-later'), true)
      assert.deepEqual(await (await options.tile('marked-for-later')).$$eval('mark', els => els.map(el => el.textContent)), ['to-read', 'page'])
      assert.deepEqual(options.problems(), [])
    }
    finally {
      await options.close()
    }
  })
})
