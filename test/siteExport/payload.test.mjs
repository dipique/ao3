import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// Node strips the TS types on import; payload.ts imports nothing at runtime —
// the shell, the manifest and the link rewrite are plain functions over plain
// data — so it loads under a plain `node --test` with no build and no DOM.
import {
  buildManifest,
  escapeHtml,
  rewriteWorkLinks,
  scriptJson,
  SITE_APP_ID,
  SITE_DATA_ID,
  SITE_SCHEMA_VERSION,
  SITE_SHELL_ID,
  siteHtml,
  siteShellHead,
  siteShellTail,
  statusFor,
  workHash,
} from '../../src/content_script/siteExport/payload.ts'

const BUNDLE = {
  app: { size: 17, crc: 1234, b64: 'Y29uc29sZS5sb2coImFwcCIp' },
  loader: 'console.log("loader")',
  css: '.ao3e-site{color:red}',
}

/** A manifest input with nothing interesting in it, for overriding one field at a time. */
function input(over = {}) {
  return {
    generatedAt: Date.UTC(2026, 8, 7, 14, 51, 2),
    source: { id: 'marked-for-later', label: 'Marked for Later — tester', listUrl: 'https://archiveofourown.org/users/tester/readings?show=to-read' },
    scrapedAt: Date.UTC(2026, 8, 7, 11, 0, 0),
    listCount: 0,
    works: [],
    textReplacementsBaked: false,
    ...over,
  }
}

const work = (id, status, over = {}) => ({ id, status, ...over })

describe('siteExport/payload — statusFor', () => {
  test('text in hand is `cached`, whatever the entry says', () => {
    assert.equal(statusFor(undefined, true), 'cached')
    assert.equal(statusFor({ size: 36_000 }, true), 'cached')
  })

  test('a failed refresh over a copy that still exists reads as `cached`', () => {
    // The copy is real and readable; the failure only says the last *refresh*
    // didn't land. Better an older chapter count than a work the site refuses.
    assert.equal(statusFor({ failure: 'http 500', size: 36_000 }, true), 'cached')
    assert.equal(statusFor({ failure: 'restricted' }, true), 'cached')
  })

  test('no text and no failure is a work nobody has fetched yet', () => {
    assert.equal(statusFor(undefined, false), 'uncached')
    assert.equal(statusFor({}, false), 'uncached')
    assert.equal(statusFor({ size: 0 }, false), 'uncached')
  })

  test('the two failures a reader can act on keep their names', () => {
    assert.equal(statusFor({ failure: 'restricted' }, false), 'restricted')
    assert.equal(statusFor({ failure: 'notfound' }, false), 'notfound')
  })

  test('every other failure collapses to `error`', () => {
    for (const failure of ['http 500', 'network', 'aborted', 'too big'])
      assert.equal(statusFor({ failure }, false), 'error')
  })
})

describe('siteExport/payload — buildManifest', () => {
  test('carries the schema version, not the snapshot\'s or the sanitizer\'s', () => {
    assert.equal(buildManifest(input()).v, SITE_SCHEMA_VERSION)
    assert.equal(SITE_SCHEMA_VERSION, 2)
  })

  test('counts every status, and names the ones that scored zero', () => {
    const manifest = buildManifest(input({
      works: [
        work('11', 'cached', { size: 36_000, fetchedAt: 1 }),
        work('12', 'cached', { size: 12_000, fetchedAt: 2 }),
        work('13', 'restricted'),
        work('14', 'error'),
        work('15', 'uncached'),
      ],
    }))
    // Every key is present at zero, so a reader of the manifest never has to
    // tell "none of these" from "this build didn't say".
    assert.deepEqual(manifest.counts, { total: 5, cached: 2, restricted: 1, notfound: 0, error: 1, uncached: 1 })
  })

  test('an empty list still accounts for itself', () => {
    assert.deepEqual(buildManifest(input()).counts, { total: 0, cached: 0, restricted: 0, notfound: 0, error: 0, uncached: 0 })
  })

  test('`list.count` is the stored list, which is not `works.length`', () => {
    // A blurb that failed to parse, or a work listed twice, is in the list and
    // not in the works — the manifest reports both numbers rather than one.
    const manifest = buildManifest(input({ listCount: 7, works: [work('11', 'cached'), work('12', 'uncached')] }))
    assert.equal(manifest.list.count, 7)
    assert.equal(manifest.counts.total, 2)
  })

  test('passes the source, the timestamps and the baking flag through unchanged', () => {
    const from = input({ listCount: 2, works: [work('11', 'cached')], textReplacementsBaked: true })
    const manifest = buildManifest(from)
    assert.deepEqual(manifest.source, from.source)
    assert.equal(manifest.generatedAt, from.generatedAt)
    assert.equal(manifest.list.scrapedAt, from.scrapedAt)
    assert.equal(manifest.textReplacementsBaked, true)
  })

  test('keeps the works in list order, with what each one recorded', () => {
    const works = [work('13', 'cached', { size: 9, fetchedAt: 3 }), work('11', 'uncached'), work('12', 'notfound')]
    const manifest = buildManifest(input({ works }))
    assert.deepEqual(manifest.works.map(w => w.id), ['13', '11', '12'])
    assert.deepEqual(manifest.works[0], { id: '13', status: 'cached', size: 9, fetchedAt: 3 })
    // Nothing invented for the works that have no copy behind them.
    assert.deepEqual(manifest.works[1], { id: '11', status: 'uncached' })
  })

  test('is JSON with no cycles and nothing exotic in it', () => {
    const manifest = buildManifest(input({ listCount: 1, works: [work('11', 'cached', { size: 1, fetchedAt: 2 })] }))
    assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest)
  })
})

describe('siteExport/payload — scriptJson', () => {
  test('leaves no `</script>` to end the block early', () => {
    const json = scriptJson({ html: '<p>one</p><script>evil()</script>' })
    assert.ok(!json.includes('<'))
    assert.equal(JSON.parse(json).html, '<p>one</p><script>evil()</script>')
  })

  test('escapes every `<`, wherever it sits', () => {
    // Inside a string, inside a key, anywhere: the HTML tokenizer doesn't care
    // which, so neither does this.
    const json = scriptJson({ '<key>': ['<a>', { '<deep>': '<b>' }] })
    assert.equal((json.match(/\\u003c/g) ?? []).length, 4)
    assert.ok(!json.includes('<'))
  })

  test('touches nothing else', () => {
    const value = { label: 'A & B > C', quote: '"quoted"', dash: '—' }
    assert.deepEqual(JSON.parse(scriptJson(value)), value)
    assert.equal(scriptJson(value), JSON.stringify(value))
  })
})

describe('siteExport/payload — escapeHtml', () => {
  test('escapes what an attribute or a heading can be broken with', () => {
    assert.equal(escapeHtml('<script>&"'), '&lt;script&gt;&amp;&quot;')
  })

  test('escapes the ampersand first, so nothing is double-escaped', () => {
    assert.equal(escapeHtml('&lt;'), '&amp;lt;')
  })
})

describe('siteExport/payload — workHash', () => {
  test('is the route the app reads back', () => {
    assert.equal(workHash('79362971'), '#work/79362971')
  })
})

describe('siteExport/payload — rewriteWorkLinks', () => {
  const local = new Set(['11', '12'])

  test('points a work that travelled in this export at its hash', () => {
    assert.equal(
      rewriteWorkLinks('<a href="https://archiveofourown.org/works/11">Work</a>', local),
      '<a href="#work/11">Work</a>',
    )
  })

  test('leaves a work this export does not carry pointed at AO3', () => {
    const html = '<a href="https://archiveofourown.org/works/99">Elsewhere</a>'
    assert.equal(rewriteWorkLinks(html, local), html)
  })

  test('collapses a chapter link to the work, which travels whole', () => {
    assert.equal(
      rewriteWorkLinks('<a href="https://archiveofourown.org/works/11/chapters/4321">Ch. 2</a>', local),
      '<a href="#work/11">Ch. 2</a>',
    )
  })

  test('drops the query and the fragment — a route and a fragment are one slot', () => {
    assert.equal(
      rewriteWorkLinks('<a href="https://archiveofourown.org/works/12?view_full_work=true#chapter-3">Read</a>', local),
      '<a href="#work/12">Read</a>',
    )
  })

  test('leaves the pages an export has no copy of alone', () => {
    for (const path of ['11/bookmarks', '11/comments/show_comments', '11/kudos']) {
      const html = `<a href="https://archiveofourown.org/works/${path}">More</a>`
      assert.equal(rewriteWorkLinks(html, local), html)
    }
  })

  test('matches ids whole — 12 is not the start of 123', () => {
    const html = '<a href="https://archiveofourown.org/works/123">Longer</a>'
    assert.equal(rewriteWorkLinks(html, local), html)
  })

  test('rewrites every link in a blurb, not just the first', () => {
    const html = '<a href="https://archiveofourown.org/works/11">A</a> <a href="https://archiveofourown.org/works/12">B</a>'
    assert.equal(rewriteWorkLinks(html, local), '<a href="#work/11">A</a> <a href="#work/12">B</a>')
  })

  test('ignores a link the sanitizer never made absolute', () => {
    // Absolute hrefs are the sanitizer's guarantee, and this leans on it rather
    // than quietly rewriting something that got past it.
    const html = '<a href="/works/11">Relative</a>'
    assert.equal(rewriteWorkLinks(html, local), html)
  })

  test('with nothing carried locally, nothing is rewritten', () => {
    const html = '<a href="https://archiveofourown.org/works/11">Work</a>'
    assert.equal(rewriteWorkLinks(html, new Set()), html)
  })
})

describe('siteExport/payload — the shell', () => {
  const manifest = buildManifest(input({
    listCount: 1284,
    works: [...Array.from({ length: 1190 }, (_, i) => work(String(i), 'cached')), work('x', 'uncached')],
  }))

  test('opens a document and closes it, with the data block between', () => {
    const head = siteShellHead(manifest, BUNDLE)
    const tail = siteShellTail(BUNDLE)
    assert.match(head, /^<!doctype html>/)
    assert.ok(head.endsWith(`<script type="application/json" id="${SITE_DATA_ID}">`))
    assert.match(tail, /^<\/script>/)
    assert.match(tail, /<\/body>\n<\/html>\n$/)
  })

  test('carries the app and the stylesheet inside it — nothing is fetched', () => {
    const html = siteHtml(manifest, '{}', BUNDLE)
    assert.ok(html.includes(BUNDLE.css))
    assert.ok(html.includes(BUNDLE.loader))
    assert.doesNotMatch(html, /<script src=|<link rel="stylesheet"|<img /)
  })

  test('carries the app compressed, in a block the loader after it reads', () => {
    const tail = siteShellTail(BUNDLE)
    const open = tail.indexOf(`<script type="application/json" id="${SITE_APP_ID}">`)
    assert.ok(open > 0, 'the app travels in its own data block')
    const start = tail.indexOf('>', open) + 1
    assert.deepEqual(JSON.parse(tail.slice(start, tail.indexOf('</script>', start))), BUNDLE.app)
    // The loader has to come after the block it reads out of.
    assert.ok(tail.indexOf(BUNDLE.loader) > start)
  })

  test('says the file is inert until a script replaces it', () => {
    const head = siteShellHead(manifest, BUNDLE)
    assert.ok(head.includes(`id="${SITE_SHELL_ID}"`))
    // What a reader sees where scripts don't run — Safari, with a local file.
    assert.match(head, /This page needs JavaScript, and none is running/)
    assert.match(head, /Microsoft Edge/)
  })

  test('reads out the list the way the options row does', () => {
    const head = siteShellHead(manifest, BUNDLE)
    assert.match(head, /1,191 works/)
    assert.match(head, /1,190 readable offline/)
  })

  test('escapes the one thing in it that came from AO3', () => {
    const named = buildManifest(input({ source: { id: 'tag', label: 'Steve & "Bucky" <3', listUrl: 'https://archiveofourown.org/tags/x/works' } }))
    const head = siteShellHead(named, BUNDLE)
    assert.match(head, /<title>Steve &amp; &quot;Bucky&quot; &lt;3<\/title>/)
    assert.match(head, /<h1>Steve &amp; &quot;Bucky&quot; &lt;3<\/h1>/)
  })

  test('the whole file is the three parts, in order', () => {
    const data = scriptJson({ v: SITE_SCHEMA_VERSION })
    const html = siteHtml(manifest, data, BUNDLE)
    assert.equal(html, siteShellHead(manifest, BUNDLE) + data + siteShellTail(BUNDLE))

    // The block runs to its own closing tag: the app slices exactly this out.
    const open = html.indexOf(`id="${SITE_DATA_ID}"`)
    const start = html.indexOf('>', open) + 1
    assert.deepEqual(JSON.parse(html.slice(start, html.indexOf('</script>', start))), { v: SITE_SCHEMA_VERSION })
  })
})
