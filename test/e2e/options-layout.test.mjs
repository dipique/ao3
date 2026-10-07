import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { storedLists } from './helpers.mjs'
import { scriptBackground, skip, startOptions, stubArchive, until } from './optionsPage.mjs'

const WIDTHS = [1440, 1024, 768, 390]
const THEMES = ['light', 'dark']

/** A plain switch row, outside any group. */
const PLAIN_ROW = 'page-controls-reveal-filtered-works'
/** A row inside the master group's bracket. */
const GROUPED_ROW = 'link-menus-menu-on-tags'
/** A switch that reveals more, seeded on so its inset shows. */
const INSET_ROW = 'filter-defaults-default-language'
/** A tracked list with a long title and a filter, and a stored list no visit has described, under its long raw key. */
const LONG = {
  id: 'l0ng',
  kind: 'works-filter',
  url: '/works?work_search[complete]=T&work_search[words_from]=50000&tag_id=Marvel+Cinematic+Universe',
  title: 'Everything long and finished in the Marvel Cinematic Universe, gen and otherwise',
  type: 'fandom',
  entity: 'Marvel Cinematic Universe',
}
const UNDESCRIBED = 'tag-works:A%20Very%20Long%20Uncommon%20Tag%20Name%20Nobody%20Opened%20Since'
const SEED = {
  'option.searchLanguage': { enabled: true, language: null },
  'option.trackedLists': { enabled: true, target: 40, reviewedThrough: 0, lists: [{ id: LONG.id, kind: LONG.kind, url: LONG.url, alias: LONG.title, type: LONG.type, entity: LONG.entity, tracked: true, since: 20000 }] },
  'option.savedLists': { v: 1, lists: { [LONG.id]: LONG } },
  ...storedLists({ [UNDESCRIBED]: { scrapedAt: Date.now() - 3600_000, blurbsHtml: ['<li class="work blurb group" id="work_9" role="article"><h4 class="heading"><a href="/works/9">Work 9</a></h4></li>'] } }),
}

/** What inside the saved lists' frame reaches past its right edge, which the frame would cut off. */
function savedListsOverflow() {
  const frame = document.querySelector('[data-list="saved-lists"]')
  const edge = frame.getBoundingClientRect().right
  return [...frame.querySelectorAll('*')]
    .filter(el => el.checkVisibility() && el.getBoundingClientRect().right > edge + 0.5)
    .map(el => `${el.tagName.toLowerCase()}.${el.className} reaches ${Math.round(el.getBoundingClientRect().right)} px, past ${Math.round(edge)} px`)
}
/** A row whose control is two buttons, too wide to sit beside the text in a phone's width. */
const WIDE_CONTROL_ROW = 'your-data-import-export-your-settings'

/** The title, description and control of a settings row, and its inset panel if it has one, as rounded boxes. */
function rowBoxes(id) {
  const row = document.getElementById(id)
  const box = (el) => {
    if (!el || !el.checkVisibility())
      return null
    const { top, bottom, left, right, width } = el.getBoundingClientRect()
    return { top: Math.round(top), bottom: Math.round(bottom), left: Math.round(left), right: Math.round(right), width: Math.round(width) }
  }
  const part = name => box(row.querySelector(`[data-row-part="${name}"]`))
  return { title: part('title'), description: part('description'), control: part('control'), inset: box(row.querySelector('[data-row-inset]')) }
}

/** A colour token as `getComputedStyle` writes a colour. */
function token(name) {
  const [r, g, b] = getComputedStyle(document.body).getPropertyValue(`--color-${name}`).trim().split(/\s+/)
  return `rgb(${r}, ${g}, ${b})`
}

/**
 * The page's frame at the widths it is drawn for, in both themes: one category
 * in the pane, the rail beside it or, below 768 px, a row of chips over it, the
 * foot's wrapping text spaced to be read, and nothing wider than the window.
 *
 * And the settings row: from 1024 px its title, description and control side
 * by side, in a 264 px title column and, from 1280 px, a control column of at
 * least 180 px (narrower, the control column is only as wide as its control);
 * narrower still, the description under the title with the control beside both, or
 * under them where it is too wide to leave the text room. Rows are parted by
 * `hair` lines, and what a switch reveals sits in a `sunken` inset across the
 * whole row.
 */
describe('options UI — layout', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test(`${width} px, ${theme}`, async () => {
        const options = await session.open({ viewport: { width, height: 900 }, theme, seed: SEED })
        const noSidewaysScroll = async () => {
          const { scrollWidth, innerWidth } = await options.page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
          }))
          assert.ok(scrollWidth <= innerWidth, `the page is ${scrollWidth} px wide in a ${innerWidth} px window`)
        }
        try {
          assert.equal(await options.page.evaluate(() => document.body.classList.contains('dark') ? 'dark' : 'light'), theme)

          assert.equal((await options.shownCategories()).length, 1, 'one category in the pane')

          const links = await (await options.rail()).$$eval('[data-rail-item="category"]', els => els
            .filter(el => el.checkVisibility())
            .map((el) => {
              const { top, left } = el.getBoundingClientRect()
              return { top: Math.round(top), left: Math.round(left) }
            }))
          assert.equal(links.length, 6, 'every category is on the rail')
          const tops = new Set(links.map(link => link.top))
          const lefts = new Set(links.map(link => link.left))
          if (width < 768) {
            assert.equal(tops.size, 1, `a single row of chips: ${JSON.stringify(links)}`)
          }
          else {
            assert.equal(lefts.size, 1, `a column down the rail: ${JSON.stringify(links)}`)
            assert.equal(tops.size, links.length, `a column down the rail: ${JSON.stringify(links)}`)
          }

          const foot = await options.page.$$eval('footer p', els => els
            .filter(el => el.checkVisibility())
            .map((el) => {
              const style = getComputedStyle(el)
              return { size: Number.parseFloat(style.fontSize), leading: Number.parseFloat(style.lineHeight) }
            }))
          assert.ok(foot.length, 'the foot is on the page')
          for (const { size, leading } of foot)
            assert.ok(leading >= size * 1.3, `the foot's lines are ${leading} px apart for ${size} px text`)

          await noSidewaysScroll()

          const { title, description, control } = await options.page.evaluate(rowBoxes, PLAIN_ROW)
          const layout = JSON.stringify({ title, description, control })
          assert.ok(title && description && control, `the row's parts: ${layout}`)
          if (width >= 1024) {
            assert.equal(title.width, 264, `a 264 px title column: ${layout}`)
            if (width >= 1280)
              assert.ok(control.width >= 180, `a control column of at least 180 px: ${layout}`)
            else
              assert.ok(description.width >= 20 * 16, `the description takes the room its switch doesn't need: ${layout}`)
            assert.ok(title.right < description.left && description.right < control.left, `title, description and control side by side: ${layout}`)
            assert.ok(Math.abs(title.top - description.top) <= 2, `the description beside the title: ${layout}`)

            const grouped = await options.page.evaluate(rowBoxes, GROUPED_ROW)
            assert.equal(grouped.description.left, description.left, 'a grouped row\'s description lines up with the rows outside the group')
            assert.equal(grouped.control.right, control.right, 'and so does its control')
          }
          else {
            assert.equal(description.left, title.left, `the description under the title: ${layout}`)
            assert.ok(description.top >= title.bottom - 1, `the description under the title: ${layout}`)
            assert.ok(control.left >= Math.max(title.right, description.right), `the control beside both: ${layout}`)
          }

          const separator = await options.page.evaluate((id) => {
            const style = getComputedStyle(document.getElementById(id))
            return { width: style.borderTopWidth, style: style.borderTopStyle, color: style.borderTopColor }
          }, PLAIN_ROW)
          assert.deepEqual(separator, { width: '1px', style: 'solid', color: await options.page.evaluate(token, 'hair') }, 'a hair line between rows')

          await options.goTo('#filter-defaults')
          const revealed = await options.page.evaluate(rowBoxes, INSET_ROW)
          assert.ok(revealed.inset, `the inset shows: ${JSON.stringify(revealed)}`)
          assert.equal(revealed.inset.left, revealed.title.left, `the inset starts at the row's left edge: ${JSON.stringify(revealed)}`)
          assert.equal(revealed.inset.right, revealed.control.right, `and ends at its right edge: ${JSON.stringify(revealed)}`)
          assert.ok(revealed.inset.top >= Math.max(revealed.description.bottom, revealed.control.bottom), `below the row: ${JSON.stringify(revealed)}`)
          const insetColour = await options.page.evaluate(id => getComputedStyle(document.getElementById(id).querySelector('[data-row-inset]')).backgroundColor, INSET_ROW)
          assert.equal(insetColour, await options.page.evaluate(token, 'sunken'), 'the inset is sunken')

          await noSidewaysScroll()

          await options.goTo('#advanced')
          const wide = await options.page.evaluate(rowBoxes, WIDE_CONTROL_ROW)
          const wideLayout = JSON.stringify(wide)
          if (width < 768) {
            assert.ok(wide.control.top >= wide.description.bottom, `a wide control drops under the text: ${wideLayout}`)
            assert.ok(wide.title.width >= 13 * 16, `leaving the text its width: ${wideLayout}`)
          }
          else {
            assert.ok(wide.control.left >= wide.description.right, `a wide control beside the text: ${wideLayout}`)
          }
          if (width >= 1024) {
            for (const [category, name] of [['advanced', 'Advanced'], ['lists', 'Lists']]) {
              await options.goTo(`#${category}`)
              const narrowest = await options.page.$$eval(`[data-category="${category}"] [data-row-part="description"]`, els => Math.min(...els
                .filter(el => el.checkVisibility())
                .map(el => el.getBoundingClientRect().width)))
              assert.ok(narrowest >= 10 * 16, `every description in ${name}, beside its wide controls, keeps 10rem: the narrowest is ${narrowest} px`)
            }
          }

          await noSidewaysScroll()

          // The saved lists, with a row's details open: nothing past the frame, and the frame inside the window.
          await options.goTo('#saved-lists')
          await until('the rows to be drawn', async () => (await options.savedListIds()).length === 2)
          await options.savedListDetails(LONG.id)
          await options.savedListDetails(`copy:${UNDESCRIBED}`)
          assert.deepEqual(await options.page.evaluate(savedListsOverflow), [])
          await noSidewaysScroll()
        }
        finally {
          await options.close()
        }
      })
    }
  }
})

const CATEGORIES = ['site-features-appearance', 'search', 'lists', 'reading', 'sync-backups', 'advanced']

/** What a touch or a press acts on. */
const CONTROLS = 'button, a[href], [role="switch"], [role="radio"], [role="checkbox"], [role="combobox"], [role="tab"], select'

/**
 * The controls in view that don't answer a touch anywhere in a 44 px square
 * around them, each brought to the middle of the window first. The square's
 * middle must be the control itself, and its edges the control, its label, or
 * whatever else is drawn there (another control, or words), never the bare
 * ground a hit area missing or cut off would leave. A link in running text is
 * left out, as WCAG leaves it out; so is a text field, which a touch only puts
 * the caret in, and which spans its row.
 */
function smallTargets(controls) {
  const found = []
  const owner = el => el?.closest(`${controls}, input, textarea`)
  const drawn = el => [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
  for (const el of document.querySelectorAll(`header ${controls.replaceAll(', ', ', header ')}, [data-rail] ${controls.replaceAll(', ', ', [data-rail] ')}, main ${controls.replaceAll(', ', ', main ')}`)) {
    if (!el.checkVisibility() || el.closest('[aria-hidden="true"], [inert]'))
      continue
    if (el.matches('a') && [...el.parentElement.childNodes].some(node => node !== el && node.textContent.trim()) && el.closest('p'))
      continue
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
    const { left, top, width, height } = el.getBoundingClientRect()
    const [x, y] = [left + width / 2, top + height / 2]
    const [reachX, reachY] = [Math.max(width, 44) / 2 - 1, Math.max(height, 44) / 2 - 1]
    const answers = (px, py) => {
      const hit = document.elementFromPoint(px, py)
      return !!hit && (el.contains(hit) || [...el.labels ?? []].some(label => label.contains(hit)) || !!owner(hit) || drawn(hit))
    }
    const centre = document.elementFromPoint(x, y)
    const own = !!centre && (el.contains(centre) || owner(centre) === el)
    const edges = [[x - reachX, y], [x + reachX, y], [x, y - reachY], [x, y + reachY]].every(([px, py]) => answers(px, py))
    if (!own || !edges)
      found.push(`${el.getAttribute('aria-label') ?? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)} (${Math.round(width)}×${Math.round(height)}${own ? '' : ', covered'}) in #${el.closest('[id]')?.id}`)
  }
  return found
}

/**
 * Below 768 px, where the page is touched, every control answers a touch
 * anywhere in a 44 px square around it.
 */
describe('options UI — touch targets below 768 px', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  for (const category of CATEGORIES) {
    test(category, async () => {
      const options = await session.open({ viewport: { width: 390, height: 844 }, hash: `#${category}`, seed: SEED })
      try {
        if (category === 'lists') {
          await until('the rows to be drawn', async () => (await options.savedListIds()).length === 2)
          await options.savedListDetails(LONG.id)
        }
        await options.calm()
        assert.deepEqual(await options.page.evaluate(smallTargets, CONTROLS), [])
      }
      finally {
        await options.close()
      }
    })
  }
})

/**
 * What an element and its nearest ancestors draw that a focus ring could be:
 * an outline, a shadow, a border or a ground. Runs in the page.
 */
function focusLook(el) {
  const looks = []
  for (let at = el, depth = 0; at && depth < 4; at = at.parentElement, depth++) {
    const style = getComputedStyle(at)
    looks.push([style.outlineStyle === 'none' ? 'none' : `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`, style.boxShadow, style.borderColor, style.backgroundColor].join('|'))
  }
  return looks.join('/')
}

/** What the focused element is, for a failure to name it. Runs in the page. */
function describeFocus(el) {
  return `${el.getAttribute('aria-label') ?? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)} <${el.tagName.toLowerCase()}> in #${el.closest('[id]')?.id}`
}

/**
 * Every place the keyboard reaches shows that it has the focus: tabbed to, the
 * control or what holds it draws something it doesn't draw once the focus has
 * gone.
 */
describe('options UI — focus rings', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  for (const theme of THEMES) {
    for (const category of CATEGORIES) {
      test(`${category}, ${theme}`, async () => {
        const options = await session.open({
          viewport: { width: 1440, height: 900 },
          hash: `#${category}`,
          theme,
          seed: SEED,
          prepare: page => page.evaluateOnNewDocument(scriptBackground, { listBackups: [{ key: 'backup.1', createdAt: Date.now(), date: '2026-09-08', kind: 'daily', label: 'Today' }] }),
        })
        const { page } = options
        try {
          if (category === 'lists')
            await until('the rows to be drawn', async () => (await options.savedListIds()).length === 2)
          if (category === 'sync-backups')
            await until('the backups to be listed', async () => (await options.listRows('backups')).length === 1)
          await options.calm()
          const reached = new Set()
          const unmarked = []
          // From the top of the page, as a reader starting out with the keyboard would.
          await page.keyboard.press('Shift')
          await page.evaluate(() => document.querySelector('header input').focus())
          for (let first = true; ; first = false) {
            if (!first)
              await page.keyboard.press('Tab')
            const focused = await page.evaluateHandle(() => document.activeElement)
            if (await focused.evaluate(el => el === document.body) || reached.has(await focused.evaluate(describeFocus)))
              break
            reached.add(await focused.evaluate(describeFocus))
            const look = await focused.evaluate(focusLook)
            await focused.evaluate(el => el.blur())
            if (await focused.evaluate(focusLook) === look)
              unmarked.push(await focused.evaluate(describeFocus))
            await focused.evaluate(el => el.focus())
          }
          assert.ok(reached.size > 5, `the keyboard reached ${reached.size} places: ${[...reached].join('; ')}`)
          assert.deepEqual(unmarked, [])
        }
        finally {
          await options.close()
        }
      })
    }
  }
})

/**
 * With Extension theme on *AO3*, the page is drawn in the theme AO3 resolved
 * to, tokens and all, at every width.
 */
describe('options UI — following AO3\'s theme', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  for (const theme of THEMES) {
    test(`AO3 resolving to ${theme}`, async () => {
      for (const width of WIDTHS) {
        const options = await session.open({ viewport: { width, height: 900 }, seed: { ...SEED, 'option.theme': { chosen: 'inherit', current: theme } } })
        try {
          assert.equal(await options.page.evaluate(() => document.body.classList.contains('dark') ? 'dark' : 'light'), theme, `${width} px`)
          assert.deepEqual(await options.token('default'), theme === 'dark' ? [9, 9, 11] : [255, 255, 255], `${width} px`)
          assert.deepEqual(await options.colour(await options.page.$('body'), 'backgroundColor'), await options.token('default'), `the ground follows, at ${width} px`)
        }
        finally {
          await options.close()
        }
      }
    })
  }
})

/**
 * On a phone the matcher wraps under the rule's value, and AO3's suggestions
 * open right under the value, above the matcher, so they read as the field's.
 */
describe('options UI — the rule editor on a phone', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  test('suggestions open under the value, above the matcher', async () => {
    const options = await session.open({
      viewport: { width: 390, height: 844 },
      hash: '#customize-search-results-rules',
      seed: { 'option.rules': { enabled: true, filters: [], colors: {} } },
      prepare: page => stubArchive(page, () => ({ json: ['Harry Potter', 'Harry Potter (Character)'].map(name => ({ id: name, name })) })),
    })
    try {
      await options.press(await options.control(await options.list('rules'), 'button', 'Add a rule'))
      const dialog = await options.page.waitForSelector('[role="dialog"]')
      await options.press(await options.control(await options.control(dialog, 'radiogroup', 'What the rule matches'), 'radio', 'Character'))
      const field = await options.control(dialog, 'combobox')
      await field.type('harry')
      await options.page.waitForSelector('[role="dialog"] [data-suggest="names"]')
      const boxes = await options.page.evaluate(() => {
        const box = (el) => {
          const { top, bottom, left, right } = el.getBoundingClientRect()
          return { top: Math.round(top), bottom: Math.round(bottom), left: Math.round(left), right: Math.round(right) }
        }
        const dialog = document.querySelector('[role="dialog"]')
        return {
          field: box(dialog.querySelector('[role="combobox"]')),
          suggestions: box(dialog.querySelector('[data-suggest]')),
          matcher: box(dialog.querySelector('[aria-label="How to match"]')),
        }
      })
      assert.ok(boxes.matcher.top >= boxes.field.bottom, `the matcher wraps under the value at this width: ${JSON.stringify(boxes)}`)
      assert.ok(boxes.suggestions.top >= boxes.field.bottom && boxes.suggestions.top - boxes.field.bottom < 12, `the suggestions open right under the value: ${JSON.stringify(boxes)}`)
      assert.ok(boxes.suggestions.bottom <= boxes.matcher.top, `above the matcher: ${JSON.stringify(boxes)}`)
    }
    finally {
      await options.close()
    }
  })
})
