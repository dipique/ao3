import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { COMMENTS_CLASS } from '../../src/content_script/siteExport/workText.ts'
import { REPO_ROOT } from '../e2e/helpers.mjs'
import { loadModuleInPage, skipWithoutChrome } from './helpers.mjs'
import { comment, PAGE, THREAD, withComments } from './workPages.mjs'

/**
 * The work-text sanitizer, run in a real DOM.
 *
 * Unlike the rest of `test/e2e/`, this builds nothing but the one module under
 * test and the constant it shares, so it costs a Chrome launch and no extension
 * build. Everything it asserts is a promise the exported site depends
 * on: the reading experience survives, AO3's chrome does not, and no link is
 * left pointing at a path that only exists on archiveofourown.org.
 */

/** The real page the sanitizer was written against; absent in a standalone clone. */
const SAMPLE = join(REPO_ROOT, '..', 'html', 'work-sample', 'works', '79362971.html')

describe('sanitizeWorkPage', { skip: skipWithoutChrome }, () => {
  let close
  /** Sanitize `source` as if it were the fetched page for `workId`, with `commentPages` as the comment pages fetched. */
  let sanitize
  /** How many pages of comments `source` says the work has. */
  let pageCount

  before(async () => {
    const loaded = await loadModuleInPage('src/content_script/siteExport/sanitize.ts', 'SAN')
    close = loaded.close
    sanitize = (source, workId = '42', commentPages) => loaded.page.evaluate(
      ([html, id, pages]) => {
        const parse = text => new DOMParser().parseFromString(text, 'text/html')
        return window.SAN.sanitizeWorkPage(parse(html), id, pages?.map(parse))
      },
      [source, workId, commentPages],
    )
    pageCount = source => loaded.page.evaluate(
      html => window.SAN.commentPageCount(new DOMParser().parseFromString(html, 'text/html')),
      source,
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

  test('a scheme split by a tab or a newline is still that scheme', async () => {
    // The HTML parser decodes the entity, so what reaches the sanitizer is
    // `java\nscript:alert(3)` — which matches no pattern for `javascript:` and
    // which the URL parser, stripping tabs and newlines before it parses,
    // turns straight back into one. Hence: decide on the parsed URL.
    const html = await sanitize(PAGE)
    assert.ok(!/javascript:/i.test(html), 'expected the split javascript: href to be dropped')
    assert.ok(!/vbscript:/i.test(html), 'expected the split vbscript: href to be dropped')
    assert.match(html, /Nor this<\/a>/)
    assert.match(html, /Nor this either<\/a>/)
  })

  test('returns null when the page holds no work text', async () => {
    const login = '<html><body><div id="main"><h2 class="heading">Sign in</h2></div></body></html>'
    assert.equal(await sanitize(login), null)
  })

  describe('comments', () => {
    const section = html => html.match(new RegExp(`<div class="${COMMENTS_CLASS}">[\\s\\S]*$`))?.[0] ?? ''

    test('are left out unless they were asked for', async () => {
      const html = await sanitize(withComments(THREAD))
      assert.ok(!html.includes(COMMENTS_CLASS))
      assert.ok(!html.includes('Loved it.'))
    })

    test('follow the work, threads and replies kept as AO3 nests them', async () => {
      const page = withComments(THREAD)
      const html = await sanitize(page, '42', [page])
      const kept = section(html)
      assert.ok(html.indexOf('End notes.') < html.indexOf(COMMENTS_CLASS), 'the comments come after the work')
      assert.match(kept, /Loved it\.[\s\S]*<ol class="thread">[\s\S]*Me too\./)
      assert.match(kept, /reader1<\/a>/)
      assert.match(kept, /on Chapter 1/)
    })

    test('keep what a reader reads and drop what only works on AO3', async () => {
      const page = withComments(THREAD)
      const kept = section(await sanitize(page, '42', [page]))
      for (const gone of ['Comment Actions', '>Reply<', '>Thread<', 'add_comment_reply_placeholder', 'icon_user.png', 'pagination'])
        assert.ok(!kept.includes(gone), `expected ${JSON.stringify(gone)} to be stripped from the comments`)
      assert.match(kept, /href="https:\/\/archiveofourown\.org\/users\/reader1\/pseuds\/reader1"/)
    })

    test('run on from page to page in order, as one list', async () => {
      const first = withComments(comment(1, 'First page.'), { current: 1, pages: 2 })
      const second = withComments(comment(3, 'Second page.'), { current: 2, pages: 2 })
      const kept = section(await sanitize(first, '42', [first, second]))
      assert.equal(kept.match(/<ol class="thread">/g)?.length, 1, 'the pages are one list')
      assert.ok(kept.indexOf('First page.') < kept.indexOf('Second page.'))
    })

    test('a work with no comments has no section, though they were asked for', async () => {
      assert.ok(!(await sanitize(PAGE, '42', [PAGE])).includes(COMMENTS_CLASS))
    })

    test('are scrubbed like the work: no handlers, no scripts, no javascript: links', async () => {
      const page = withComments(comment(5, '<a href="javascript:alert(1)" onclick="alert(2)">Hi</a><script>alert(3)</script>'))
      const kept = section(await sanitize(page, '42', [page]))
      assert.ok(!/javascript:|onclick|<script/i.test(kept))
      assert.match(kept, /Hi<\/a>/)
    })

    test('count their pages from AO3\'s page list', async () => {
      assert.equal(await pageCount(withComments(THREAD)), 1)
      assert.equal(await pageCount(withComments(THREAD, { current: 1, pages: 4 })), 4)
      assert.equal(await pageCount(withComments(THREAD, { current: 3, pages: 3 })), 3)
      assert.equal(await pageCount(PAGE), 0, 'a page with no comments listed has none to fetch')
    })
  })

  test('handles the real AO3 work page it was written against', { skip: existsSync(SAMPLE) ? false : 'the saved AO3 work page is not available here' }, async () => {
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
