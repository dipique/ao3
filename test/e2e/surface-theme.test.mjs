import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const LISTING_URL = 'https://archiveofourown.org/tags/A%20Fandom/works'

/** Marks on, so the work title carries a menu — the surface this suite measures. */
const SEED = {
  'option.workMarks': {
    enabled: true,
    marks: {
      read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: false, items: '' },
      continue: {
        icon: 'continue',
        label: 'Ongoing',
        color: '#0369a1',
        triggerAlias: 'read',
        tracksProgress: true,
        hideSearchResult: true,
        items: '',
        progress: '',
      },
      saved: { icon: 'saved', label: 'Marked for later', color: '#2f8f4e' },
    },
  },
}

/** A listing whose body background is `background` — the skin we want sampled. */
function page(background) {
  return `<!doctype html>
<html><head><title>Works</title><style>
  body { background-color: ${background}; }
  /* AO3's own skin, verbatim (1_site_screen_.css:867,882). The focus rule is
     (0,1,1) and outranks a single class, which is exactly the collision our
     field styling has to win. */
  input, textarea { width: 100%; border: 1px solid #bbb; box-shadow: inset 0 1px 2px #ccc; }
  input:focus, select:focus, textarea:focus { background: #f3efec; }
</style></head>
<body class="logged-in">
  <div id="header"><ul class="primary navigation"><li class="dropdown"></li></ul></div>
  <div id="main">
    <ol class="work index group">
      <li class="blurb work" id="work_1">
        <div class="header module">
          <h4 class="heading"><a href="/works/1">A work</a></h4>
        </div>
        <dl class="stats">
          <dt class="chapters">Chapters:</dt>
          <dd class="chapters"><a href="/works/1/navigate">4</a>/9</dd>
        </dl>
      </li>
    </ol>
  </div>
</body></html>`
}

/**
 * The floating-surface palette. The menu, the popover and the toast are the only
 * things we draw that AO3's skin doesn't reach — they're ours top to bottom — so
 * they have to follow the reader's skin explicitly. This is the suite that says
 * they actually do.
 */
describe('the floating surface palette', { skip }, () => {
  let browser
  let css
  let js

  before(async () => {
    ensureBuilt()
    css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** Load a listing on `background`, open the work menu, report what it painted. */
  const paint = async (background, seed = SEED) => {
    const tab = await browser.newPage()
    const body = page(background)
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html', body })
      else
        void req.abort()
    })
    await tab.evaluateOnNewDocument(installMock, seed)
    await tab.goto(LISTING_URL, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await sleep(1500)

    await tab.evaluate(() => {
      document.querySelector('#work_1 h4.heading a').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
      )
    })
    await sleep(250)

    const result = await tab.evaluate(() => {
      const menu = document.querySelector('.AO3E--menu')
      const style = menu ? getComputedStyle(menu) : null
      return {
        theme: document.documentElement.dataset.ao3eTheme ?? null,
        opened: !!menu,
        background: style?.backgroundColor ?? null,
        color: style?.color ?? null,
      }
    })
    await tab.close()
    return result
  }

  /** Mean channel brightness — the same measure `isDarkTheme` applies to the page. */
  const brightness = (rgb) => {
    const [r, g, b] = rgb.match(/[\d.]+/g).map(Number)
    return 0.299 * r + 0.587 * g + 0.114 * b
  }

  test('a light skin gets a light surface', async () => {
    const { theme, opened, background, color } = await paint('rgb(255, 255, 255)')
    assert.equal(theme, 'light', 'the sampled skin is light')
    assert.ok(opened, 'the menu opened')
    assert.ok(brightness(background) > 200, `menu background should be light, got ${background}`)
    assert.ok(brightness(color) < 60, `menu text should be dark, got ${color}`)
  })

  test('a dark skin gets a dark surface', async () => {
    const { theme, opened, background, color } = await paint('rgb(17, 17, 17)')
    assert.equal(theme, 'dark', 'the sampled skin is dark')
    assert.ok(opened, 'the menu opened')
    assert.ok(brightness(background) < 80, `menu background should be dark, got ${background}`)
    assert.ok(brightness(color) > 180, `menu text should be light, got ${color}`)
  })

  test('an explicit theme choice beats the skin', async () => {
    // Someone reading a light skin who picked dark in the options page: the
    // setting wins, because it is the one they chose on purpose. This is also
    // why the palette is not a `prefers-color-scheme` query — the OS has no say.
    const { theme, opened, background } = await paint('rgb(255, 255, 255)', {
      ...SEED,
      'option.theme': { chosen: 'dark', current: 'light' },
    })
    assert.equal(theme, 'dark', 'the chosen theme beats the sampled skin')
    assert.ok(opened, 'the menu opened')
    assert.ok(brightness(background) < 80, `menu background should be dark, got ${background}`)
  })
  /**
   * Open the ongoing editor on a dark skin, focus each field in turn, and read
   * back what it is actually painted — the regression this suite exists for.
   */
  const editorFields = async () => {
    const tab = await browser.newPage()
    const body = page('rgb(17, 17, 17)')
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html', body })
      else
        void req.abort()
    })
    await tab.evaluateOnNewDocument(installMock, SEED)
    await tab.goto(LISTING_URL, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await sleep(1500)

    await tab.evaluate(() => {
      document.querySelector('#work_1 h4.heading a').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
      )
    })
    await sleep(250)
    await tab.evaluate(() => {
      const row = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
        .find(el => el.querySelector('.AO3E--menu--label')?.textContent?.startsWith('Mark as ongoing'))
      row.click()
    })
    await sleep(250)

    const read = async (selector) => {
      await tab.focus(selector)
      await sleep(80)
      return tab.$eval(selector, (el) => {
        const style = getComputedStyle(el)
        return {
          background: style.backgroundColor,
          color: style.color,
          colorScheme: style.colorScheme,
          focused: document.activeElement === el,
        }
      })
    }

    const chapter = await read('.AO3E--progress-editor--chapter')
    const date = await read('.AO3E--progress-editor--date')
    await tab.close()
    return { chapter, date }
  }

  test('a focused field keeps the dark surface, against the skin focus rule', async () => {
    const { chapter, date } = await editorFields()
    for (const [name, field] of [['chapter', chapter], ['date', date]]) {
      assert.ok(field.focused, `the ${name} field took focus`)
      // #f3efec is AO3's focus background. Anything near it means the skin won.
      assert.ok(
        brightness(field.background) < 80,
        `focused ${name} field should stay dark, got ${field.background}`,
      )
      assert.ok(
        brightness(field.color) > 180,
        `focused ${name} field text should stay light, got ${field.color}`,
      )
    }
  })

  test('the fields declare a dark color-scheme, so the browser paints its own widgets to match', async () => {
    // The date field's segments and calendar panel, and the number input's
    // spinner arrows, are drawn by the browser and cannot be styled directly —
    // `color-scheme` is the only lever that reaches them.
    const { chapter, date } = await editorFields()
    assert.equal(chapter.colorScheme, 'dark', 'number input')
    assert.equal(date.colorScheme, 'dark', 'date input')
  })
})
