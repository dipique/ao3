import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { DIST, ensureBuilt, installMock, launch } from './helpers.mjs'
import { chromePath, skip, startOptions, until } from './optionsPage.mjs'
import { settled } from './trackedPages.mjs'

const RULES = {
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [
      { target: 'f', value: 'Hidden Fandom', matcher: 'exact', behavior: 'collapse' },
      { target: 'F', value: 'angst', matcher: 'contains', behavior: 'hide' },
      { target: 'F', value: '^fluff', matcher: 'regex', behavior: 'invert' },
      // Only colours the tag: never weighed for hiding, so never counted.
      { target: 'F', value: 'Pretty', matcher: 'exact', behavior: 'highlight' },
    ],
  },
}

function blurb(id, fandom, tag) {
  return `
    <li class="blurb work" id="b${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">Work ${id}</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="/tags/x/works">${fandom}</a></h5>
      </div>
      <ul class="tags commas"><li class="freeforms"><a class="tag" href="/tags/y/works">${tag}</a></li></ul>
    </li>`
}

const PAGE = `
<div id="main">
  <ol class="work index group">
    ${blurb(1, 'Hidden Fandom', 'Pretty')}
    ${blurb(2, 'A Fandom', 'Angst')}
    ${blurb(3, 'A Fandom', 'Fluff')}
  </ol>
</div>
`

/**
 * A listing page weighs the reader's rules against its works once per run, and
 * hands the background one record of how long that took: how many works, how
 * many of the rules able to hide a work, how those match, and the time split
 * between matching and changing the page.
 */
describe('rule timings — a listing page records its pass', { skip }, () => {
  let browser
  let page

  before(async () => {
    ensureBuilt()
    const css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    const js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    browser = await launch(chromePath)
    page = await browser.newPage()
    await page.goto('about:blank')
    await page.evaluate(installMock, RULES)
    await page.evaluate(() => {
      window.__sent = []
      browser.runtime.sendMessage = async (message) => {
        window.__sent.push(JSON.parse(JSON.stringify(message)))
      }
    })
    await page.evaluate((html) => {
      document.body.innerHTML = html
    }, PAGE)
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await settled(page)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  test('sends one record of the page\'s works and the rules weighed against them', async () => {
    const sent = () => page.evaluate(() => window.__sent.filter(m => 'recordRuleTiming' in m).map(m => m.recordRuleTiming[0]))
    await until('a rule timing to be sent', async () => (await sent()).length > 0)
    const records = await sent()
    assert.equal(records.length, 1)
    const [record] = records
    assert.equal(record.where, 'page')
    assert.equal(record.works, 3)
    assert.equal(record.rules, 3)
    assert.deepEqual(record.matchers, { exact: 1, contains: 1, regex: 1 })
    assert.ok(Math.abs(record.at - Date.now()) < 60_000, 'stamped with when it ran')
    for (const key of ['ms', 'matchMs', 'pageMs'])
      assert.ok(record[key] >= 0, `${key} is a duration`)
    assert.ok(record.matchMs + record.pageMs <= record.ms, 'matching and page changes are parts of the whole pass')
  })
})

/** The foot of the options page sums up the stored record. */
describe('rule timings — the options page sums them up', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(async () => {
    await session?.close()
  })

  const text = options => options.page.$eval('[data-rule-timings]', el => [...el.querySelectorAll('p')].map(p => p.textContent.trim()))

  test('says when nothing is recorded yet', async () => {
    const options = await session.open()
    assert.deepEqual(await text(options), ['No ruleset evaluations recorded yet.'])
    await options.page.close()
  })

  test('counts the evaluations and works, with the time per 100 works and the split under it', async () => {
    const now = Date.now()
    const entry = props => ({ at: now, where: 'page', works: 100, rules: 4, matchers: { exact: 2, contains: 1, regex: 1 }, ms: 0.5, matchMs: 0.2, pageMs: 0.1, ...props })
    const options = await session.open({ seed: { 'cache.ruleTimings': [entry(), entry({ at: now - 60_000, works: 300, ms: 1.5, matchMs: 1.4, pageMs: undefined, where: 'list', rules: 6, matchers: { exact: 6, contains: 0, regex: 0 } })] } })
    assert.deepEqual(await text(options), [
      '2 ruleset evaluations in the last seven days on 400 total works. Average time to process ruleset: 0.50ms/100 items for 5.0 average rules.',
      'Matching rules: 0.40ms/100 items. Changing AO3 listing pages: 0.10ms/100 items. Rules by match type, on average: 4.0 exact, 0.5 contains, 0.5 regex.',
    ])
    assert.deepEqual(options.problems(), [])
    await options.page.close()
  })
})
