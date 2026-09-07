import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { REPO_ROOT } from '../e2e/helpers.mjs'
import { loadModuleInPage, skipWithoutChrome } from './helpers.mjs'

/**
 * The work-text sanitizer, run in a real DOM.
 *
 * Unlike the rest of `test/e2e/`, this builds nothing but the one module under
 * test — `sanitize.ts` imports nothing — so it costs a Chrome launch and no
 * extension build. Everything it asserts is a promise the exported site depends
 * on: the reading experience survives, AO3's chrome does not, and no link is
 * left pointing at a path that only exists on archiveofourown.org.
 */

/** The real page the sanitizer was written against; absent in a standalone clone. */
const SAMPLE = join(REPO_ROOT, '..', 'html', 'work-sample', 'works', '79362971.html')

/**
 * A work page in miniature: the meta block and `#workskin` we keep, wrapped in
 * the chrome we don't (navigation with a "Mark for Later" form, the kudos and
 * comment furniture, AO3's scripts), plus the things a work's own author HTML
 * can carry — an inline handler and a `javascript:` link.
 */
const PAGE = `<!DOCTYPE html><html><head>
<title>Work</title>
<script src="/javascripts/application.js"></script>
<style>.user-1 { display: none }</style>
</head><body class="works-show logged-in">
<div id="header"><ul class="menu"><li><a href="/works/search">Search</a></li></ul></div>
<div id="main" class="works-show region">
  <ul class="work navigation actions">
    <li class="mark"><form class="button_to" method="post" action="/works/42/mark_for_later">
      <button type="submit">Mark for Later</button>
      <input type="hidden" name="authenticity_token" value="SECRET">
    </form></li>
  </ul>
  <div class="wrapper"><dl class="work meta group">
    <dt class="fandom tags">Fandom:</dt>
    <dd class="fandom tags"><ul class="commas"><li><a class="tag" href="/tags/Some%20Fandom/works">Some Fandom</a></li></ul></dd>
    <dt class="stats">Stats:</dt>
    <dd class="stats"><dl class="stats"><dt class="words">Words:</dt><dd class="words">666</dd><dt class="chapters">Chapters:</dt><dd class="chapters">2/2</dd></dl></dd>
  </dl></div>
  <div id="work-skin" class="wrapper"><div id="workskin">
    <div class="preface group">
      <h2 class="title heading">A Title</h2>
      <h3 class="byline heading"><a rel="author" href="/users/someone/pseuds/someone">someone</a></h3>
      <div class="summary module"><blockquote class="userstuff"><p>A summary.</p></blockquote></div>
    </div>
    <div id="chapters" role="article">
      <div class="chapter" id="chapter-1">
        <div class="chapter preface group"><h3 class="title"><a href="/works/42/chapters/1">Chapter 1</a></h3></div>
        <div class="userstuff module">
          <p>First chapter. <a href="#chapter-2">Skip ahead</a>, or see <a href="/works/99">that other work</a>.</p>
          <p onclick="alert(1)">Clicky.</p>
          <p><a href="javascript:alert(2)">Do not</a></p>
          <img src="/images/skins/thing.png" alt="a thing">
        </div>
      </div>
      <div class="chapter" id="chapter-2">
        <div class="userstuff module"><p>Second chapter.</p></div>
      </div>
    </div>
    <div class="afterword preface group"><div class="notes module"><blockquote class="userstuff"><p>End notes.</p></blockquote></div></div>
  </div></div>
  <div id="feedback" class="feedback">
    <form id="new_kudo" action="/kudos" method="post"><button type="submit">Kudos</button></form>
    <div id="kudos">someone left kudos</div>
    <form class="new_comment" action="/works/42/comments" method="post"><textarea name="comment[comment_content]"></textarea></form>
  </div>
</div>
<div id="footer"><p>AO3 footer</p></div>
</body></html>`

describe('sanitizeWorkPage', { skip: skipWithoutChrome }, () => {
  let close
  /** Sanitize `source` as if it were the fetched page for `workId`. */
  let sanitize

  before(async () => {
    const loaded = await loadModuleInPage('src/content_script/siteExport/sanitize.ts', 'SAN')
    close = loaded.close
    sanitize = (source, workId = '42') => loaded.page.evaluate(
      ([html, id]) => window.SAN.sanitizeWorkPage(new DOMParser().parseFromString(html, 'text/html'), id),
      [source, workId],
    )
  })

  after(async () => {
    await close?.()
  })

  test('keeps the meta block and the whole of the work skin', async () => {
    const html = await sanitize(PAGE)
    assert.match(html, /^<div class="ao3e-work" data-ao3e-work-id="42">/)
    assert.match(html, /<dl class="work meta group">/)
    assert.match(html, /<div id="workskin">/)
    for (const kept of ['A Title', 'A summary.', 'First chapter.', 'Second chapter.', 'End notes.', '<dd class="words">666</dd>'])
      assert.ok(html.includes(kept), `expected the export to keep ${JSON.stringify(kept)}`)
  })

  test('drops every script, form and control, and the chrome around the work', async () => {
    const html = await sanitize(PAGE)
    for (const gone of ['<script', '<form', '<input', '<button', '<textarea', 'authenticity_token', 'SECRET', 'Mark for Later', 'id="feedback"', 'id="kudos"', 'id="footer"', 'AO3 footer'])
      assert.ok(!html.includes(gone), `expected ${JSON.stringify(gone)} to be stripped`)
  })

  test('strips inline event handlers without losing the text they were on', async () => {
    const html = await sanitize(PAGE)
    assert.ok(!/\son[a-z]+=/i.test(html), 'expected no event-handler attributes')
    assert.match(html, /Clicky\./)
  })

  test('makes AO3 links absolute — a folder-served site has no /tags', async () => {
    const html = await sanitize(PAGE)
    assert.match(html, /href="https:\/\/archiveofourown\.org\/tags\/Some%20Fandom\/works"/)
    assert.match(html, /href="https:\/\/archiveofourown\.org\/works\/99"/)
    assert.match(html, /src="https:\/\/archiveofourown\.org\/images\/skins\/thing\.png"/)
    assert.ok(!/(?:href|src)="\/[a-z]/i.test(html), 'expected no site-relative URLs to survive')
  })

  test('leaves the work\'s own fragment links alone — they still work offline', async () => {
    const html = await sanitize(PAGE)
    assert.match(html, /href="#chapter-2"/)
  })

  test('removes a javascript: link rather than carrying it into the export', async () => {
    const html = await sanitize(PAGE)
    assert.ok(!html.includes('javascript:'), 'expected the javascript: href to be dropped')
    assert.match(html, /Do not<\/a>/)
  })

  test('returns null when the page holds no work text', async () => {
    const login = '<html><body><div id="main"><h2 class="heading">Sign in</h2></div></body></html>'
    assert.equal(await sanitize(login), null)
  })

  test('handles the real AO3 work page it was written against', { skip: existsSync(SAMPLE) ? false : 'html/work-sample not present (standalone clone)' }, async () => {
    const html = await sanitize(await readFile(SAMPLE, 'utf8'), '79362971')
    assert.match(html, /<div id="workskin">/)
    assert.match(html, /Take A Bite/)
    assert.match(html, /A spritz of luke warm water/)
    for (const gone of ['<script', '<form', '<input', 'authenticity_token'])
      assert.ok(!html.includes(gone), `expected ${JSON.stringify(gone)} to be stripped`)
    // The page is mostly chrome: what's worth keeping is a fraction of its size.
    assert.ok(html.length < 12_000, `expected a lean extract, got ${html.length} bytes`)
  })
})
