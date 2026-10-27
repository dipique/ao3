import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { menuClosed, openMenu, settled } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/**
 * A collapse rule raised to 6, a highlight, and a tag with no rule at all; and
 * for the works an "always show" keeps on the page, two fandom collapses (at 0
 * and 5) and two force-shows (at their default 4, and at 9).
 */
const SEED = {
  'option.tagToolbar': true,
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [
      { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'collapse', priority: 6 },
      { target: 'F', value: 'Waff', matcher: 'exact', behavior: 'highlight' },
      { target: 'f', value: 'Soft Fandom', matcher: 'exact', behavior: 'collapse' },
      { target: 'f', value: 'Hard Fandom', matcher: 'exact', behavior: 'collapse', priority: 5 },
      { target: 'F', value: 'Keeper', matcher: 'exact', behavior: 'invert' },
      { target: 'F', value: 'Override', matcher: 'exact', behavior: 'invert', priority: 9 },
    ],
  },
}

/** A blurb in one fandom, carrying the given additional tags. */
function shownBlurb(id, fandom, tags) {
  return `
    <li class="work blurb group" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">Work ${id}</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="/tags/${encodeURIComponent(fandom)}/works">${fandom}</a></h5>
      </div>
      <ul class="tags commas">
        ${tags.map(t => `<li class="freeforms"><a class="tag" href="/tags/${t}/works">${t}</a></li>`).join('')}
      </ul>
    </li>`
}

const PAGE = `
<div id="main">
  <ol class="work index group">
    <li class="work blurb group" id="work_1">
      <div class="header module">
        <h4 class="heading"><a href="/works/1">A work</a></h4>
      </div>
      <ul class="tags commas">
        <li class="freeforms"><a class="tag" href="/tags/Fluff/works">Fluff</a></li>
        <li class="freeforms"><a class="tag" href="/tags/Waff/works">Waff</a></li>
        <li class="freeforms"><a class="tag" href="/tags/Angst/works">Angst</a></li>
      </ul>
    </li>
    ${shownBlurb(2, 'Soft Fandom', ['Keeper'])}
    ${shownBlurb(3, 'Hard Fandom', ['Keeper', 'Override'])}
    ${shownBlurb(4, 'Plain Fandom', ['Keeper'])}
  </ol>
</div>
`

/**
 * A tag's menu offers its rule's priority as an "Update Priority" submenu, once
 * there is a rule whose priority decides anything; and switching the rule to
 * another behaviour keeps the priority it was given.
 */
describe('rule priority from the tag menu', { skip }, () => {
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

  /** Right-click the tag link reading `text` in a blurb; returns the menu's own row labels. */
  const openMenuOn = async (text, blurb = 'work_1') => {
    await openMenu(page, () => page.evaluate((want, id) => {
      const link = [...document.querySelectorAll(`#${id} ul.tags a.tag`)]
        .find(a => a.textContent.trim() === want)
      link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
    }, text, blurb))
    return page.evaluate(() =>
      [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
        .filter(el => !el.closest('.AO3E--menu--submenu'))
        .map(el => el.querySelector('.AO3E--menu--label').textContent))
  }

  /** Click the row reading `label`, in the menu or its open submenu. */
  const click = label => page.evaluate((want) => {
    const row = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
      .find(el => el.textContent === want)
    if (!row)
      throw new Error(`no menu row reading "${want}"`)
    row.click()
  }, label)

  /** The open submenu's rows, as label, and whether each is current and offered. */
  const submenuRows = () => page.evaluate(() =>
    [...document.querySelectorAll('.AO3E--menu--submenu .AO3E--menu--item')].map(el => ({
      label: el.textContent,
      active: el.classList.contains('AO3E--menu--active'),
      disabled: el.disabled,
    })))

  const storedRule = value => page.evaluate(async (want) => {
    const { 'option.rules': rules } = await window.browser.storage.local.get('option.rules')
    return rules.filters.find(r => r.value === want)
  }, value)

  test('is offered only for a rule whose priority decides anything', async () => {
    assert.ok((await openMenuOn('Fluff')).includes('Update Priority'))
    assert.ok(!(await openMenuOn('Waff')).includes('Update Priority'), 'a highlight never enters the contest')
    assert.ok(!(await openMenuOn('Angst')).includes('Update Priority'), 'no rule, nothing to weigh')
  })

  test('lists every priority, the current one marked and not offered, and sets the one picked', async () => {
    await openMenuOn('Fluff')
    await click('Update Priority')
    const rows = await submenuRows()
    assert.deepEqual(rows.map(r => r.label), Array.from({ length: 10 }, (_, i) => `Priority ${i}`))
    assert.deepEqual(rows.filter(r => r.active).map(r => r.label), ['Priority 6'])
    assert.deepEqual(rows.filter(r => r.disabled).map(r => r.label), ['Priority 6'])

    await click('Priority 2')
    await menuClosed(page)
    assert.deepEqual(await storedRule('Fluff'), { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'collapse', priority: 2 })
  })

  test('opens beside the menu when pointed at, and goes when another row is', async () => {
    await openMenuOn('Fluff')
    const rowAt = label => page.evaluate((want) => {
      const row = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')].find(el => el.textContent === want)
      const { x, y, width, height } = row.getBoundingClientRect()
      return { x: x + width / 2, y: y + height / 2 }
    }, label)

    const parent = await rowAt('Update Priority')
    await page.mouse.move(parent.x, parent.y)
    await page.waitForSelector('.AO3E--menu--submenu')
    assert.equal((await submenuRows()).length, 10)

    const other = await rowAt('Clear')
    await page.mouse.move(other.x, other.y)
    await page.waitForFunction(() => !document.querySelector('.AO3E--menu--submenu'))
    assert.ok(await page.$('.AO3E--menu'), 'the menu itself stays open')
  })

  test('switching the rule to another behaviour keeps its priority', async () => {
    await openMenuOn('Fluff')
    await click('Hide works with tag')
    await menuClosed(page)
    assert.deepEqual(await storedRule('Fluff'), { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'hide', priority: 6 })
  })

  test('an "always show" offers the hide it overrides on this work, at that rule’s own priority', async () => {
    const label = 'Overriding Fandom "Soft Fandom" (priority 0)'
    const labels = await openMenuOn('Keeper', 'work_2')
    assert.ok(labels.includes(label), labels.join(' | '))

    await click(label)
    assert.deepEqual((await submenuRows()).filter(r => r.active).map(r => r.label), ['Priority 0'])
    await click('Priority 5')
    await menuClosed(page)
    assert.deepEqual(await storedRule('Soft Fandom'), { target: 'f', value: 'Soft Fandom', matcher: 'exact', behavior: 'collapse', priority: 5 })
    await page.waitForFunction(() => document.getElementById('work_2').dataset.ao3eHiddenBy === 'tags')
  })

  test('lists only the hides this force-show outranks by itself', async () => {
    // "Hard Fandom" collapses at 5: above "Keeper" at 4, so it's "Override" at 9 holding it off.
    const keeper = await openMenuOn('Keeper', 'work_3')
    assert.ok(!keeper.some(l => l.startsWith('Overriding')), keeper.join(' | '))
    const override = await openMenuOn('Override', 'work_3')
    assert.ok(override.includes('Overriding Fandom "Hard Fandom" (priority 5)'), override.join(' | '))
  })

  test('a force-show overriding nothing on this work offers nothing', async () => {
    const labels = await openMenuOn('Keeper', 'work_4')
    assert.ok(labels.includes('Update Priority'), 'the menu is the force-show’s own')
    assert.ok(!labels.some(l => l.startsWith('Overriding')), labels.join(' | '))
  })
})
