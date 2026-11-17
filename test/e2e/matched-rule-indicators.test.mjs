import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { mentions } from '../facts.mjs'
import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { menuClosed, menuRows, openMenu, pickRow, settled } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/** Collapses "angst" below the force-show "keeper", so the work stays on the page with every tag showing. */
const COLLAPSE = { target: 'tag', value: 'angst', matcher: 'contains', behavior: 'collapse', priority: 2 }
const SHOW = { target: 'F', value: '^keeper', matcher: 'regex', behavior: 'invert' }
const HIGHLIGHT = { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'highlight' }

const SEED = {
  'option.tagToolbar': true,
  'option.rules': { enabled: true, colors: {}, filters: [COLLAPSE, SHOW, HIGHLIGHT] },
}

const PAGE = `
<div id="main">
  <ol class="work index group">
    <li class="work blurb group" id="work_1">
      <div class="header module">
        <h4 class="heading"><a href="/works/1">A work</a></h4>
      </div>
      <ul class="tags commas">
        ${['Angst Lite', 'Keeper of Peace', 'Fluff', 'Plain'].map(t => `<li class="freeforms"><a class="tag" href="/tags/${t}/works">${t}</a></li>`).join('')}
      </ul>
    </li>
  </ol>
</div>
`

/**
 * A tag a `contains` or `regex` rule matches carries that rule's icon, marked
 * by how the rule matched and naming it on hover, and its menu offers that
 * rule's priority.
 */
describe('icons for rules matching a tag by more than its name', { skip }, () => {
  let browser
  let page
  let js

  before(async () => {
    ensureBuilt()
    js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await page?.close()
    await browser?.close()
  })

  beforeEach(async () => {
    await page?.close()
    page = await browser.newPage()
    await page.goto('about:blank')
    await page.evaluate(installMock, SEED)
    await page.evaluate((html) => {
      document.body.innerHTML = html
    }, PAGE)
    await page.addScriptTag({ content: js })
    await settled(page)
  })

  /** The indicators after the tag link reading `text`: each one's state, how its rule matched, and its hover text. */
  const indicatorsOn = text => page.evaluate((want) => {
    const link = [...document.querySelectorAll('#work_1 ul.tags a.tag')].find(a => a.textContent.trim() === want)
    const span = link.nextElementSibling
    if (!span?.classList.contains('AO3E--indicators'))
      return []
    return [...span.querySelectorAll('.AO3E--indicator')].map(el => ({
      state: [...el.classList].find(c => c.startsWith('AO3E--indicator--'))?.replace('AO3E--indicator--', ''),
      matcher: el.dataset.ao3eMatcher ?? null,
      title: el.title,
    }))
  }, text)

  /** The menu's own rows (not a submenu's) once `gesture` has opened it. */
  const rowsAfter = async (gesture) => {
    await openMenu(page, gesture)
    return (await menuRows(page)).filter(row => !row.submenu)
  }
  const rightClickTag = text => () => page.evaluate((want) => {
    const link = [...document.querySelectorAll('#work_1 ul.tags a.tag')].find(a => a.textContent.trim() === want)
    link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
  }, text)
  const clickIndicatorOf = text => () => page.evaluate((want) => {
    const link = [...document.querySelectorAll('#work_1 ul.tags a.tag')].find(a => a.textContent.trim() === want)
    link.nextElementSibling.querySelector('.AO3E--indicator').click()
  }, text)
  const valuesOf = (rows, action) => rows.filter(row => row.action === action).map(row => row.value)

  const click = async (action, value) => {
    assert.ok(await pickRow(page, action, value), `no ${action} row ${value ?? ''}`)
  }

  const storedRule = value => page.evaluate(async (want) => {
    const { 'option.rules': rules } = await window.browser.storage.local.get('option.rules')
    return rules.filters.find(r => r.value === want)
  }, value)

  test('a contains rule’s icon is marked as contains and names the rule', async () => {
    const [icon, ...rest] = await indicatorsOn('Angst Lite')
    assert.deepEqual(rest, [])
    assert.equal(icon.state, 'collapse')
    assert.equal(icon.matcher, 'contains')
    assert.ok(mentions(icon.title, COLLAPSE.value), icon.title)
  })

  test('a regex rule’s icon is marked as regex and names the rule', async () => {
    const [icon, ...rest] = await indicatorsOn('Keeper of Peace')
    assert.deepEqual(rest, [])
    assert.equal(icon.state, 'invert')
    assert.equal(icon.matcher, 'regex')
    assert.ok(mentions(icon.title, SHOW.value), icon.title)
  })

  test('an exact rule’s icon stays unmarked, and a tag no rule matches has none', async () => {
    assert.deepEqual((await indicatorsOn('Fluff')).map(i => [i.state, i.matcher]), [['highlight', null]])
    assert.deepEqual(await indicatorsOn('Plain'), [])
  })

  test('the icon opens a menu offering the matching rule’s priority', async () => {
    const rows = await rowsAfter(clickIndicatorOf('Keeper of Peace'))
    assert.deepEqual(valuesOf(rows, 'matched-rule'), [SHOW.value])
  })

  test('the tag’s menu sets the matching rule’s priority', async () => {
    const rows = await rowsAfter(rightClickTag('Angst Lite'))
    assert.deepEqual(valuesOf(rows, 'matched-rule'), [COLLAPSE.value])

    await click('matched-rule', COLLAPSE.value)
    const submenu = (await menuRows(page)).filter(row => row.submenu)
    assert.deepEqual(submenu.filter(r => r.active).map(r => r.value), [String(COLLAPSE.priority)])
    await click('set-priority', '9')
    await menuClosed(page)
    assert.deepEqual(await storedRule(COLLAPSE.value), { ...COLLAPSE, priority: 9 })
    // Above the force-show now, so the collapse wins.
    await page.waitForFunction(() => document.getElementById('work_1').dataset.ao3eHiddenBy === 'tags')
  })
})
