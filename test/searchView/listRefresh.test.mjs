import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { claimLive } from '../../src/common/claim.ts'
import {
  cancels,
  claimRefresh,
  followState,
  holds,
  lapseIn,
  listStored,
  loadingLine,
  outranks,
  REFRESH_CLAIM_RENEW_MS,
  REFRESH_CLAIM_TTL_MS,
  refreshStep,
  released,
  renewed,
  sharesRefresh,
  updatingNote,
  withPause,
  withProgress,
} from '../../src/content_script/searchView/listRefresh.ts'

const NOW = 1_800_000_000_000

describe('claimLive', () => {
  test('a claim made or renewed within the ttl holds', () => {
    assert.equal(claimLive(NOW, NOW + 999, 1000), true)
  })

  test('one left unrenewed for the whole ttl has lapsed', () => {
    assert.equal(claimLive(NOW, NOW + 1000, 1000), false)
  })

  test('a withdrawn claim, at 0, holds nobody', () => {
    assert.equal(claimLive(0, NOW, 1000), false)
  })

  test('a claim stamped ahead by another page’s clock still holds within the ttl', () => {
    assert.equal(claimLive(NOW + 500, NOW, 1000), true)
    assert.equal(claimLive(NOW + 1000, NOW, 1000), false)
  })

  test('something that is not a time holds nobody', () => {
    assert.equal(claimLive(undefined, NOW, 1000), false)
  })
})

describe('sharesRefresh', () => {
  test('Marked for Later shares its refresh, and nothing else does yet', () => {
    assert.equal(sharesRefresh('marked-for-later'), true)
    for (const id of ['read-works', 'tracked-review', 'works-search', 'tag-works'])
      assert.equal(sharesRefresh(id), false, id)
  })
})

describe('claimRefresh', () => {
  test('a new claim is named for its page run and when it began, with nothing loaded yet', () => {
    assert.deepEqual(claimRefresh('tab1', 'page', NOW), {
      id: `tab1:${NOW}`,
      by: 'tab1',
      holder: 'page',
      startedAt: NOW,
      at: NOW,
      done: 0,
      total: 0,
      waitUntil: 0,
      waitReason: null,
      outcome: null,
      endedAt: 0,
    })
  })

  test('the renew interval sits well inside the ttl', () => {
    assert.ok(REFRESH_CLAIM_RENEW_MS * 3 <= REFRESH_CLAIM_TTL_MS)
  })
})

describe('refreshStep', () => {
  test('with no claim stored, refresh it here', () => {
    assert.equal(refreshStep(null, 'me', NOW), 'hold')
  })

  test('another page run’s live claim is followed', () => {
    assert.equal(refreshStep(claimRefresh('other', 'options', NOW), 'me', NOW + 1000), 'follow')
  })

  test('this page run’s own claim is no reason to wait', () => {
    assert.equal(refreshStep(claimRefresh('me', 'page', NOW), 'me', NOW + 1000), 'hold')
  })

  test('a claim left unrenewed for the ttl is a page that went away', () => {
    assert.equal(refreshStep(claimRefresh('other', 'page', NOW), 'me', NOW + REFRESH_CLAIM_TTL_MS), 'hold')
    assert.equal(refreshStep(claimRefresh('other', 'page', NOW), 'me', NOW + REFRESH_CLAIM_TTL_MS - 1), 'follow')
  })

  test('a released claim holds nobody, however recently it ended', () => {
    for (const outcome of ['written', 'blocked', 'refused', 'failed', 'cancelled', 'dropped'])
      assert.equal(refreshStep(released(claimRefresh('other', 'page', NOW), outcome, NOW + 10), 'me', NOW + 20), 'hold', outcome)
  })
})

describe('holds', () => {
  test('two pages that claimed at once both read back the last write: only its writer holds', () => {
    const mine = claimRefresh('me', 'page', NOW)
    const theirs = claimRefresh('other', 'options', NOW)
    assert.equal(holds(theirs, mine), false)
    assert.equal(holds(theirs, theirs), true)
    assert.equal(holds(mine, mine), true)
  })

  test('a page run’s earlier claim is not the one it just made', () => {
    assert.equal(holds(claimRefresh('me', 'page', NOW), claimRefresh('me', 'page', NOW + 5)), false)
  })

  test('nothing read back is not held', () => {
    assert.equal(holds(null, claimRefresh('me', 'page', NOW)), false)
  })
})

describe('outranks', () => {
  const mine = claimRefresh('me', 'page', NOW)

  test('a later claim another page wrote takes the refresh over: the claimant that wrote first gives way', () => {
    assert.equal(outranks(claimRefresh('other', 'options', NOW + 1), mine), true)
  })

  test('an earlier claim does not, so of two that each read back their own, only one gives way', () => {
    assert.equal(outranks(claimRefresh('other', 'options', NOW - 1), mine), false)
    assert.equal(outranks(withProgress(claimRefresh('other', 'options', NOW - 1), 1, 3, NOW + 5), mine), false, 'however recently it was written')
  })

  test('two made in the same millisecond are ranked by their ids, the same way from either side', () => {
    const a = claimRefresh('aaa', 'page', NOW)
    const b = claimRefresh('bbb', 'page', NOW)
    assert.notEqual(outranks(a, b), outranks(b, a))
  })

  test('its own claim, rewritten, or a released one, takes nothing over', () => {
    assert.equal(outranks(withProgress(mine, 1, 3, NOW + 5), mine), false)
    assert.equal(outranks(released(claimRefresh('other', 'page', NOW + 9), 'dropped', NOW + 10), mine), false)
  })

  test('a newer claim of the same page run takes an older one over', () => {
    assert.equal(outranks(claimRefresh('me', 'page', NOW + 3), mine), true)
  })
})

describe('the holder’s writes', () => {
  const claim = claimRefresh('me', 'page', NOW)

  test('progress says how far it got, and renews', () => {
    assert.deepEqual(withProgress(claim, 2, 5, NOW + 3000), { ...claim, done: 2, total: 5, at: NOW + 3000 })
  })

  test('a pause says until when and which kind, and renews', () => {
    assert.deepEqual(withPause(claim, NOW + 60_000, 'refused', NOW + 10), { ...claim, waitUntil: NOW + 60_000, waitReason: 'refused', at: NOW + 10 })
  })

  test('a pause that is over clears both', () => {
    const paused = withPause(claim, NOW + 60_000, 'pacing', NOW)
    assert.deepEqual(withPause(paused, 0, 'pacing', NOW + 60_000), { ...claim, at: NOW + 60_000 })
  })

  test('renewal moves only the time', () => {
    assert.deepEqual(renewed(withProgress(claim, 1, 3, NOW), NOW + 20_000), { ...claim, done: 1, total: 3, at: NOW + 20_000 })
  })

  test('a release says how it ended and when, and withdraws the claim', () => {
    const paused = withPause(withProgress(claim, 3, 3, NOW), NOW + 9000, 'pacing', NOW)
    assert.deepEqual(released(paused, 'written', NOW + 50), { ...claim, done: 3, total: 3, at: 0, outcome: 'written', endedAt: NOW + 50 })
  })
})

describe('cancels', () => {
  const claim = claimRefresh('them', 'page', NOW)

  test('a request naming this claim cancels it', () => {
    assert.equal(cancels({ id: claim.id, at: NOW + 5 }, claim), true)
  })

  test('a request left over from an earlier claim of the same page run does not', () => {
    assert.equal(cancels({ id: claimRefresh('them', 'page', NOW - 9000).id, at: NOW - 100 }, claim), false)
  })

  test('no request cancels nothing', () => {
    assert.equal(cancels(null, claim), false)
  })
})

describe('followState', () => {
  const SINCE = NOW - 1000
  const theirs = claimRefresh('them', 'page', NOW)

  test('nothing stored: free to refresh', () => {
    assert.deepEqual(followState(null, 'me', SINCE, NOW), { kind: 'free' })
  })

  test('another page run’s live claim is followed, with its progress', () => {
    const going = withProgress(theirs, 1, 4, NOW + 2000)
    assert.deepEqual(followState(going, 'me', SINCE, NOW + 3000), { kind: 'following', claim: going })
  })

  test('a claim that lapsed is free', () => {
    assert.deepEqual(followState(theirs, 'me', SINCE, NOW + REFRESH_CLAIM_TTL_MS), { kind: 'free' })
  })

  test('this page run’s own claim is nothing to follow', () => {
    assert.deepEqual(followState(claimRefresh('me', 'page', NOW), 'me', SINCE, NOW + 1), { kind: 'free' })
  })

  test('written since the follower began: landed, at the time it ended', () => {
    assert.deepEqual(followState(released(theirs, 'written', NOW + 40), 'me', SINCE, NOW + 50), { kind: 'landed', endedAt: NOW + 40 })
  })

  test('ended otherwise: ended, with how', () => {
    for (const outcome of ['blocked', 'refused', 'failed', 'cancelled'])
      assert.deepEqual(followState(released(theirs, outcome, NOW + 40), 'me', SINCE, NOW + 50), { kind: 'ended', outcome }, outcome)
  })

  test('dropped by a page that moved on: free, for the follower to take over', () => {
    assert.deepEqual(followState(released(theirs, 'dropped', NOW + 40), 'me', SINCE, NOW + 50), { kind: 'free' })
  })

  test('a refresh that ended before the follower began is not news to it', () => {
    for (const outcome of ['written', 'cancelled'])
      assert.deepEqual(followState(released(theirs, outcome, SINCE - 1), 'me', SINCE, NOW + 50), { kind: 'free' }, outcome)
  })

  test('one that ended the very moment the follower began counts', () => {
    assert.deepEqual(followState(released(theirs, 'written', SINCE), 'me', SINCE, NOW), { kind: 'landed', endedAt: SINCE })
  })

  test('the follower’s own release is no news either', () => {
    assert.deepEqual(followState(released(claimRefresh('me', 'page', NOW), 'written', NOW + 40), 'me', SINCE, NOW + 50), { kind: 'free' })
  })
})

describe('listStored', () => {
  const claim = claimRefresh('them', 'page', NOW)

  test('a copy read since the refresh began is what it stored, whatever its claim still says', () => {
    assert.equal(listStored(claim, NOW + 5000), true)
    assert.equal(listStored(claim, NOW), true)
  })

  test('a copy read before it is not', () => {
    assert.equal(listStored(claim, NOW - 1), false)
  })
})

describe('lapseIn', () => {
  test('how long a live claim has before it lapses unrenewed', () => {
    assert.equal(lapseIn(claimRefresh('them', 'page', NOW), NOW + 1000), REFRESH_CLAIM_TTL_MS - 1000)
  })

  test('a lapsed or released claim has nothing left', () => {
    assert.equal(lapseIn(claimRefresh('them', 'page', NOW), NOW + REFRESH_CLAIM_TTL_MS + 5), 0)
    assert.equal(lapseIn(released(claimRefresh('them', 'page', NOW), 'written', NOW), NOW), 0)
  })
})

describe('updatingNote', () => {
  test('before the page count is known', () => {
    assert.equal(updatingNote(claimRefresh('me', 'page', NOW), NOW), 'Updating…')
  })

  test('pages loaded', () => {
    assert.equal(updatingNote(withProgress(claimRefresh('me', 'page', NOW), 2, 5, NOW), NOW), 'Updating… Loaded 2 of 5 pages')
  })

  test('the same whichever page runs it', () => {
    assert.equal(updatingNote(withProgress(claimRefresh('them', 'options', NOW), 2, 5, NOW), NOW), 'Updating… Loaded 2 of 5 pages')
    assert.equal(updatingNote(withProgress(claimRefresh('them', 'page', NOW), 2, 5, NOW), NOW), 'Updating… Loaded 2 of 5 pages')
  })

  test('a pause takes the page count’s place, counting down', () => {
    const paused = withPause(withProgress(claimRefresh('me', 'page', NOW), 2, 5, NOW), NOW + 65_000, 'refused', NOW)
    assert.equal(updatingNote(paused, NOW), 'Updating… AO3 asked us to slow down — trying again in 1:05')
    assert.equal(updatingNote(paused, NOW + 60_000), 'Updating… AO3 asked us to slow down — trying again in 5s')
  })

  test('a pause that has run out goes back to the page count', () => {
    const paused = withPause(withProgress(claimRefresh('them', 'page', NOW), 2, 5, NOW), NOW + 5000, 'pacing', NOW)
    assert.equal(updatingNote(paused, NOW + 5000), 'Updating… Loaded 2 of 5 pages')
  })

  test('one page is a page', () => {
    assert.equal(updatingNote(withProgress(claimRefresh('me', 'page', NOW), 1, 1, NOW), NOW), 'Updating… Loaded 1 of 1 page')
  })
})

describe('loadingLine', () => {
  test('the page the refresh is on, as a job says it', () => {
    assert.equal(loadingLine(2, 5), 'Loading page 2 of 5…')
  })

  test('before the page count is known, the list being fetched', () => {
    assert.equal(loadingLine(0, 0), 'Fetching the list…')
  })
})
