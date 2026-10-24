import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { createDefaultMarks } from '../../src/common/workMarks.ts'
import { ensureBuilt, findChrome, storedListIds, storedLists } from './helpers.mjs'
import { until } from './optionsPage.mjs'
import { ARCHIVE, blurb, launch, openMenu, openTab, stored, toasts, viewDrawn, visit } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const TO_READ = `${ARCHIVE}/users/me/readings?show=to-read`
const KEY = 'marked-for-later:me'
const RESULTS = '.AO3E--search-view--results > li.blurb'
const KEPT = ['901', '902', '903']
/** The work the reader marks read. */
const TAKEN = '902'

/** The reader's own Marked for Later, signed in as `me`, with the token a mark is sent with. */
const TO_READ_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="csrf-token" content="token"><title>Marked for Later</title></head>
<body class="logged-in">
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main" class="readings-index dashboard region">
    <h2 class="heading">Marked for Later</h2>
    <ul class="navigation actions" role="navigation">
      <li><a href="/users/me/readings">History</a></li>
      <li><span class="current">Marked for Later</span></li>
    </ul>
    <ol class="reading work index group">${KEPT.map(id => blurb(id)).join('')}</ol>
  </div>
</body></html>`

/** A kept copy of the list, read just now, so the view opens on it and reads nothing. */
function keptCopy() {
  const descriptor = { sourceId: 'marked-for-later', label: 'Marked for Later — me', listUrl: TO_READ }
  return storedLists({ [KEY]: { scrapedAt: Date.now(), blurbsHtml: KEPT.map(id => blurb(id)), descriptor } })
}

const shownIds = tab => tab.$$eval(`${RESULTS}:not(.AO3E--search-view--hidden)`, els => els.map(li => li.id.replace('work_', '')))

/**
 * The Marked for Later search view offers no button of its own to mark a work
 * read. Every work on it is marked for later, so its title carries the Marked
 * for Later clock, whether or not "Mark a work for later" puts that mark on
 * other pages; the clock opens the work's menu, and marking the work read
 * there takes it out of the view and off the stored copy.
 */
describe('marking a work read from the Marked for Later view', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const open = async (workMarks) => {
    const requests = []
    const tab = await openTab(browser, {
      seed: {
        'option.searchMarkedForLater': true,
        'option.markForLaterToolbar': false,
        'option.workMarks': workMarks,
        ...keptCopy(),
      },
      route: (url) => {
        if (url.pathname === '/users/me/readings')
          return TO_READ_PAGE
        if (url.pathname === `/works/${TAKEN}/mark_as_read` || url.pathname === '/')
          return '<!doctype html><title>Archive</title>'
        return null
      },
      requests,
    })
    await visit(tab, TO_READ)
    await tab.waitForSelector(RESULTS)
    await viewDrawn(tab)
    return { tab, requests }
  }

  /** Open the work's menu from its clock, and choose the row whose label starts with `label`. */
  const chooseFromClock = async (tab, label) => {
    await openMenu(tab, () => tab.evaluate((id) => {
      document.querySelector(`#work_${id} h4.heading .AO3E--indicator--mark-saved`).click()
    }, TAKEN))
    await until(`the menu to offer "${label}"`, () => tab.evaluate((label) => {
      const row = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
        .find(el => !el.disabled && el.textContent.trim().startsWith(label))
      row?.click()
      return !!row
    }, label))
  }

  test('every work carries the clock, and no Mark as Read button', async () => {
    const { tab } = await open({ enabled: false, marks: createDefaultMarks() })
    try {
      const works = await tab.$$eval(RESULTS, els => els.map(li => ({
        clocks: li.querySelectorAll('h4.heading .AO3E--indicator--mark-saved').length,
        buttons: [...li.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Mark as Read').length,
      })))
      assert.deepEqual(works, KEPT.map(() => ({ clocks: 1, buttons: 0 })))
    }
    finally {
      await tab.close()
    }
  })

  for (const { name, workMarks, label } of [
    { name: 'with work marks off', workMarks: { enabled: false, marks: createDefaultMarks() }, label: 'Mark as read' },
    { name: 'with work marks on', workMarks: { enabled: true, marks: createDefaultMarks() }, label: 'Remove from Marked for Later' },
  ]) {
    test(`${name}, the clock's menu marks it read and the view and its copy let it go`, async () => {
      const { tab, requests } = await open(workMarks)
      try {
        await chooseFromClock(tab, label)
        await until('AO3 to be told', () => requests.some(url => new URL(url).pathname === `/works/${TAKEN}/mark_as_read`))
        await until('the work to leave the view', async () => !(await shownIds(tab)).includes(TAKEN))
        assert.deepEqual(await shownIds(tab), KEPT.filter(id => id !== TAKEN))
        await until('the work to come off the copy', async () => !storedListIds((await stored(tab, 'cache.searchLists'))?.[KEY]).includes(TAKEN))
        assert.ok((await toasts(tab)).includes('Marked as read — removed from your Marked for Later list.'))
      }
      finally {
        await tab.close()
      }
    })
  }
})
