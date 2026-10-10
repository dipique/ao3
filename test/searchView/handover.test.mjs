import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { onClaim, onClose, onOpen, onRelease, onRunEnd, onSuspend } from '../../src/content_script/searchView/handover.ts'

const VIEW = { state: 'where the reader left it' }
const WALK = { walk: 'page 3 of 40' }
const OTHER = { walk: 'another list\'s' }

const view = (cacheKey = 'a') => ({ kind: 'view', cacheKey, view: VIEW })
const opening = (cacheKey = 'a', claims = 0, of = WALK) => ({ kind: 'opening', cacheKey, opening: of, claims })

describe('a re-run takes the page down', () => {
  test('a view on screen is handed over to be put back', () => {
    assert.deepEqual(onSuspend(null, { view: { cacheKey: 'a', view: VIEW } }), { handover: view(), stopped: null })
  })

  test('a view still opening is handed over as it stands, claimed by no one yet', () => {
    assert.deepEqual(onSuspend(null, { opening: { cacheKey: 'a', opening: WALK } }), { handover: opening(), stopped: null })
  })

  test('with nothing on the page, what an earlier re-run handed over stays for this one\'s units to claim', () => {
    for (const earlier of [null, view(), opening('a', 0), opening('a', 2)])
      assert.deepEqual(onSuspend(earlier, {}), { handover: earlier, stopped: null })
  })

  test('something newer on the page replaces a view handed over before, which has nothing left to stop', () => {
    assert.deepEqual(onSuspend(view('old'), { opening: { cacheKey: 'a', opening: WALK } }), { handover: opening(), stopped: null })
  })

  test('and an opening it replaces is stopped, not left running', () => {
    assert.deepEqual(onSuspend(opening('old', 1, OTHER), { view: { cacheKey: 'a', view: VIEW } }), { handover: view(), stopped: OTHER })
  })
})

describe('a unit claims its list as it re-runs', () => {
  test('its view is taken, and no one else can take it', () => {
    assert.deepEqual(onClaim(view(), 'a'), { handover: null, claimed: view() })
  })

  test('its opening is promised to the open the claim leads to, and stays handed over until that open arrives', () => {
    assert.deepEqual(onClaim(opening(), 'a'), { handover: opening('a', 1), claimed: opening('a', 1) })
  })

  test('a second claim, from a re-run that overlaps the first, is counted too', () => {
    assert.deepEqual(onClaim(opening('a', 1), 'a').handover, opening('a', 2))
  })

  test('another list\'s claim takes nothing', () => {
    for (const handover of [null, view('b'), opening('b')])
      assert.deepEqual(onClaim(handover, 'a'), { handover, claimed: null })
  })
})

describe('an open of a list', () => {
  test('takes back that list\'s opening, claimed or not', () => {
    for (const claims of [0, 1, 2])
      assert.deepEqual(onOpen(opening('a', claims), 'a', false), { handover: null, plan: 'adopt', adopted: WALK, stopped: null })
  })

  test('already on screen, or on its way there, has nothing to add', () => {
    for (const handover of [null, view('a'), view('b')])
      assert.deepEqual(onOpen(handover, 'a', true), { handover, plan: 'stay', adopted: null, stopped: null })
  })

  test('otherwise starts its own, leaving a view handed over for whatever claims it', () => {
    for (const handover of [null, view('a'), view('b')])
      assert.deepEqual(onOpen(handover, 'a', false), { handover, plan: 'start', adopted: null, stopped: null })
  })

  test('starting, stops another list\'s opening: one view at a time', () => {
    assert.deepEqual(onOpen(opening('b', 1, OTHER), 'a', false), { handover: null, plan: 'start', adopted: null, stopped: OTHER })
  })
})

describe('an open that claimed an opening settles', () => {
  test('having taken it back, there is nothing left to release', () => {
    assert.deepEqual(onRelease(null, 'a'), { handover: null, stopped: null })
  })

  test('without taking it back — it gave up on the way — its claim lapses, and the opening is stopped with the last of them', () => {
    assert.deepEqual(onRelease(opening('a', 1), 'a'), { handover: null, stopped: WALK })
  })

  test('while another claim still stands, the opening waits for that one', () => {
    assert.deepEqual(onRelease(opening('a', 2), 'a'), { handover: opening('a', 1), stopped: null })
  })

  test('a claim on another list, or a view, leaves the handover alone', () => {
    for (const handover of [view('a'), opening('b', 1, OTHER)])
      assert.deepEqual(onRelease(handover, 'a'), { handover, stopped: null })
  })
})

describe('the re-run ends', () => {
  test('an opening no unit claimed is stopped', () => {
    assert.deepEqual(onRunEnd(opening()), { handover: null, stopped: WALK })
  })

  test('a claimed one is left for its open', () => {
    assert.deepEqual(onRunEnd(opening('a', 1)), { handover: opening('a', 1), stopped: null })
  })

  test('a view no unit claimed stays handed over, closed, for whatever opens it next', () => {
    assert.deepEqual(onRunEnd(view()), { handover: view(), stopped: null })
    assert.deepEqual(onRunEnd(null), { handover: null, stopped: null })
  })
})

describe('the view is closed', () => {
  test('nothing handed over survives it, and an opening is stopped', () => {
    assert.deepEqual(onClose(opening('a', 1)), { handover: null, stopped: WALK })
    assert.deepEqual(onClose(view()), { handover: null, stopped: null })
    assert.deepEqual(onClose(null), { handover: null, stopped: null })
  })
})

describe('a walk across a re-run, start to finish', () => {
  test('claimed and taken back: nothing is stopped', () => {
    let { handover } = onSuspend(null, { opening: { cacheKey: 'a', opening: WALK } })
    ;({ handover } = onClaim(handover, 'a'))
    assert.equal(onRunEnd(handover).stopped, null)
    const open = onOpen(handover, 'a', false)
    assert.equal(open.adopted, WALK)
    assert.deepEqual(onRelease(open.handover, 'a'), { handover: null, stopped: null })
  })

  test('its feature switched off by the change, so no unit claims it: stopped as the re-run ends', () => {
    const { handover } = onSuspend(null, { opening: { cacheKey: 'a', opening: WALK } })
    assert.deepEqual(onClaim(handover, 'b').claimed, null)
    assert.equal(onRunEnd(handover).stopped, WALK)
  })
})
