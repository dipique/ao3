import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { menuClosed, menuRows, openMenu, pickRow, settled } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const SEED = { 'option.tagToolbar': true }

/**
 * A works listing with AO3's Sort & Filter form under it, carrying *both*
 * directions of everything the tag menus can drive: the two free-text tag
 * fields, and include/exclude checkboxes for one freeform tag. `Fluff` has a
 * checkbox on each side (the path the menus prefer); `Angst` has none, so it
 * goes through the text fields instead.
 */
const PAGE = `
<div id="main">
  <ol class="work index group">
    <li class="work blurb group" id="work_1">
      <div class="header module">
        <h4 class="heading"><a href="/works/1">A fluffy one</a> by <a rel="author" href="/users/s/pseuds/s">s</a></h4>
      </div>
      <ul class="tags commas">
        <li class="freeforms"><a class="tag" href="/tags/Fluff/works">Fluff</a></li>
        <li class="freeforms"><a class="tag" href="/tags/Angst/works">Angst</a></li>
      </ul>
    </li>
  </ol>

  <form id="work-filters" action="/tags/x/works">
    <dd><input id="work_search_other_tag_names" name="work_search[other_tag_names]" type="text" value=""></dd>
    <dd><input id="work_search_excluded_tag_names" name="work_search[excluded_tag_names]" type="text" value=""></dd>
    <dd id="include_freeform_tags" class="expandable freeform tags">
      <ul>
        <li><label for="in_f_110"><input type="checkbox" name="include_work_search[freeform_ids][]" id="in_f_110" value="110"><span class="indicator"></span><span>Fluff (6385)</span></label></li>
      </ul>
    </dd>
    <dd id="exclude_freeform_tags" class="expandable freeform tags">
      <ul>
        <li><label for="ex_f_110"><input type="checkbox" name="exclude_work_search[freeform_ids][]" id="ex_f_110" value="110"><span class="indicator"></span><span>Fluff (6385)</span></label></li>
      </ul>
    </dd>
  </form>
</div>
`

/**
 * Include and exclude are contradictory: AO3 drops a work carrying an excluded
 * tag whatever else asked for it, so a sidebar left holding both quietly narrows
 * the next search to nothing. Picking one direction therefore clears the other —
 * which is what the in-memory search view's facets have always done, and what
 * AO3's own sidebar is made to do here.
 *
 * The same page is where the sidebar's "include" is offered as what it does:
 * the archive ANDs the tags it is told to include, so the menu's row requires.
 */
describe('one direction at a time in the sidebar filter', { skip }, () => {
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

  // A fresh page per test: the filter is page state, and these tests each leave
  // it somewhere different.
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

  /** Right-click the blurb tag link reading `text`; returns what the menu's rows do. */
  const openMenuOn = async (text) => {
    await openMenu(page, () => page.evaluate((want) => {
      const link = [...document.querySelectorAll('.blurb ul.tags a.tag')]
        .find(a => a.textContent.trim() === want)
      if (!link)
        throw new Error(`no tag link reading "${want}"`)
      link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
    }, text))
    return (await menuRows(page)).map(row => row.action)
  }

  /** Click the open menu's row that does `action`, and wait for the menu to close behind it. */
  const pick = async (action) => {
    assert.ok(await pickRow(page, action), `no ${action} row in the menu`)
    await menuClosed(page)
  }

  const checked = id => page.evaluate(sel => document.getElementById(sel).checked, id)
  const field = id => page.evaluate(sel =>
    document.getElementById(sel).value.split(',').map(s => s.trim()).filter(Boolean), id)

  test('offers the include direction as "require", since that is what the sidebar does', async () => {
    const actions = await openMenuOn('Fluff')
    assert.ok(actions.includes('require'), actions.join(' | '))
    assert.ok(actions.includes('exclude'), actions.join(' | '))
    assert.ok(!actions.includes('include'), actions.join(' | '))
  })

  test('excluding a tag unticks the box requiring it', async () => {
    await openMenuOn('Fluff')
    await pick('require')
    assert.equal(await checked('in_f_110'), true, 'requiring should tick the include box')

    await openMenuOn('Fluff')
    await pick('exclude')
    assert.equal(await checked('ex_f_110'), true, 'excluding should tick the exclude box')
    assert.equal(await checked('in_f_110'), false, 'and untick the include box')
  })

  test('requiring a tag unticks the box excluding it', async () => {
    await openMenuOn('Fluff')
    await pick('exclude')
    assert.equal(await checked('ex_f_110'), true)

    await openMenuOn('Fluff')
    await pick('require')
    assert.equal(await checked('in_f_110'), true, 'requiring should tick the include box')
    assert.equal(await checked('ex_f_110'), false, 'and untick the exclude box')
  })

  test('takes the tag out of the other text field when it has no checkbox', async () => {
    await openMenuOn('Angst')
    await pick('require')
    assert.deepEqual(await field('work_search_other_tag_names'), ['Angst'])

    await openMenuOn('Angst')
    await pick('exclude')
    assert.deepEqual(await field('work_search_excluded_tag_names'), ['Angst'])
    assert.deepEqual(await field('work_search_other_tag_names'), [], 'the included field should be emptied')
  })

  test('clearing a direction leaves the other alone', async () => {
    await openMenuOn('Fluff')
    await pick('exclude')
    await openMenuOn('Fluff')
    // The same row again, now active: this un-excludes, and must not reach over
    // and tick the include box it would otherwise have cleared.
    await pick('exclude')
    assert.equal(await checked('ex_f_110'), false)
    assert.equal(await checked('in_f_110'), false)
  })
})
