import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { loadModuleInPage, skipWithoutChrome } from '../siteExport/helpers.mjs'

/**
 * Taking a blurb back to AO3's markup: what the extension put on it goes, and
 * what AO3 put there stays — and a blurb that carries nothing of ours comes out
 * costing no more memory than it went in, since an export strips every one of
 * its blurbs, and keeps them all, on every open.
 */

/** A blurb with a tag list long enough that its elements outnumber its text. */
function blurb(id, tags = 30) {
  const items = Array.from({ length: tags }, (_, i) => `<li><a class="tag" href="https://archiveofourown.org/tags/Tag%20${i}/works">Tag ${i}</a></li>`).join('\n')
  return `<li id="work_${id}" class="work blurb group" role="article">
  <div class="header module">
    <h4 class="heading"><a href="https://archiveofourown.org/works/${id}">Work ${id}</a> by <a rel="author" href="https://archiveofourown.org/users/someone">someone</a></h4>
    <ul class="required-tags"><li><a class="help symbol question modal" title="Symbols key" href="/help/symbols-key.html"><span class="rating-general-audience rating" title="General Audiences"><span class="text">General Audiences</span></span></a></li></ul>
  </div>
  <ul class="tags commas">${items}</ul>
  <blockquote class="userstuff summary"><p>A summary.</p></blockquote>
  <dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd><dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd></dl>
</li>`
}

describe('pristineBlurb', { skip: skipWithoutChrome }, () => {
  let page
  let close
  let cdp

  before(async () => {
    ({ page, close } = await loadModuleInPage('src/content_script/searchView/pristine.ts', 'Pristine', { stubBrowser: true }))
    cdp = await page.createCDPSession()
  })

  after(() => close?.())

  test('takes off our classes, data attributes and colours, and leaves AO3\'s', async () => {
    const out = await page.evaluate(() => {
      const t = document.createElement('template')
      t.innerHTML = `<li class="work blurb AO3E--hidden" data-ao3e-work="1" data-id="7">
        <a class="tag AO3E--tag-highlight" style="--ao3e-highlight: red; color: blue" data-ao3e-rule="x" href="/tags/T">T</a>
        <span class="AO3E" style="--ao3e-x: 1">ours</span>
        <h4 class="AO3E--only" style="--ao3e-y: 2">heading</h4>
        <p style="margin: 0">kept</p>
      </li>`
      const li = window.Pristine.pristineBlurb(t.content.firstElementChild, { inPlace: true })
      return li.outerHTML.replace(/\s+/g, ' ')
    })
    assert.equal(out, '<li class="work blurb" data-id="7"> <a class="tag" style="color: blue;" href="/tags/T">T</a> <h4>heading</h4> <p style="margin: 0">kept</p> </li>')
  })

  test('the readings block a list keeps loses its form and keeps the history entry\'s id', async () => {
    const out = await page.evaluate(() => {
      const t = document.createElement('template')
      t.innerHTML = `<li id="work_5" class="reading work blurb group"><div class="header module"></div><div class="user module group">
        <h4 class="viewed heading"><span>Last visited:</span> 17 Nov 2026</h4>
        <ul class="actions"><li><form class="ajax-remove" action="/users/me/readings/4242" method="post"><input type="hidden" name="authenticity_token" value="SECRET"><input type="hidden" name="reading" value="4242"></form></li></ul>
      </div></li>`
      const li = t.content.firstElementChild
      return { ctx: window.Pristine.normalizeBlurb(li), li: li.outerHTML }
    })
    assert.match(out.ctx, /^<div class="user module group" data-reading="4242">/)
    assert.doesNotMatch(out.ctx, /SECRET|<form/)
    assert.doesNotMatch(out.li, /user module/)
  })

  test('a copy is stripped, and the blurb it was taken from is left as it was', async () => {
    const out = await page.evaluate(() => {
      const t = document.createElement('template')
      t.innerHTML = '<li class="work AO3E--hidden" data-ao3e-work="1"><a class="AO3E--x">t</a></li>'
      const li = t.content.firstElementChild
      const copy = window.Pristine.pristineBlurb(li)
      return { copy: copy.outerHTML, original: li.outerHTML }
    })
    assert.equal(out.copy, '<li class="work"><a>t</a></li>')
    assert.equal(out.original, '<li class="work AO3E--hidden" data-ao3e-work="1"><a class="AO3E--x">t</a></li>')
  })

  test('stripping blurbs that carry nothing of ours adds next to nothing to what their elements cost', async () => {
    const markup = Array.from({ length: 600 }, (_, i) => blurb(i + 1))
    const embedder = async () => {
      await cdp.send('HeapProfiler.collectGarbage')
      return (await cdp.send('Runtime.getHeapUsage')).embedderHeapUsedSize
    }

    const empty = await embedder()
    await page.evaluate((html) => {
      const t = document.createElement('template')
      window.kept = html.map((one) => {
        t.innerHTML = one
        return document.adoptNode(t.content.firstElementChild)
      })
    }, markup)
    const parsed = await embedder()
    await page.evaluate(() => window.kept.forEach(li => window.Pristine.pristineBlurb(li, { inPlace: true })))
    const stripped = await embedder()

    const elements = parsed - empty
    const added = stripped - parsed
    assert.ok(elements > 0, 'the parsed blurbs are measured')
    assert.ok(added < elements / 10, `stripping added ${added} bytes to elements costing ${elements}`)
  })
})
