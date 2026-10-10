import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import { pruneToSynced, SYNC_SCHEMA_VERSION, syncedKeys } from '../../src/common/syncCodec.ts'
import { decideFirstPull, decidePull, decidePush, isRemoteNewer, questionGone, refuseUnbacked, uploadId, weighCopy } from '../../src/common/syncDecide.ts'
import { rulesFixture, textReplacementsFixture } from './harness.mjs'

const V = SYNC_SCHEMA_VERSION

/** Build a manifest with sensible defaults, and the copy's ID `i` where one is given. */
function m({ g = 1, h = 'H', w = 'wA', v = V, n = 1, i } = {}) {
  return { v, n, g, h, w, ...(i ? { i } : {}) }
}

describe('isRemoteNewer', () => {
  test('higher generation is newer', () => {
    assert.equal(isRemoteNewer(m({ g: 2 }), { g: 1, h: 'x', w: 'wA' }), true)
    assert.equal(isRemoteNewer(m({ g: 1 }), { g: 2, h: 'x', w: 'wA' }), false)
  })

  test('same generation, different token resolves by token (deterministic)', () => {
    assert.equal(isRemoteNewer(m({ g: 1, w: 'wB' }), { g: 1, h: 'x', w: 'wA' }), true)
    assert.equal(isRemoteNewer(m({ g: 1, w: 'wA' }), { g: 1, h: 'x', w: 'wB' }), false)
  })

  test('same generation and token is not newer', () => {
    assert.equal(isRemoteNewer(m({ g: 1, w: 'wA' }), { g: 1, h: 'x', w: 'wA' }), false)
  })
})

describe('decidePush', () => {
  const local = { g: 5, h: 'Hlocal', w: 'wA' }

  test('seeds when sync is empty and we have local state', () => {
    assert.equal(decidePush({ g: 0, h: '', w: '' }, null, 'Hnew'), 'push')
  })

  test('noop when nothing changed and we are in sync', () => {
    assert.equal(decidePush(local, m({ g: 5, w: 'wA' }), 'Hlocal'), 'noop')
  })

  test('pushes our local changes when the cloud has not advanced', () => {
    assert.equal(decidePush(local, m({ g: 5, w: 'wA' }), 'Hchanged'), 'push')
  })

  test('pulls instead of clobbering when the cloud advanced under us (offline divergence)', () => {
    // We edited offline (Hchanged) but another device already pushed g=6.
    assert.equal(decidePush(local, m({ g: 6, w: 'wB' }), 'Hchanged'), 'pull')
  })

  test('pulls when no local changes but cloud is newer', () => {
    assert.equal(decidePush(local, m({ g: 6, w: 'wB' }), 'Hlocal'), 'pull')
  })

  test('blocked by a newer sync version (this browser is behind)', () => {
    assert.equal(decidePush(local, m({ g: 9, v: V + 1 }), 'Hchanged'), 'blocked')
    assert.equal(decidePush(local, m({ g: 9, v: V + 1 }), 'Hlocal'), 'blocked', 'even with nothing to push')
  })

  test('an older build\'s copy is replaced by a browser that has synced before', () => {
    // Whatever its generation, and whether or not anything changed here.
    assert.equal(decidePush(local, m({ g: 50, v: V - 1 }), 'Hlocal'), 'push')
    assert.equal(decidePush(local, m({ g: 2, v: V - 1 }), 'Hchanged'), 'push')
  })

  test('a browser that has never synced waits instead of replacing an older build\'s copy', () => {
    assert.equal(decidePush({ g: 0, h: '', w: '' }, m({ g: 5, v: V - 1 }), 'Hnew'), 'wait')
  })

  test('the version compared against is the one passed in', () => {
    assert.equal(decidePush(local, m({ g: 5, w: 'wA', v: 3 }), 'Hchanged', 3), 'push')
    assert.equal(decidePush(local, m({ g: 5, w: 'wA', v: 3 }), 'Hchanged', 2), 'blocked')
  })

  test('lost same-gen race resolves to pull', () => {
    // We think we are at g=6/wA, but the cloud shows g=6/wB (a competitor won).
    assert.equal(decidePush({ g: 6, h: 'Hmine', w: 'wA' }, m({ g: 6, w: 'wB' }), 'Hmine'), 'pull')
  })
})

describe('decidePull', () => {
  const local = { g: 5, h: 'H', w: 'wA' }

  test('noop when sync is empty', () => {
    assert.equal(decidePull(local, null), 'noop')
  })

  test('noop on our own echo (same gen + token)', () => {
    assert.equal(decidePull(local, m({ g: 5, w: 'wA' })), 'noop')
  })

  test('noop on an older/equal generation', () => {
    assert.equal(decidePull(local, m({ g: 4, w: 'wB' })), 'noop')
  })

  test('pulls a newer generation', () => {
    assert.equal(decidePull(local, m({ g: 6, w: 'wB' })), 'pull')
  })

  test('pulls a same-gen overwrite that won the tie-break', () => {
    assert.equal(decidePull(local, m({ g: 5, w: 'wB' })), 'pull')
  })

  test('blocked by a newer sync version', () => {
    assert.equal(decidePull(local, m({ g: 9, v: V + 1 })), 'blocked')
  })

  test('never adopts an older build\'s copy, however new', () => {
    assert.equal(decidePull(local, m({ g: 9, v: V - 1 })), 'wait')
    assert.equal(decidePull({ g: 0, h: '', w: '' }, m({ g: 1, v: V - 1 })), 'wait')
  })
})

/**
 * The first pull a browser makes with nothing agreed, as sync is turned on:
 * whether the synced copy is adopted, this browser's settings are sent over
 * it, the two already agree, or the reader is asked which to keep.
 */
describe('decideFirstPull', () => {
  /** A browser's options: the defaults, with `update` over them. */
  const withOptions = (update = {}) => ({ ...structuredClone(OPTION_DEFAULTS), ...structuredClone(update) })
  /** The synced copy a browser holding `update` writes. */
  const copyOf = (update = {}) => pruneToSynced(withOptions(update), OPTION_DEFAULTS)
  const KEYS = syncedKeys(OPTION_DEFAULTS)
  const decide = (here, copy, keys = KEYS) => decideFirstPull(withOptions(here), copy, OPTION_DEFAULTS, keys)

  const MINE = { rules: rulesFixture(40), wordsPerMinute: 350 }
  const THEIRS = { rules: rulesFixture(38), textReplacements: textReplacementsFixture(3) }

  test('a copy holding nothing beyond defaults: this browser\'s settings are sent', () => {
    assert.deepEqual(decide(MINE, copyOf()), { kind: 'send' })
  })

  test('a new profile adopts the copy', () => {
    assert.deepEqual(decide({}, copyOf(THEIRS)), { kind: 'adopt' })
  })

  test('both holding nothing beyond defaults agree, with nothing to send', () => {
    assert.deepEqual(decide({}, copyOf()), { kind: 'agree' })
  })

  test('a matching copy agrees', () => {
    assert.deepEqual(decide(MINE, copyOf(MINE)), { kind: 'agree' })
  })

  test('a copy that differs from this browser\'s own settings asks', () => {
    assert.deepEqual(decide(MINE, copyOf(THEIRS)), { kind: 'ask', loss: null })
    assert.deepEqual(decide(MINE, copyOf({ ...MINE, wordsPerMinute: 351 })), { kind: 'ask', loss: null }, 'however small the difference')
  })

  test('a copy the deletion guard would hold asks, saying what using it would remove', () => {
    const { kind, loss } = decide(MINE, copyOf({ rules: rulesFixture(1) }))
    assert.equal(kind, 'ask')
    assert.deepEqual(loss.rules, { removed: 39, of: 40 })
  })

  test('device-local settings are not this browser\'s settings to send or lose', () => {
    const local = { theme: { chosen: 'inherit', current: 'dark' }, user: { userId: 'reader' }, verbose: true, savedLists: { v: 1, lists: { a: { id: 'a', kind: 'tag-works', url: '/tags/Tea', title: 'Tea' } } } }
    assert.deepEqual(decide(local, copyOf(THEIRS)), { kind: 'adopt' })
    assert.deepEqual(decide({ ...local, ...THEIRS }, copyOf(THEIRS)), { kind: 'agree' })
  })

  describe('a writer that knew fewer options', () => {
    const narrower = KEYS.filter(key => key !== 'wordsPerMinute')

    test('what it never knew of is no difference', () => {
      assert.deepEqual(decide(MINE, copyOf({ rules: MINE.rules }), narrower), { kind: 'agree' })
      assert.deepEqual(decide(MINE, copyOf({ rules: MINE.rules }), KEYS), { kind: 'ask', loss: null }, 'a writer that knew it left it at its default')
    })

    test('a copy holding nothing beyond defaults still takes this browser\'s settings', () => {
      assert.deepEqual(decide({ wordsPerMinute: 350 }, copyOf(), narrower), { kind: 'send' })
    })
  })
})

/**
 * Each synced copy carries an ID, the same through every upload over it, and
 * each browser keeps the ID of the copy it last agreed with. A copy under
 * another ID is one another browser started, which replaces every setting
 * here if taken as an update.
 */
describe('the synced copy\'s ID', () => {
  /** Agreed with a copy under `i`: this browser's own, unless said otherwise. */
  const agreed = (i = 'mine') => ({ g: 5, h: 'H', w: 'wA', ...(i ? { i } : {}) })
  /** Nothing agreed, as sync turns on. */
  const NOTHING = { g: 0, h: '', w: '' }

  describe('weighCopy', () => {
    test('nothing agreed, as sync turns on: weighed as turning sync on weighs a copy, whatever the IDs', () => {
      assert.deepEqual(weighCopy(NOTHING, m({ i: 'theirs' })), { weigh: 'first', id: 'theirs' })
      assert.deepEqual(weighCopy(NOTHING, m()), { weigh: 'first' })
      assert.deepEqual(weighCopy({ ...NOTHING, i: 'theirs' }, m({ i: 'theirs' })), { weigh: 'first', id: 'theirs' }, 'an ID on no agreement agrees on nothing')
    })

    test('nothing agreed, with the ID turning sync off gave this browser: a copy with no ID leaves it in place', () => {
      assert.deepEqual(weighCopy({ ...NOTHING, i: 'mine' }, m()), { weigh: 'first', id: 'mine' })
    })

    test('the agreed ID: an ordinary update', () => {
      assert.deepEqual(weighCopy(agreed(), m({ g: 6, i: 'mine' })), { weigh: 'update', id: 'mine' })
    })

    test('another ID: a copy another browser started, weighed as turning sync on weighs one, taking its ID', () => {
      assert.deepEqual(weighCopy(agreed(), m({ g: 6, i: 'theirs' })), { weigh: 'other', id: 'theirs' })
    })

    test('no agreed ID while synced, as on a browser upgraded from a build before it: the first copy with one is an update, and its ID is taken', () => {
      assert.deepEqual(weighCopy(agreed(null), m({ g: 6, i: 'theirs' })), { weigh: 'update', id: 'theirs' })
    })

    test('a copy with no ID, as a build from before it writes: an update, keeping the agreed ID', () => {
      assert.deepEqual(weighCopy(agreed(), m({ g: 6 })), { weigh: 'update', id: 'mine' })
      assert.deepEqual(weighCopy(agreed(null), m({ g: 6 })), { weigh: 'update' }, 'with no ID on either side, none')
    })
  })

  describe('uploadId', () => {
    const fresh = () => 'new'

    test('the agreed ID, over whatever the cloud holds', () => {
      assert.equal(uploadId(agreed(), m({ i: 'mine' }), false, fresh), 'mine')
      assert.equal(uploadId(agreed(), m(), false, fresh), 'mine', 'over a copy with no ID, it goes back on')
      assert.equal(uploadId(agreed(), m({ i: 'theirs' }), false, fresh), 'mine', 'over another ID it never pulled, its own')
    })

    test('keeping this browser\'s settings, or sending them over a copy silently: under the copy\'s ID', () => {
      assert.equal(uploadId(agreed(), m({ i: 'theirs' }), true, fresh), 'theirs')
      assert.equal(uploadId(NOTHING, m({ i: 'theirs' }), true, fresh), 'theirs', 'as sync turns on')
      assert.equal(uploadId(agreed(), m(), true, fresh), 'mine', 'a copy with no ID takes the agreed one')
      assert.equal(uploadId(NOTHING, m(), true, fresh), undefined, 'with no ID on either side, none')
    })

    test('seeding an empty store: a new ID', () => {
      assert.equal(uploadId(NOTHING, null, false, fresh), 'new')
      assert.equal(uploadId(agreed(null), null, false, fresh), 'new')
      assert.equal(uploadId(agreed(), null, false, fresh), 'mine', 'a store emptied under an agreement keeps it')
    })

    test('with no ID of its own: none over a copy without one, and a new one over a copy whose ID it never agreed with', () => {
      assert.equal(uploadId(agreed(null), m(), false, fresh), undefined)
      assert.equal(uploadId(agreed(null), m({ i: 'theirs' }), false, fresh), 'new')
      assert.equal(uploadId(agreed(null), m({ g: 5, w: 'wB', i: 'theirs' }), false, fresh), 'new', 'another browser\'s copy at its generation')
    })

    test('with no ID of its own, over the very copy it agreed with, which a build from before the ID agreed with unrecorded: that copy\'s ID', () => {
      assert.equal(uploadId(agreed(null), m({ g: 5, w: 'wA', i: 'theirs' }), false, fresh), 'theirs')
    })

    test('over a copy at an older sync version, which is never adopted: as over an empty store', () => {
      assert.equal(uploadId(agreed(null), m({ v: V - 1 }), false, fresh, V), 'new')
      assert.equal(uploadId(agreed(), m({ v: V - 1 }), false, fresh, V), 'mine')
    })

    test('makes an ID only when it writes a new one', () => {
      let made = 0
      const counted = () => `new-${++made}`
      uploadId(agreed(), m({ i: 'theirs' }), false, counted)
      uploadId(agreed(), m({ i: 'theirs' }), true, counted)
      uploadId(agreed(null), m(), false, counted)
      assert.equal(made, 0)
      assert.equal(uploadId(NOTHING, null, false, counted), 'new-1')
    })
  })

  describe('questionGone', () => {
    /** The question a copy under another ID raised. */
    const ASKED = { reason: 'first-sync', otherCopy: true, g: 6, w: 'wB', at: 0, backedUp: true, backupFailed: false, loss: null }

    test('a question a copy under another ID raised goes once the cloud holds a copy under the agreed ID again', () => {
      assert.equal(questionGone(ASKED, agreed(), m({ g: 5, w: 'wA', i: 'mine' })), true)
    })

    test('it stands over the copy asked about, a third ID, a copy with no ID, or none', () => {
      assert.equal(questionGone(ASKED, agreed(), m({ g: 6, w: 'wB', i: 'theirs' })), false)
      assert.equal(questionGone(ASKED, agreed(), m({ g: 7, w: 'wC', i: 'third' })), false)
      assert.equal(questionGone(ASKED, agreed(), m({ g: 5, w: 'wA' })), false)
      assert.equal(questionGone(ASKED, agreed(), null), false)
      assert.equal(questionGone(ASKED, agreed(null), m({ g: 5, w: 'wA' })), false)
    })

    test('turning sync on\'s question, a held update and the version pauses aren\'t its to end', () => {
      const { otherCopy, ...turningOn } = ASKED
      assert.equal(questionGone(turningOn, agreed(), m({ g: 5, w: 'wA', i: 'mine' })), false)
      const held = { reason: 'held', g: 6, w: 'wB', at: 0, backedUp: true, backupFailed: false, loss: { rules: { removed: 9, of: 10 } } }
      assert.equal(questionGone(held, agreed(), m({ g: 5, w: 'wA', i: 'mine' })), false)
      assert.equal(questionGone({ reason: 'older-cloud', remoteVersion: V - 1 }, agreed(), m({ i: 'mine' })), false)
      assert.equal(questionGone(null, agreed(), m({ i: 'mine' })), false)
    })
  })
})

/**
 * Taking the synced settings backs this browser's up first. Where that
 * backup was due and couldn't be written, the first press is refused, and
 * the question records it, so it says this browser's settings aren't backed
 * up before a second press applies them anyway.
 */
describe('refuseUnbacked', () => {
  const HELD = { reason: 'held', g: 6, w: 'wB', at: 0, backedUp: true, backupFailed: false, loss: { rules: { removed: 9, of: 10 } } }
  const FIRST = { reason: 'first-sync', g: 6, w: 'wB', at: 0, backedUp: true, backupFailed: false, loss: null }
  const QUESTIONS = [HELD, FIRST, { ...FIRST, otherCopy: true }]

  test('backed up, or held already by the newest backup of its kind, it goes ahead', () => {
    for (const question of QUESTIONS)
      assert.equal(refuseUnbacked(question, true), null, question.reason)
  })

  test('not backed up where the question says this browser\'s settings are, it is refused, and the question records that they aren\'t', () => {
    for (const question of QUESTIONS)
      assert.deepEqual(refuseUnbacked(question, false), { ...question, backedUp: false, backupFailed: true }, question.reason)
  })

  test('a hold an older build recorded with daily backups off says nothing of a backup: refused the same way', () => {
    const { backupFailed, ...older } = { ...HELD, backedUp: false }
    assert.deepEqual(refuseUnbacked(older, false), { ...older, backupFailed: true })
  })

  test('where the question already says they aren\'t backed up, it goes ahead: the reader answered knowing it', () => {
    for (const question of QUESTIONS)
      assert.equal(refuseUnbacked({ ...question, backedUp: false, backupFailed: true }, false), null, question.reason)
  })
})
