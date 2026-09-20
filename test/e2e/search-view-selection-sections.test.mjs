import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const READINGS_URL = 'https://archiveofourown.org/users/me/readings?show=to-read'
const SEED = { 'option.searchMarkedForLater': true, 'option.tagToolbar': true }

function blurb(id, title, tags) {
  const tagList = tags
    .map(t => `<li class="freeforms"><a class="tag" href="/tags/${encodeURIComponent(t)}/works">${t}</a></li>`)
    .join('')
  return `
    <li class="blurb work" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">${title}</a> by <a rel="author" href="/users/s/pseuds/s">s</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="/tags/A%20Fandom/works">A Fandom</a></h5>
      </div>
      <ul class="tags commas">${tagList}</ul>
      <dl class="stats"><dt class="words">Words:</dt><dd class="words">7,150</dd><dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd></dl>
    </li>`
}

const HTML = `<!doctype html>
<html><head><title>Marked for Later</title></head>
<body class="logged-in">
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main">
    <ul class="navigation actions"><li><span class="current">Marked for Later</span></li></ul>
    <ol class="reading work index group">
      ${blurb(1, 'Fluffy one', ['Fluff'])}
      ${blurb(2, 'Angsty one', ['Angst'])}
      ${blurb(3, 'Both at once', ['Fluff', 'Angst'])}
      ${blurb(4, 'A quiet one', ['Quiet'])}
      ${blurb(5, 'A sad one', ['Hurt/Comfort'])}
    </ol>
  </div>
</body></html>`

const GROUP = 'Additional Tags'

/**
 * A facet group keeps its selected values in a collapsible section per
 * direction, above the rest. Required and included values sit in the open; the
 * excluded ones start shut, because the rule-implied exclusions land there and
 * can fill it faster than anyone wants to scroll past — and a section the reader
 * has shut stays shut as more values arrive in it.
 *
 * Whichever control made the selection: a facet row's own buttons and the
 * include/exclude/require rows on a blurb's tag menu are two ways into the same
 * toggle, and a value has to land in the same place either way.
 */
describe('the search view selection sections', { skip }, () => {
  let browser
  let page

  before(async () => {
    ensureBuilt()
    const css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    const js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })
    page = await browser.newPage()
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html', body: HTML })
      else
        void req.abort()
    })
    await page.evaluateOnNewDocument(installMock, SEED)
    await page.goto(READINGS_URL, { waitUntil: 'domcontentloaded' })
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    // The view opens by itself here; wait for the scrape and the first render.
    await sleep(2500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** Click a facet row's require/include/exclude button for `value`. */
  const toggleRow = async (value, dir) => {
    await page.evaluate(([want, d]) => {
      const row = [...document.querySelectorAll('.AO3E--search-view--row')]
        .find(r => r.querySelector('.AO3E--search-view--row-name')?.textContent === want)
      if (!row)
        throw new Error(`no facet row for "${want}"`)
      row.querySelector(`.AO3E--search-view--toggle-${d}`).click()
    }, [value, dir])
    await sleep(400)
  }

  /** The same toggle from the other end: a blurb's tag menu inside the view. */
  const toggleFromTagMenu = async (value, label) => {
    await page.evaluate((want) => {
      const link = [...document.querySelectorAll('.AO3E--search-view--results ul.tags a.tag')]
        .find(a => a.textContent.trim() === want)
      if (!link)
        throw new Error(`no tag link reading "${want}" in the results`)
      link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
    }, value)
    await sleep(250)
    await page.evaluate((l) => {
      const row = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
        .find(el => el.textContent.startsWith(l))
      if (!row)
        throw new Error(`no "${l}" row on the tag menu`)
      row.click()
    }, label)
    await sleep(500)
  }

  /** Where `value`'s row sits in `group`, and whether the reader can see it. */
  const placement = (group, value) => page.evaluate(([g, want]) => {
    const details = [...document.querySelectorAll('.AO3E--search-view--group')]
      .find(d => d.querySelector('.AO3E--search-view--group-label').textContent.trim().startsWith(g))
    const row = [...details.querySelectorAll('.AO3E--search-view--row')]
      .find(r => r.querySelector('.AO3E--search-view--row-name')?.textContent === want)
    if (!row)
      return null
    const section = row.closest('.AO3E--search-view--sel')
    return {
      section: section ? section.querySelector('.AO3E--search-view--sel-label').textContent : null,
      // offsetParent is null for anything display:none, at any depth.
      visible: row.offsetParent !== null,
      // What the section heading says it holds, for a value shut away inside one.
      heading: section && !section.classList.contains('AO3E--search-view--hidden')
        ? section.querySelector('.AO3E--search-view--sel-head').textContent.trim()
        : null,
    }
  }, [group, value])

  /** Click a group's section heading, e.g. "Excluded". */
  const clickHeading = async (group, label) => {
    await page.evaluate(([g, want]) => {
      const details = [...document.querySelectorAll('.AO3E--search-view--group')]
        .find(d => d.querySelector('.AO3E--search-view--group-label').textContent.trim().startsWith(g))
      const head = [...details.querySelectorAll('.AO3E--search-view--sel-head')]
        .find(h => h.querySelector('.AO3E--search-view--sel-label').textContent === want)
      if (!head)
        throw new Error(`no "${want}" heading in ${g}`)
      head.click()
    }, [group, label])
    await sleep(300)
  }

  test('files an excluded value under a heading that starts shut', async () => {
    await toggleRow('Fluff', 'exclude')
    assert.deepEqual(await placement(GROUP, 'Fluff'), {
      section: 'Excluded',
      visible: false,
      heading: 'Excluded1',
    })
  })

  test('leaves the other two sections open, so their values stay in sight', async () => {
    await toggleRow('Angst', 'include')
    assert.deepEqual(await placement(GROUP, 'Angst'), { section: 'Included', visible: true, heading: 'Included1' })

    await toggleRow('Angst', 'require')
    assert.deepEqual(await placement(GROUP, 'Angst'), { section: 'Required', visible: true, heading: 'Required1' })
  })

  test('keeps a shut section shut as more values land in it', async () => {
    await toggleRow('Quiet', 'exclude')
    assert.deepEqual(await placement(GROUP, 'Quiet'), {
      section: 'Excluded',
      visible: false,
      heading: 'Excluded2',
    })
  })

  test('opens on the heading, and stays open for the next value', async () => {
    await clickHeading(GROUP, 'Excluded')
    assert.deepEqual(await placement(GROUP, 'Fluff'), { section: 'Excluded', visible: true, heading: 'Excluded2' })

    await toggleRow('Hurt/Comfort', 'exclude')
    assert.deepEqual(await placement(GROUP, 'Hurt/Comfort'), { section: 'Excluded', visible: true, heading: 'Excluded3' })
  })

  test('a blurb tag menu files its value in the same place a facet row would', async () => {
    await clickHeading(GROUP, 'Excluded')
    await toggleRow('Angst', 'require')
    assert.equal((await placement(GROUP, 'Angst'))?.section, null, 'Angst starts unselected')

    // "Both at once" carries Angst and is still on the page, so its menu is the
    // way in. The row has to end up exactly where the facet button puts it.
    await toggleFromTagMenu('Angst', 'Exclude')
    assert.deepEqual(await placement(GROUP, 'Angst'), {
      section: 'Excluded',
      visible: false,
      heading: 'Excluded4',
    })
  })

  test('leaves an unselected value outside the sections', async () => {
    assert.deepEqual(await placement(GROUP, 'Quiet'), { section: 'Excluded', visible: false, heading: 'Excluded4' })
    await toggleRow('Quiet', 'exclude')
    assert.deepEqual(await placement(GROUP, 'Quiet'), { section: null, visible: true, heading: null })
  })
})
