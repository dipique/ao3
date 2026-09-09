import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { REPO_ROOT } from '../e2e/helpers.mjs'
import { chromePath, skipWithoutChrome } from './helpers.mjs'

/**
 * The exported page's skin, over the markup AO3 actually hands us.
 *
 * An export carries no stylesheet of AO3's — {@link file://../../src/site/site.css}
 * redraws the handful of structures the view renders, from scratch. That makes
 * the blurb one of the few things in this feature with no test under it at all:
 * every rule here is load-bearing, none of it throws when it is wrong, and the
 * way you find out is by opening a library on a tablet and finding the list
 * numbered down the margin.
 *
 * So this asserts the parts that are *decidable* about a skin — what is hidden,
 * what has no marker, what is square, what sits where — rather than how it
 * looks. The markup below is a real blurb's shape, landmarks and symbol spans
 * included, because those are exactly the parts the view never touches and the
 * stylesheet is wholly responsible for.
 */

const skip = skipWithoutChrome

/**
 * The stylesheet as an export carries it: one file, `content_script.css` first
 * because `site.css` leads with an `@import` of it, which is what the real
 * bundler flattens too.
 */
function stylesheet() {
  const read = path => readFileSync(join(REPO_ROOT, path), 'utf8')
  const site = read('src/site/site.css')
  return `${read('src/content_script/content_script.css')}\n${site.replace(/@import\s+'[^']*content_script\.css';/, '')}`
}

/** Every required-tags class the stylesheet claims to know, and what AO3 calls it. */
const SYMBOLS = [
  ['rating-notrated rating', 'Not Rated'],
  ['rating-general-audience rating', 'General Audiences'],
  ['rating-teen rating', 'Teen And Up Audiences'],
  ['rating-mature rating', 'Mature'],
  ['rating-explicit rating', 'Explicit'],
  ['warning-no warnings', 'No Archive Warnings Apply'],
  ['warning-choosenotto warnings', 'Creator Chose Not To Use Archive Warnings'],
  ['warning-yes warnings', 'Graphic Depictions Of Violence'],
  ['category-none category', 'No category'],
  ['category-gen category', 'Gen'],
  ['category-het category', 'F/M'],
  ['category-slash category', 'M/M'],
  ['category-femslash category', 'F/F'],
  ['category-multi category', 'Multi'],
  ['category-other category', 'Other'],
  ['complete-yes iswip', 'Complete Work'],
  ['complete-no iswip', 'Work in Progress'],
]

/**
 * One of each kind, in the order AO3 emits them — which is the order the square
 * is filled in, so a fixture of four ratings would prove nothing about it.
 */
const QUAD = ['rating-mature', 'warning-yes', 'category-gen', 'complete-yes']
  .map(cls => SYMBOLS.find(([classes]) => classes.startsWith(`${cls} `)))

/** One symbol, wrapped the way AO3 wraps it: a link to the key around a span. */
function symbol([cls, title]) {
  return `<li><a class="help symbol question modal" href="/help/symbols-key.html"><span class="${cls}" title="${title}"><span class="text">${title}</span></span></a></li>`
}

/**
 * A blurb with everything the skin has an opinion about — the four symbols, the
 * date, the landmark captions, an inner list, a summary and the stats line.
 */
function page(symbols) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${stylesheet()}</style></head>
<body class="ao3e-site">
<ol class="work index group AO3E--search-view--results">
  <li id="work_11" class="work blurb group" role="article">
    <div class="header module">
      <h4 class="heading"><a href="https://archiveofourown.org/works/11">A work</a> by <a rel="author" href="#">someone</a></h4>
      <h5 class="fandoms heading"><span class="landmark">Fandoms:</span> <a class="tag" href="#">A Fandom</a></h5>
      <ul class="required-tags">${symbols.map(symbol).join('')}</ul>
      <p class="datetime">07 Sep 2026</p>
    </div>
    <h6 class="landmark heading">Tags</h6>
    <ul class="tags commas"><li class="freeforms"><a class="tag" href="#">Fluff</a></li></ul>
    <h6 class="landmark heading">Summary</h6>
    <blockquote class="userstuff summary"><p>A summary.</p></blockquote>
    <h6 class="landmark heading">Series</h6>
    <ul class="series"><li>Part <strong>1</strong> of <a href="#">A Series</a></li></ul>
    <dl class="stats"><dt class="words">Words:</dt><dd class="words">5,000</dd></dl>
  </li>
</ol></body></html>`
}

describe('site export — the blurb skin', { skip }, () => {
  let browser
  let view

  before(async () => {
    browser = await puppeteer.launch({ executablePath: chromePath, headless: true })
    view = await browser.newPage()
    await view.setViewport({ width: 1000, height: 900 })
    await view.setContent(page(QUAD), { waitUntil: 'load' })
  }, { timeout: 120000 })

  after(async () => browser?.close())

  const box = selector => view.$eval(selector, (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }
  })

  /**
   * AO3 ships these captions for screen readers and hides them; without a rule
   * of our own every blurb grows a stray "Tags", "Summary" and "Series".
   */
  test('the landmark captions are out of the picture, not out of the document', async () => {
    const marks = await view.$$eval('.landmark', els => els.map(el => ({
      text: el.textContent.trim(),
      w: el.getBoundingClientRect().width,
      h: el.getBoundingClientRect().height,
      display: getComputedStyle(el).display,
    })))
    assert.ok(marks.length >= 4, 'the fixture should carry the captions a real blurb does')
    for (const mark of marks) {
      assert.ok(mark.w <= 1 && mark.h <= 1, `"${mark.text}" is still taking up ${mark.w}x${mark.h}`)
      // Clipped rather than removed: `display: none` would take it out of the
      // accessibility tree too, which is the one thing it is there for.
      assert.notEqual(mark.display, 'none')
    }
  })

  /**
   * Blurbs are list items, and so are their tags, symbols and series. AO3's own
   * skin zeroes every marker globally; an export has to do it itself or the
   * results number themselves 1., 2., 3. down the margin.
   */
  test('no list in a blurb draws a marker', async () => {
    const markers = await view.$$eval(
      'ol.index, .blurb ul.tags, .blurb ul.series, .blurb ul.required-tags',
      els => els.map(el => `${el.className}: ${getComputedStyle(el).listStyleType}`),
    )
    assert.ok(markers.length >= 4)
    for (const marker of markers)
      assert.match(marker, /: none$/)
  })

  /** The bug that started this: floated, it landed halfway down the card. */
  test('the date sits in the corner, level with the title', async () => {
    const [blurb, date, title] = await Promise.all([
      box('li.blurb'),
      box('.blurb .datetime'),
      box('.blurb .header h4'),
    ])
    assert.ok(date.y < title.bottom, 'the date should start no lower than the title it belongs to')
    assert.ok(date.right <= blurb.right, 'and stay inside the card')
    assert.ok(blurb.right - date.right < 20, `it should be in the corner, not ${blurb.right - date.right}px from it`)
    assert.ok(title.right <= date.x, 'the title should be inset past it rather than run under it')
  })

  /**
   * AO3 draws these from a sprite at a fixed URL that an export has no copy of.
   * Redrawn here as letters in AO3's own arrangement: a 2x2 square of square
   * cells, in a column of its own to the left of the title.
   */
  test('the required tags are a 2x2 square, left of the title', async () => {
    const cells = await view.$$eval('.blurb ul.required-tags li a > span', els => els.map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }))
    assert.equal(cells.length, 4)
    for (const cell of cells)
      assert.equal(Math.round(cell.w), Math.round(cell.h), `a cell came out ${cell.w}x${cell.h}, not square`)

    // Two columns and two rows, which is the whole of "2x2".
    assert.equal(new Set(cells.map(c => Math.round(c.x))).size, 2)
    assert.equal(new Set(cells.map(c => Math.round(c.y))).size, 2)

    const [square, title] = await Promise.all([box('.blurb ul.required-tags'), box('.blurb .header h4')])
    assert.ok(square.right <= title.x, 'the title should clear the square, not overlap it')
    assert.ok(title.x - square.right < 24, 'and not by a mile')
  })

  /**
   * Down, then across — AO3's order, and not a grid's. The archive stacks rating
   * over warnings on the left and category over completion on the right, so a
   * reader who has learned that the red square at the bottom left means
   * "warnings" is reading position as much as colour.
   */
  test('the symbols fill the square the way AO3 fills it', async () => {
    const at = await view.$$eval('.blurb ul.required-tags li a > span', els => els.map((el) => {
      const r = el.getBoundingClientRect()
      return { group: el.className.split(' ')[1], x: Math.round(r.x), y: Math.round(r.y) }
    }))
    const [rating, warnings, category, completion] = at
    assert.deepEqual(at.map(s => s.group), ['rating', 'warnings', 'category', 'iswip'], 'AO3 emits them in this order')

    assert.equal(rating.x, warnings.x, 'rating and warnings share the left column')
    assert.ok(rating.y < warnings.y, 'with the rating on top')
    assert.equal(category.x, completion.x, 'category and completion share the right column')
    assert.ok(category.y < completion.y, 'with the category on top')
    assert.ok(rating.x < category.x, 'and the left column really is on the left')
    assert.equal(rating.y, category.y, 'the two columns start level')
  })

  /** A class the stylesheet forgot falls back to a dot, which is the tell. */
  test('every symbol AO3 can send has a letter of its own', async () => {
    await view.setContent(page(SYMBOLS), { waitUntil: 'load' })
    const labels = await view.$$eval('.blurb ul.required-tags li a > span', els => els.map(el => ({
      cls: el.className,
      label: getComputedStyle(el, '::after').content,
      hidden: getComputedStyle(el.querySelector('.text')).position,
    })))
    assert.equal(labels.length, SYMBOLS.length)
    for (const { cls, label, hidden } of labels) {
      assert.ok(label && label !== 'none', `${cls} drew nothing`)
      assert.doesNotMatch(label, /·/, `${cls} fell through to the unknown-symbol dot`)
      assert.equal(hidden, 'absolute', `${cls} should keep its full name for a screen reader, out of the way`)
    }
    // Distinct enough to tell apart at a glance, which is the point of letters.
    assert.equal(new Set(labels.map(l => `${l.cls.split(' ')[1]}:${l.label}`)).size, SYMBOLS.length)
  })

  test('the summary is not ruled off', async () => {
    await view.setContent(page(QUAD), { waitUntil: 'load' })
    const border = await view.$eval('.blurb .summary', el => getComputedStyle(el).borderTopWidth)
    assert.equal(border, '0px', 'the rule read as a divider under the caption that used to show above it')
  })
})
