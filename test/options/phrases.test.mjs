import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { sentence, withReason } from '../../src/options_ui/model/phrases.ts'

describe('phrases', () => {
  test('a clause starts a sentence with a capital, and is otherwise left as it is', () => {
    assert.equal(sentence('off for now: one job at a time, and AO3 is caching'), 'Off for now: one job at a time, and AO3 is caching')
    assert.equal(sentence(''), '')
  })

  test('a control\'s tooltip says what it does, then why it is off, after a dash', () => {
    assert.equal(withReason('Cache this list\'s works', 'off while this list is caching'), 'Cache this list\'s works — off while this list is caching')
    assert.equal(withReason('Cache this list\'s works', null), 'Cache this list\'s works')
    assert.equal(withReason('Cache this list\'s works', undefined), 'Cache this list\'s works')
  })
})
