import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { loadModuleInPage, skipWithoutChrome } from './helpers.mjs'

/**
 * Baking the reader's find/replace rules into a cached work, which is the only
 * way they reach the exported site — nothing there runs the content script.
 *
 * The point of every case below is that the site agrees with the page: the same
 * prose is rewritten, and the same title, byline and meta block are left alone,
 * because those are what the reader's own rules and marks are keyed to.
 */

/** A cached work as the sanitizer stores it, with coffee to replace. */
const WORK = `<div class="ao3e-work" data-ao3e-work-id="42">
<dl class="work meta group">
  <dt class="freeform tags">Additional Tags:</dt>
  <dd class="freeform tags"><ul class="commas"><li><a class="tag" href="https://archiveofourown.org/tags/Coffee%20Shop%20AU/works">Coffee Shop AU</a></li></ul></dd>
</dl>
<div id="workskin">
  <div class="preface group">
    <h2 class="title heading">Coffee at Dawn</h2>
    <h3 class="byline heading"><a rel="author" href="https://archiveofourown.org/users/coffee_fan">coffee_fan</a></h3>
    <div class="summary module"><blockquote class="userstuff"><p>They drink coffee.</p></blockquote></div>
    <div class="notes module"><blockquote class="userstuff"><p>Written over one coffee.</p></blockquote></div>
  </div>
  <div id="chapters" role="article">
    <div class="userstuff module">
      <p>She sipped her coffee, then <em>more coffee</em>.</p>
      <p>I can,<em> Love….</em></p>
    </div>
  </div>
</div>
</div>`

const rule = over => ({ find: '', replace: '', ...over })
const on = rules => ({ enabled: true, rules })

describe('bakeTextReplacements', { skip: skipWithoutChrome }, () => {
  let close
  /** Bake `settings` into `html`, in the page. */
  let bake

  before(async () => {
    const loaded = await loadModuleInPage(
      'src/content_script/siteExport/bake.ts',
      'BAKE',
      { stubBrowser: true },
    )
    close = loaded.close
    bake = (html, settings) => loaded.page.evaluate(
      ([source, config]) => window.BAKE.bakeTextReplacements(source, config),
      [html, settings],
    )
  })

  after(async () => {
    await close?.()
  })

  test('rewrites the chapter text, the summary and the notes', async () => {
    const html = await bake(WORK, on([rule({ find: 'coffee', replace: 'tea' })]))
    assert.match(html, /She sipped her tea, then <em>more tea<\/em>\./)
    assert.match(html, /<p>They drink tea\.<\/p>/)
    assert.match(html, /<p>Written over one tea\.<\/p>/)
  })

  test('leaves the work\'s identity alone — title, byline and the meta block', async () => {
    const html = await bake(WORK, on([rule({ find: 'coffee', replace: 'tea' })]))
    // Case-insensitive by default, so "Coffee" in the title would have matched
    // had the title been in scope. It isn't, on the page or here.
    assert.match(html, /<h2 class="title heading">Coffee at Dawn<\/h2>/)
    assert.match(html, /coffee_fan<\/a>/)
    assert.match(html, /Coffee%20Shop%20AU/)
    assert.match(html, />Coffee Shop AU</)
  })

  test('keeps the markup it rewrites around', async () => {
    const html = await bake(WORK, on([rule({ find: 'coffee', replace: 'tea' })]))
    assert.match(html, /<div class="ao3e-work" data-ao3e-work-id="42">/)
    assert.match(html, /<div id="workskin">/)
    assert.match(html, /<blockquote class="userstuff">/)
    assert.ok(!html.includes('coffee,'), 'expected no unreplaced prose to survive')
  })

  test('applies rules in order, each seeing the last one\'s work', async () => {
    const html = await bake(WORK, on([
      rule({ find: 'coffee', replace: 'tea' }),
      rule({ find: 'tea', replace: 'cocoa' }),
    ]))
    assert.match(html, /She sipped her cocoa/)
  })

  test('honours matchCasing, wholeWord and caseSensitive as the page does', async () => {
    const cased = await bake(WORK, on([rule({ find: 'coffee', replace: 'tea', caseSensitive: true })]))
    assert.match(cased, /<h2 class="title heading">Coffee at Dawn<\/h2>/)
    assert.match(cased, /She sipped her tea/)

    const whole = await bake(WORK, on([rule({ find: 'ffee', replace: 'X', wholeWord: true })]))
    assert.match(whole, /She sipped her coffee/)
  })

  test('does not read across a change of formatting unless the rule asks', async () => {
    const kept = await bake(WORK, on([rule({ find: ', Love', replace: ', honey' })]))
    assert.match(kept, /<p>I can,<em> Love….<\/em><\/p>/)

    const crossed = await bake(WORK, on([rule({ find: ', Love', replace: ', honey', acrossFormatting: true })]))
    assert.match(crossed, /I can, honey/)
  })

  test('never reads across a paragraph, however the rule is written', async () => {
    const html = await bake(WORK, on([rule({ find: '.\n    I can', replace: 'JOINED', acrossFormatting: true })]))
    assert.ok(!html.includes('JOINED'), 'expected paragraphs to stay separate')
  })

  test('returns the html untouched when there is nothing to do', async () => {
    const settings = on([rule({ find: 'coffee', replace: 'tea' })])
    // Feature off.
    assert.equal(await bake(WORK, { ...settings, enabled: false }), WORK)
    // No rules, no active rules, a rule with no `find`.
    assert.equal(await bake(WORK, on([])), WORK)
    assert.equal(await bake(WORK, on([rule({ find: 'coffee', replace: 'tea', disabled: true })])), WORK)
    assert.equal(await bake(WORK, on([rule({ replace: 'tea' })])), WORK)
    // A rule that matches nothing in this work.
    assert.equal(await bake(WORK, on([rule({ find: 'zzzz', replace: 'tea' })])), WORK)
  })

  test('returns html with no work text in it untouched', async () => {
    const stub = '<div class="ao3e-work"><p>coffee</p></div>'
    assert.equal(await bake(stub, on([rule({ find: 'coffee', replace: 'tea' })])), stub)
  })
})
