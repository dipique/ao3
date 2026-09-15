import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  decideBlurbWrite,
  droppedIds,
  hashBlurbHtml,
  LIST_VERSION,
  listedIds,
  migratedBlurbMeta,
  ORPHAN_GRACE_MS,
  PARSE_VERSION,
  planBlurbOrphans,
  planLegacyMigration,
  splitReadingModule,
  TOUCH_MS,
} from '../../src/common/blurbRecord.ts'
import { packOrderedIds, toShortId } from '../../src/common/workId.ts'

const NOW = Date.UTC(2026, 8, 15)
const DAY = 24 * 60 * 60

const facts = (over = {}) => ({ dateUpdated: 1_700_000_000, chapters: { written: 3 }, words: 9000, ...over })
const stored = (over = {}) => ({ pv: PARSE_VERSION, seenAt: NOW - 1000, src: 'listing', hash: 'h1', size: 10, work: facts(), ...over })
const incoming = (over = {}) => ({ seenAt: NOW, src: 'listing', hash: 'h2', work: facts(), ...over })

describe('decideBlurbWrite', () => {
  test('nothing stored: insert', () => {
    assert.equal(decideBlurbWrite(undefined, incoming()), 'insert')
  })

  test('parser version: an older one is replaced, a newer build’s is left alone', () => {
    assert.equal(decideBlurbWrite(stored({ pv: 0 }), incoming({ hash: 'h1' })), 'replace')
    assert.equal(decideBlurbWrite(stored({ pv: PARSE_VERSION + 1 }), incoming()), 'skip')
  })

  test('a copy fetched before the stored one loses, even if it changed', () => {
    assert.equal(decideBlurbWrite(stored({ seenAt: NOW }), incoming({ seenAt: NOW - 1 })), 'skip')
  })

  test('a different blurb replaces', () => {
    assert.equal(decideBlurbWrite(stored(), incoming()), 'replace')
  })

  test('an identical blurb is only touched once it has gone unseen for a while', () => {
    assert.equal(decideBlurbWrite(stored(), incoming({ hash: 'h1' })), 'skip')
    assert.equal(decideBlurbWrite(stored({ seenAt: NOW - TOUCH_MS }), incoming({ hash: 'h1' })), 'touch')
    // Re-storing a work read from the store: same seenAt, nothing to do however old.
    assert.equal(decideBlurbWrite(stored({ seenAt: NOW - 10 * TOUCH_MS }), incoming({ hash: 'h1', seenAt: NOW - 10 * TOUCH_MS })), 'skip')
  })

  test('a work-page reconstruction only replaces a listing blurb when it knows something newer', () => {
    const page = over => incoming({ src: 'workPage', work: facts(over) })
    // Same day (the page's date is midnight of it), same numbers.
    const sameDay = Math.floor(facts().dateUpdated / DAY) * DAY
    assert.equal(decideBlurbWrite(stored(), page({ dateUpdated: sameDay })), 'skip')
    assert.equal(decideBlurbWrite(stored(), page({ dateUpdated: sameDay + DAY })), 'replace')
    assert.equal(decideBlurbWrite(stored(), page({ dateUpdated: sameDay, chapters: { written: 4 } })), 'replace')
    assert.equal(decideBlurbWrite(stored(), page({ dateUpdated: sameDay, words: 9001 })), 'replace')
    // A listing blurb over a reconstruction is an ordinary replacement.
    assert.equal(decideBlurbWrite(stored({ src: 'workPage' }), incoming()), 'replace')
  })
})

const READING = `<li id="work_438475" class="reading work blurb group work-438475 user-35341" role="article">
  <div class="header module"><h4 class="heading"><a href="/works/438475">Almost Ever After</a></h4></div>
  <dl class="stats"><dt class="words">Words:</dt><dd class="words">3,169</dd></dl>
  <div class="user module group">
    <h4 class="viewed heading"><span>Last visited:</span> 27 Jun 2026 (Marked for Later.)</h4>
    <ul class="actions">
      <li>
        <form class="ajax-remove" action="/users/me/readings/1" method="post"><input type="hidden" name="authenticity_token" value="SECRET" /><div>x</div></form>
      </li>
    </ul>
  </div>
</li>`

describe('splitReadingModule', () => {
  test('takes the readings block off the blurb, forms and all', () => {
    const { html, ctx } = splitReadingModule(READING)
    assert.ok(!html.includes('user module group'), 'the blurb no longer carries the block')
    assert.ok(!html.includes('reading work'), 'nor the readings class')
    assert.match(html, /class="work blurb group work-438475 user-35341"/)
    assert.match(html, /<\/dl>\s*<\/li>$/)
    assert.match(ctx, /^<div class="user module group">/)
    assert.match(ctx, /Marked for Later/)
    assert.ok(!ctx.includes('SECRET'), 'the session token is gone')
    assert.ok(!ctx.includes('<form'), 'and so is its form')
  })

  test('leaves any other blurb alone', () => {
    const plain = '<li id="work_1" class="work blurb group" role="article"><dl class="stats"></dl></li>'
    assert.deepEqual(splitReadingModule(plain), { html: plain })
  })
})

const blurb = (id, extra = '') => `<li id="work_${id}" class="work blurb group" role="article">${extra}</li>`
const list = (ids, over = {}) => ({ v: LIST_VERSION, scrapedAt: 1, ids: packOrderedIds(ids), ...over })

describe('listedIds', () => {
  test('reads both layouts, whatever the version', () => {
    const ids = listedIds(
      { a: list(['1', '2']), b: list(['2', '3'], { v: 99 }) },
      { old: { version: 7, scrapedAt: 1, blurbsHtml: [blurb(4), 'junk'] } },
    )
    assert.deepEqual([...ids].sort(), ['1', '2', '3', '4'])
  })
})

describe('droppedIds', () => {
  test('only ids no other list still holds', () => {
    assert.deepEqual(droppedIds(['1', '2', '3'], ['1'], [list(['3'])]), ['2'])
    assert.deepEqual(droppedIds(['1'], ['1'], []), [])
  })
})

describe('planBlurbOrphans', () => {
  test('unreferenced and past the grace period', () => {
    const plan = planBlurbOrphans(
      ['1', '2', '3', '4'],
      {
        2: { seenAt: NOW - ORPHAN_GRACE_MS, size: 100 },
        3: { seenAt: NOW - 1, size: 50 },
      },
      new Set(['1']),
      NOW,
    )
    // 2 is old enough; 3 was just written by someone; 4 lost its parsed half.
    assert.deepEqual(plan.ids, ['2', '4'])
    assert.equal(plan.bytes, 100)
  })
})

describe('planLegacyMigration', () => {
  test('newest copy wins, readings blocks go to their list, junk is dropped', () => {
    const legacy = {
      'read-works:me': { version: 2, scrapedAt: 200, blurbsHtml: [READING, blurb(9, 'new')], descriptor: { sourceId: 'read-works', label: 'R', listUrl: 'u' } },
      'tag-works:x': { version: 1, scrapedAt: 100, blurbsHtml: [blurb(9, 'old'), blurb(438475, 'plain'), 'no id here'] },
    }
    const plan = planLegacyMigration(legacy, {})
    assert.deepEqual(plan.skipped, [])
    assert.equal(plan.blurbs.get('9').html, blurb(9, 'new'))
    assert.equal(plan.blurbs.get('9').seenAt, 200)
    assert.ok(!plan.blurbs.get('438475').html.includes('user module group'))

    const read = plan.lists['read-works:me']
    assert.equal(read.ids, packOrderedIds(['438475', '9']))
    assert.equal(read.scrapedAt, 200)
    assert.equal(read.descriptor.sourceId, 'read-works')
    assert.deepEqual(Object.keys(read.ctx), [toShortId('438475')])

    const tag = plan.lists['tag-works:x']
    assert.equal(tag.ids, packOrderedIds(['9', '438475']))
    assert.equal(tag.ctx, undefined)
    assert.equal(tag.descriptor, undefined)
  })

  test('a list already in the new layout, and its blurbs, are left alone', () => {
    const plan = planLegacyMigration(
      { a: { version: 2, scrapedAt: 5, blurbsHtml: [blurb(1)] } },
      { a: list(['1']) },
    )
    assert.deepEqual(plan.lists, {})
    assert.equal(plan.blurbs.size, 0)
  })

  test('an unknown version is skipped, so the legacy value is kept', () => {
    const plan = planLegacyMigration({ a: { version: 3, scrapedAt: 5, blurbsHtml: [blurb(1)] } }, {})
    assert.deepEqual(plan.skipped, ['a'])
    assert.deepEqual(plan.lists, {})
  })

  test('non-objects are nothing to migrate', () => {
    for (const value of [undefined, null, 'x', 3])
      assert.deepEqual(planLegacyMigration(value, {}).lists, {})
  })

  test('migrated meta says nothing was parsed', () => {
    const meta = migratedBlurbMeta(blurb(1), 42)
    assert.deepEqual(meta, { pv: 0, seenAt: 42, src: 'listing', hash: hashBlurbHtml(blurb(1)), size: blurb(1).length })
  })
})
