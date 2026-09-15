import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { installMock } from '../e2e/helpers.mjs'
import { loadModuleInPage, skipWithoutChrome } from '../siteExport/helpers.mjs'

/**
 * The shared blurb store, driven the way the search view drives it: lists
 * written and read through the snapshot functions, over a `storage.local` mock,
 * in a real DOM. What the pure half decides is tested next door
 * (`blurbRecord.test.mjs`); this is what ends up in storage, and whether what
 * comes back out of it is the work a live page would have parsed.
 */

const skip = skipWithoutChrome

const DESCRIPTOR = { sourceId: 'tag-works', label: 'Tag', listUrl: 'https://archiveofourown.org/tags/x/works' }
const HOUR = 60 * 60 * 1000

describe('searchView/blurbStore', { skip }, () => {
  let page
  let close

  before(async () => {
    ({ page, close } = await loadModuleInPage('test/blurbCache/storeEntry.ts', 'Store', {
      prepare: blank => blank.evaluate(installMock, {}),
    }))
    // Fixtures and helpers, defined once in the page. The parsers read absolute
    // hrefs, which a blurb's relative links only have with an archive base.
    await page.evaluate(() => {
      const base = document.createElement('base')
      base.href = 'https://archiveofourown.org/'
      document.head.append(base)
      window.blurb = (id, { title = `Work ${id}`, reading = false, words = '3,169', updated = 1506789279 } = {}) => `
<li id="work_${id}" class="${reading ? 'reading ' : ''}work blurb group work-${id} user-35341" role="article">
  <div class="header module">
    <!-- updated_at=${updated} -->
    <h4 class="heading"><a href="/works/${id}">${title}</a> by <a rel="author" href="/users/Alsike/pseuds/Alsike">Alsike</a></h4>
    <h5 class="fandoms heading"><span class="landmark">Fandoms:</span> <a class="tag" href="/tags/Criminal%20Minds/works">Criminal Minds</a></h5>
    <ul class="required-tags">
      <li><a class="help symbol question modal" href="/help/symbols_key"><span class="rating-teen rating" title="Teen And Up Audiences"><span class="text">Teen And Up Audiences</span></span></a></li>
      <li><a class="help symbol question modal" href="/help/symbols_key"><span class="category-femslash category" title="F/F"><span class="text">F/F</span></span></a></li>
    </ul>
    <p class="datetime">19 Jun 2012</p>
  </div>
  <h6 class="landmark heading">Tags</h6>
  <ul class="tags commas">
    <li class='warnings'><strong><a class="tag" href="/tags/No%20Archive%20Warnings%20Apply/works">No Archive Warnings Apply</a></strong></li>
    <li class='characters'><a class="tag" href="/tags/Emily%20Prentiss/works">Emily Prentiss</a></li>
    <li class='freeforms'><a class="tag" href="/tags/Fluff/works">Fluff</a></li>
  </ul>
  <blockquote class="userstuff summary"><p>A summary.</p></blockquote>
  <ul class="series"><li>Part <strong>5</strong> of <a href="/series/21276">Danny Zuko</a></li></ul>
  <dl class="stats">
    <dt class="language">Language:</dt><dd class="language" lang="en">English</dd>
    <dt class="words">Words:</dt><dd class="words">${words}</dd>
    <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd>
    <dt class="kudos">Kudos:</dt><dd class="kudos"><a href="/works/${id}#kudos">86</a></dd>
  </dl>
  ${reading
    ? `<div class="user module group">
    <h4 class="viewed heading"><span>Last visited:</span> 27 Jun 2026 (Marked for Later.)</h4>
    <ul class="actions"><li><form class="ajax-remove" action="/users/me/readings/1" method="post"><input type="hidden" name="authenticity_token" value="SECRET" /><input type="submit" value="Delete from History" /></form></li></ul>
  </div>`
    : ''}
</li>`
      /** A live Work, the way a scrape makes one. */
      window.scraped = (id, opts = {}) => {
        const template = document.createElement('template')
        template.innerHTML = window.blurb(id, opts).trim()
        const li = document.adoptNode(template.content.firstElementChild)
        const work = window.Store.parseWork(li, 0)
        work.seenAt = opts.seenAt ?? Date.now()
        if (opts.src)
          work.src = opts.src
        return work
      }
      window.store = async () => window.browser.storage.local.get(null)
      window.reset = async (seed = {}) => {
        await window.browser.storage.local.clear()
        await window.browser.storage.local.set(seed)
        window.__writes.length = 0
      }
    })
  }, { timeout: 120000 })

  after(async () => close?.())

  test('a list keeps ids; each blurb is stored once, under its work', async () => {
    const result = await page.evaluate(async (descriptor) => {
      const { writeSnapshot, toShortId } = window.Store
      await window.reset()
      await writeSnapshot('a', [window.scraped('7134741'), window.scraped('12')], descriptor)
      await writeSnapshot('b', [window.scraped('12')], descriptor)
      const all = await window.store()
      return { keys: Object.keys(all).sort(), lists: all['cache.searchLists'], sid: toShortId('7134741') }
    }, DESCRIPTOR)

    assert.equal(result.sid, '48x79')
    assert.deepEqual(result.keys, ['blurb.48x79', 'blurb.c', 'blurbData.48x79', 'blurbData.c', 'blurbIndex', 'cache.searchLists'])
    assert.equal(result.lists.a.ids, '48x79,c')
    assert.equal(result.lists.b.ids, 'c')
    assert.equal(result.lists.a.v, 3)
    assert.deepEqual(result.lists.a.descriptor, DESCRIPTOR)
  })

  test('a readings blurb: the block stays with its list, the token goes altogether', async () => {
    const result = await page.evaluate(async (descriptor) => {
      const { writeSnapshot, readSnapshot } = window.Store
      await window.reset()
      await writeSnapshot('read', [window.scraped('5', { reading: true })], descriptor)
      await writeSnapshot('tag', [window.scraped('5')], descriptor)
      const all = await window.store()
      const read = await readSnapshot('read')
      const tag = await readSnapshot('tag')
      return {
        stored: JSON.stringify(all),
        html: all['blurb.5'].html,
        ctx: all['cache.searchLists'].read.ctx,
        tagCtx: all['cache.searchLists'].tag.ctx,
        readViewed: !!read.works[0].el.querySelector('h4.viewed'),
        tagViewed: !!tag.works[0].el.querySelector('h4.viewed'),
      }
    }, DESCRIPTOR)

    assert.ok(!result.stored.includes('SECRET'), 'no session token anywhere in storage')
    assert.ok(!result.html.includes('user module group'), 'the shared blurb has no readings block')
    assert.ok(!result.html.includes('reading work'), 'nor the readings class')
    assert.match(result.ctx['5'], /Marked for Later/)
    assert.equal(result.tagCtx, undefined)
    assert.ok(result.readViewed, 'the read list still draws "Last visited"')
    assert.ok(!result.tagViewed, 'and a tag search sharing the blurb does not')
  })

  test('a stored work comes back parsed, without a node until one is asked for, and equal to a live parse', async () => {
    const result = await page.evaluate(async (descriptor) => {
      const { writeSnapshot, readSnapshot, hasNode, parseWork, getBlurb } = window.Store
      await window.reset()
      await writeSnapshot('a', [window.scraped('1', { title: 'One' }), window.scraped('2', { title: 'Two' })], descriptor)
      const snapshot = await readSnapshot('a')
      const [first, second] = snapshot.works
      const before = [hasNode(first), hasNode(second)]
      const node = first.el
      const live = parseWork(node, 0)
      const strip = ({ el, markedOrder, seenAt, src, blurb, ...rest }) => rest
      return {
        before,
        after: [hasNode(first), hasNode(second)],
        titles: snapshot.works.map(work => work.title),
        orders: snapshot.works.map(work => work.markedOrder),
        missing: snapshot.missing,
        // Through JSON, the way storage sees them: an absent pseud is absent either way.
        work: JSON.parse(JSON.stringify(strip(first))),
        live: JSON.parse(JSON.stringify(strip(live))),
        blurb: JSON.parse(JSON.stringify(first.blurb)),
        liveBlurb: JSON.parse(JSON.stringify(getBlurb(node))),
      }
    }, DESCRIPTOR)

    assert.deepEqual(result.before, [false, false])
    assert.deepEqual(result.after, [true, false], 'only the node asked for was built')
    assert.deepEqual(result.titles, ['One', 'Two'])
    assert.deepEqual(result.orders, [0, 1])
    assert.equal(result.missing, 0)
    assert.deepEqual(result.work, result.live, 'the stored parse is the live parse')
    assert.deepEqual(result.blurb, result.liveBlurb, 'and so is the stored blurb')
  })

  test('re-storing a list of stored works writes the list and nothing else', async () => {
    const writes = await page.evaluate(async (descriptor) => {
      const { writeSnapshot, readSnapshot } = window.Store
      await window.reset()
      await writeSnapshot('a', [window.scraped('1'), window.scraped('2'), window.scraped('3')], descriptor)
      const { works } = await readSnapshot('a')
      window.__writes.length = 0
      await writeSnapshot('a', works.slice(1), descriptor, { keepScrapedAt: true })
      await writeSnapshot('a', works.slice(1), descriptor)
      return window.__writes.map(write => Object.keys(write))
    }, DESCRIPTOR)

    assert.deepEqual(writes, [['cache.searchLists'], ['cache.searchLists']])
  })

  test('a newer copy of a blurb replaces the stored one; an older copy, or an unchanged one, does not', async () => {
    const result = await page.evaluate(async (descriptor) => {
      const { writeSnapshot, readSnapshot } = window.Store
      const now = Date.now()
      await window.reset()
      await writeSnapshot('a', [window.scraped('1', { words: '100', seenAt: now })], descriptor)
      await writeSnapshot('b', [window.scraped('1', { words: '50', seenAt: now - 1000 })], descriptor)
      const afterOlder = (await readSnapshot('a')).works[0].words
      window.__writes.length = 0
      await writeSnapshot('b', [window.scraped('1', { words: '100', seenAt: now + 1000 })], descriptor)
      const unchangedWrites = window.__writes.map(write => Object.keys(write))
      await writeSnapshot('b', [window.scraped('1', { words: '200', seenAt: now + 2000 })], descriptor)
      const afterNewer = (await readSnapshot('a')).works[0].words
      return { afterOlder, unchangedWrites, afterNewer }
    }, DESCRIPTOR)

    assert.equal(result.afterOlder, 100, 'a scrape that started earlier does not win')
    assert.deepEqual(result.unchangedWrites, [['cache.searchLists']], 'an identical blurb is not rewritten')
    assert.equal(result.afterNewer, 200, 'and list a sees what list b brought')
  })

  test('a work-page reconstruction does not replace a listing blurb that knows as much', async () => {
    const words = await page.evaluate(async (descriptor) => {
      const { writeSnapshot, readSnapshot } = window.Store
      const now = Date.now()
      await window.reset()
      await writeSnapshot('a', [window.scraped('1', { title: 'Listing', seenAt: now })], descriptor)
      await writeSnapshot('b', [window.scraped('1', { title: 'Page', seenAt: now + 1000, src: 'workPage' })], descriptor)
      return (await readSnapshot('a')).works[0].title
    }, DESCRIPTOR)
    assert.equal(words, 'Listing')
  })

  test('a migrated, unparsed record is parsed on read and written back', async () => {
    const result = await page.evaluate(async () => {
      const { readSnapshot } = window.Store
      const html = window.blurb('9', { title: 'Migrated' }).trim()
      await window.reset({
        'blurb.9': { html },
        'blurbData.9': { pv: 0, seenAt: 5, src: 'listing', hash: 'x', size: html.length },
        'cache.searchLists': { a: { v: 3, scrapedAt: 5, ids: '9' } },
      })
      const snapshot = await readSnapshot('a')
      // The write-back is fired and not awaited.
      for (let i = 0; i < 50 && !(await window.browser.storage.local.get('blurbData.9'))['blurbData.9'].work; i++)
        await new Promise(r => setTimeout(r, 20))
      const data = (await window.browser.storage.local.get('blurbData.9'))['blurbData.9']
      return { title: snapshot.works[0].title, pv: data.pv, storedTitle: data.work?.title }
    })
    assert.equal(result.title, 'Migrated')
    assert.equal(result.pv, 1)
    assert.equal(result.storedTitle, 'Migrated')
  })

  test('ids with no stored blurb are left out, and counted', async () => {
    const result = await page.evaluate(async (descriptor) => {
      const { writeSnapshot, readSnapshot, listSnapshots } = window.Store
      await window.reset()
      await writeSnapshot('a', [window.scraped('1'), window.scraped('2')], descriptor)
      await window.browser.storage.local.remove(['blurb.2', 'blurbData.2'])
      const snapshot = await readSnapshot('a')
      const [summary] = await listSnapshots()
      return { count: snapshot.works.length, missing: snapshot.missing, summary }
    }, DESCRIPTOR)
    assert.equal(result.count, 1)
    assert.equal(result.missing, 1)
    assert.equal(result.summary.count, 2)
    assert.equal(result.summary.unstored, 0, 'the index still claims it — the discard reconciles that')
  })

  test('the old layout is still readable, and a write moves the list out of it', async () => {
    const result = await page.evaluate(async (descriptor) => {
      const { readSnapshot, writeSnapshot, snapshotWorkIds } = window.Store
      await window.reset({
        'cache.searchSnapshots': {
          old: { version: 2, scrapedAt: 1, descriptor, blurbsHtml: [window.blurb('3').trim(), window.blurb('4').trim()] },
          other: { version: 2, scrapedAt: 1, blurbsHtml: [window.blurb('8').trim()] },
        },
      })
      const legacy = await readSnapshot('old')
      const ids = [...await snapshotWorkIds()].sort()
      await writeSnapshot('old', legacy.works, descriptor)
      const all = await window.store()
      return { titles: legacy.works.map(work => work.title), ids, left: Object.keys(all['cache.searchSnapshots']), list: all['cache.searchLists'].old.ids }
    }, DESCRIPTOR)
    assert.deepEqual(result.titles, ['Work 3', 'Work 4'])
    assert.deepEqual(result.ids, ['3', '4', '8'])
    assert.deepEqual(result.left, ['other'])
    assert.equal(result.list, '3,4')
  })

  test('orphans: counted by index, spared within the grace period, discarded with strays, index reconciled', async () => {
    const result = await page.evaluate(async ({ descriptor, HOUR }) => {
      const { writeSnapshot, blurbOrphans, discardOrphanedBlurbs, snapshotWorkIds, readBlurbIndex } = window.Store
      const old = Date.now() - HOUR
      await window.reset()
      await writeSnapshot('a', [window.scraped('1', { seenAt: old }), window.scraped('2', { seenAt: old }), window.scraped('3')], descriptor)
      // 2 (old) and 3 (just seen) leave the list; a stray key nobody indexed turns up.
      await writeSnapshot('a', [window.scraped('1', { seenAt: old })], descriptor)
      await window.browser.storage.local.set({ 'blurb.zz': { html: '<li id="work_1295"></li>' } })
      const listed = await snapshotWorkIds()
      const counted = await blurbOrphans(listed)
      const discarded = await discardOrphanedBlurbs(listed)
      const keys = Object.keys(await window.store()).filter(key => key.startsWith('blurb')).sort()
      return { counted: counted.ids, discarded: discarded.ids.sort(), keys, index: [...await readBlurbIndex()].sort() }
    }, { descriptor: DESCRIPTOR, HOUR })

    assert.deepEqual(result.counted, ['2'], 'by the index: 3 is still in its grace period')
    assert.deepEqual(result.discarded, ['1295', '2'], 'the stray goes too')
    assert.deepEqual(result.keys, ['blurb.1', 'blurb.3', 'blurbData.1', 'blurbData.3', 'blurbIndex'])
    assert.deepEqual(result.index, ['1', '3'])
  })

  test('automatic pruning is off by default, and when on spares what another list holds', async () => {
    const result = await page.evaluate(async ({ descriptor, HOUR }) => {
      const { writeSnapshot, deleteSnapshot } = window.Store
      const old = Date.now() - HOUR
      const blurbKeys = async () => Object.keys(await window.store()).filter(key => key.startsWith('blurb.')).sort()

      await window.reset()
      await writeSnapshot('a', [window.scraped('1', { seenAt: old }), window.scraped('2', { seenAt: old })], descriptor)
      await writeSnapshot('a', [window.scraped('1', { seenAt: old })], descriptor)
      const off = await blurbKeys()

      await window.reset({ 'option.pruneOrphanedBlurbs': true })
      await writeSnapshot('a', [window.scraped('1', { seenAt: old }), window.scraped('2', { seenAt: old }), window.scraped('3', { seenAt: old })], descriptor)
      await writeSnapshot('b', [window.scraped('3', { seenAt: old })], descriptor)
      await writeSnapshot('a', [window.scraped('1', { seenAt: old })], descriptor)
      const dropped = await blurbKeys()
      await deleteSnapshot('b')
      const deleted = await blurbKeys()
      return { off, dropped, deleted }
    }, { descriptor: DESCRIPTOR, HOUR })

    assert.deepEqual(result.off, ['blurb.1', 'blurb.2'], 'left for the discard button')
    assert.deepEqual(result.dropped, ['blurb.1', 'blurb.3'], '2 went; 3 is on list b')
    assert.deepEqual(result.deleted, ['blurb.1'], 'and goes with list b')
  })

  test('stored works stand in for a fetch only while they are recent', async () => {
    const result = await page.evaluate(async ({ descriptor, HOUR }) => {
      const { writeSnapshot, readStoredWorks } = window.Store
      await window.reset()
      await writeSnapshot('a', [window.scraped('1'), window.scraped('2', { seenAt: Date.now() - 48 * HOUR })], descriptor)
      return (await readStoredWorks(['1', '2', '3'], 24 * HOUR)).map(work => work.workId)
    }, { descriptor: DESCRIPTOR, HOUR })
    assert.deepEqual(result, ['1'])
  })

  test('migration: lists become ids, blurbs are stored once, and the old value goes', async () => {
    const result = await page.evaluate(async (descriptor) => {
      const { migrate, readSnapshot } = window.Store
      await window.reset({
        'cache.searchSnapshots': {
          'read-works:me': { version: 2, scrapedAt: 200, descriptor, blurbsHtml: [window.blurb('5', { reading: true, title: 'New' }).trim(), window.blurb('6').trim()] },
          'tag-works:x': { version: 1, scrapedAt: 100, blurbsHtml: [window.blurb('5', { title: 'Old' }).trim()] },
        },
      })
      await migrate()
      const migrated = await window.store()
      // Idempotent: a second run (an import, the next update) changes nothing.
      window.__writes.length = 0
      await migrate()
      const secondRunWrites = window.__writes.length
      const read = await readSnapshot('read-works:me')
      const tag = await readSnapshot('tag-works:x')
      return {
        keys: Object.keys(migrated).filter(key => !key.startsWith('option.')).sort(),
        lists: migrated['cache.searchLists'],
        meta5: migrated['blurbData.5'],
        stored: JSON.stringify(migrated),
        secondRunWrites,
        read: read.works.map(work => [work.title, !!work.el.querySelector('h4.viewed')]),
        tag: tag.works.map(work => [work.title, !!work.el.querySelector('h4.viewed')]),
      }
    }, DESCRIPTOR)

    assert.deepEqual(result.keys, ['blurb.5', 'blurb.6', 'blurbData.5', 'blurbData.6', 'blurbIndex', 'cache.searchLists'])
    assert.equal(result.lists['read-works:me'].ids, '5,6')
    assert.equal(result.lists['tag-works:x'].ids, '5')
    assert.deepEqual(result.lists['read-works:me'].descriptor, DESCRIPTOR)
    assert.equal(result.meta5.pv, 0, 'moved, not parsed')
    assert.equal(result.meta5.seenAt, 200, 'the newest copy won')
    assert.ok(!result.stored.includes('SECRET'), 'no session token survives the move')
    assert.equal(result.secondRunWrites, 0)
    assert.deepEqual(result.read, [['New', true], ['Work 6', false]])
    assert.deepEqual(result.tag, [['New', false]], 'the shared blurb, without the read list’s block')
  })

  test('the job runner’s parsed read needs no markup', async () => {
    const result = await page.evaluate(async (descriptor) => {
      const { writeSnapshot, readSnapshotData } = window.Store
      await window.reset()
      await writeSnapshot('a', [window.scraped('1', { title: 'T', words: '1,234' })], descriptor)
      const get = window.browser.storage.local.get
      const asked = []
      window.browser.storage.local.get = (keys) => {
        asked.push(keys)
        return get(keys)
      }
      try {
        const data = await readSnapshotData('a')
        return { works: data.works.map(work => [work.workId, work.title, work.words]), asked: JSON.stringify(asked) }
      }
      finally {
        window.browser.storage.local.get = get
      }
    }, DESCRIPTOR)
    assert.deepEqual(result.works, [['1', 'T', 1234]])
    assert.ok(!result.asked.includes('"blurb.1"'), `read ${result.asked}`)
  })
})
